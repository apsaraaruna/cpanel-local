#!/usr/bin/env node
/**
 * cPanel Local — a tiny, local-only control panel for cPanel accounts.
 * Zero dependencies. Requires Node.js 18+.
 *
 *   node server.js            -> http://127.0.0.1:8787/?t=<one-time-token>
 *
 * Security model
 *  - Binds to 127.0.0.1 only; Host header must be localhost (blocks DNS rebinding).
 *  - A random launch token is printed to the console; the browser exchanges it for an
 *    HttpOnly, SameSite=Strict session cookie. Every API call also needs a CSRF header.
 *  - Your cPanel API token lives in server memory only. It is never sent to the browser.
 *  - Optional saved profiles are encrypted (AES-256-GCM, key from scrypt + your passphrase).
 *  - TLS certificate verification is ON by default.
 */
'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Client: SSHClient } = require('ssh2');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT) || 8787;
const HOST = '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const VAULT_FILE = path.join(__dirname, 'vault.enc');
const KNOWN_HOSTS_FILE = path.join(__dirname, 'known_hosts.json');
const MAX_BODY = 60 * 1024 * 1024; // 60 MB (uploads arrive base64-encoded)
const SESSION_IDLE_MS = 60 * 60 * 1000; // auto-logout after 1h idle

// ---------------------------------------------------------------- state
const LAUNCH_TOKEN = crypto.randomBytes(24).toString('hex');
let launchTokenUsed = false;
const sessions = new Map(); // sid -> { csrf, conn, last }

function newSession() {
  const sid = crypto.randomBytes(32).toString('hex');
  const s = { csrf: crypto.randomBytes(32).toString('hex'), conn: null, ssh: null, last: Date.now() };
  sessions.set(sid, s);
  return [sid, s];
}

setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions) {
    if (now - s.last > SESSION_IDLE_MS) {
      if (s.ssh) try { s.ssh.client.end(); } catch {}
      sessions.delete(sid);
    }
  }
}, 60 * 1000).unref();

// ---------------------------------------------------------------- helpers
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    ...SEC_HEADERS,
    'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    ...headers,
  });
  res.end(isObj ? JSON.stringify(body) : body);
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((c) => {
    const i = c.indexOf('=');
    if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function safeEqual(a, b) {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

const NAME_RE = /^[A-Za-z0-9_]+$/;

// ---------------------------------------------------------------- cPanel client
function normalizeHost(input) {
  let h = String(input || '').trim();
  if (!h) throw new Error('Host is required');
  if (!/^https?:\/\//i.test(h)) h = 'https://' + h;
  const u = new URL(h);
  if (!u.port) u.port = u.protocol === 'https:' ? '2083' : '2082';
  if (u.protocol === 'http:' && !['127.0.0.1', 'localhost'].includes(u.hostname)) {
    throw new Error('Plain HTTP is only allowed for localhost testing. Use https.');
  }
  return `${u.protocol}//${u.host}`;
}

function cpRequest(conn, method, pathAndQuery, body, contentType) {
  return new Promise((resolve, reject) => {
    const url = new URL(conn.base + pathAndQuery);
    const lib = url.protocol === 'https:' ? https : http;
    const headers = {
      Authorization: `cpanel ${conn.user}:${conn.token}`,
      Accept: 'application/json',
    };
    if (body) {
      headers['Content-Type'] = contentType;
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = lib.request(url, {
      method,
      headers,
      timeout: 60000,
      rejectUnauthorized: !conn.insecure,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode === 401 || res.statusCode === 403) {
          return reject(new Error(`cPanel rejected the credentials (HTTP ${res.statusCode}). Check username / API token.`));
        }
        try { resolve(JSON.parse(text)); }
        catch { reject(new Error(`Unexpected response from cPanel (HTTP ${res.statusCode}): ${text.slice(0, 200)}`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('cPanel request timed out')));
    req.on('error', (e) => reject(new Error(e.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || e.code === 'SELF_SIGNED_CERT_IN_CHAIN' || e.code === 'ERR_TLS_CERT_ALTNAME_INVALID'
      ? `TLS certificate problem (${e.code}). Use the server hostname (e.g. server123.web-hosting.com) instead of your domain.`
      : e.message)));
    if (body) req.write(body);
    req.end();
  });
}

function toForm(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach((x) => sp.append(k, String(x)));
    else sp.append(k, String(v));
  }
  return sp.toString();
}

async function uapi(conn, mod, func, params) {
  if (!NAME_RE.test(mod) || !NAME_RE.test(func)) throw new Error('Invalid module/function name');
  const r = await cpRequest(conn, 'POST', `/execute/${mod}/${func}`, toForm(params), 'application/x-www-form-urlencoded');
  const ok = r.status === 1;
  return { ok, data: r.data, errors: r.errors || (ok ? [] : ['Unknown error']), messages: r.messages || [], metadata: r.metadata };
}

async function api2(conn, mod, func, params) {
  if (!NAME_RE.test(mod) || !NAME_RE.test(func)) throw new Error('Invalid module/function name');
  const q = toForm({
    cpanel_jsonapi_user: conn.user,
    cpanel_jsonapi_apiversion: 2,
    cpanel_jsonapi_module: mod,
    cpanel_jsonapi_func: func,
    ...params,
  });
  const r = await cpRequest(conn, 'POST', '/json-api/cpanel', q, 'application/x-www-form-urlencoded');
  const cr = r.cpanelresult || {};
  const data = cr.data;
  let errors = [];
  if (cr.error) errors.push(cr.error);
  if (Array.isArray(data)) data.forEach((d) => { if (d && d.result === 0 && d.reason) errors.push(d.reason); });
  if (cr.event && cr.event.result === 0 && !errors.length) errors.push('Operation failed');
  return { ok: errors.length === 0, data, errors };
}

function uploadFile(conn, dir, name, b64) {
  const boundary = '----cplocal' + crypto.randomBytes(12).toString('hex');
  const file = Buffer.from(b64, 'base64');
  const safeName = String(name).replace(/["\r\n\\/]/g, '_');
  const parts = [
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="dir"\r\n\r\n${dir}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="overwrite"\r\n\r\n1\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file-1"; filename="${safeName}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ];
  return cpRequest(conn, 'POST', '/execute/Fileman/upload_files', Buffer.concat(parts), `multipart/form-data; boundary=${boundary}`)
    .then((r) => ({ ok: r.status === 1, data: r.data, errors: r.errors || [] }));
}

// ---------------------------------------------------------------- encrypted vault
function vaultRead(pass) {
  if (!fs.existsSync(VAULT_FILE)) return {};
  const raw = JSON.parse(fs.readFileSync(VAULT_FILE, 'utf8'));
  const key = crypto.scryptSync(pass, Buffer.from(raw.salt, 'base64'), 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(raw.iv, 'base64'));
    d.setAuthTag(Buffer.from(raw.tag, 'base64'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(raw.data, 'base64')), d.final()]).toString('utf8'));
  } catch { throw new Error('Wrong passphrase (or vault file is corrupted)'); }
}

function vaultWrite(pass, obj) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(pass, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  const out = { v: 1, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
  fs.writeFileSync(VAULT_FILE, JSON.stringify(out), { mode: 0o600 });
}

function vaultNames() {
  if (!fs.existsSync(VAULT_FILE)) return null;
  return true; // names are encrypted too; we only reveal that a vault exists
}

// ---------------------------------------------------------------- SSH / SFTP
function fingerprintOf(keyBuf) {
  return crypto.createHash('sha256').update(keyBuf).digest('base64').replace(/=+$/, '');
}
function knownHostsRead() {
  if (!fs.existsSync(KNOWN_HOSTS_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(KNOWN_HOSTS_FILE, 'utf8')); } catch { return {}; }
}
function knownHostsWrite(obj) {
  fs.writeFileSync(KNOWN_HOSTS_FILE, JSON.stringify(obj, null, 2), { mode: 0o600 });
}

// TOFU host-key pinning, like OpenSSH's known_hosts: first connection records the
// fingerprint, later connections must match it or are refused (possible MITM).
function sshConnect(s, body) {
  return new Promise((resolve, reject) => {
    const host = String(body.host || '').trim();
    const port = Number(body.port) || 22;
    const username = String(body.username || '').trim();
    if (!host) return reject(new Error('Host is required'));
    if (!username) return reject(new Error('Username is required'));

    const cfg = { host, port, username, readyTimeout: 20000, keepaliveInterval: 10000 };
    if (body.authMethod === 'password') {
      if (!body.password) return reject(new Error('Password is required'));
      cfg.password = String(body.password);
    } else {
      let keyData = typeof body.keyText === 'string' && body.keyText.trim() ? body.keyText : null;
      if (!keyData) {
        const keyPath = String(body.keyPath || '').trim();
        if (!keyPath) return reject(new Error('A private key file path or pasted key is required'));
        try { keyData = fs.readFileSync(keyPath, 'utf8'); }
        catch { return reject(new Error(`Could not read key file at ${keyPath}`)); }
      }
      cfg.privateKey = keyData;
      if (body.passphrase) cfg.passphrase = String(body.passphrase);
    }

    const hostId = `${host}:${port}`;
    let hostKeyProblem = null;
    cfg.hostVerifier = (keyBuf) => {
      const fp = fingerprintOf(keyBuf);
      const known = knownHostsRead()[hostId];
      if (known) {
        if (known === fp) return true;
        hostKeyProblem = { changed: true, fingerprint: fp };
        return false;
      }
      if (body.trustHostKey && body.trustedFingerprint === fp) {
        const hosts = knownHostsRead();
        hosts[hostId] = fp;
        knownHostsWrite(hosts);
        return true;
      }
      hostKeyProblem = { changed: false, fingerprint: fp };
      return false;
    };

    const client = new SSHClient();
    const fail = (e) => { try { client.end(); } catch {} reject(e); };

    client.on('ready', () => {
      client.sftp((err, sftp) => {
        if (err) return fail(new Error('Connected, but could not start SFTP: ' + err.message));
        if (s.ssh && s.ssh.client) try { s.ssh.client.end(); } catch {}
        s.ssh = { client, sftp, host, port, username };
        client.once('close', () => { if (s.ssh && s.ssh.client === client) s.ssh = null; });
        resolve({ host, port, username });
      });
    });
    client.on('error', (e) => {
      if (hostKeyProblem) {
        const msg = hostKeyProblem.changed
          ? `WARNING: the host key for ${hostId} has CHANGED (new fingerprint ${hostKeyProblem.fingerprint}). This can mean a man-in-the-middle attack -- refusing to connect. If you're sure this is expected (e.g. the server was reinstalled), remove the "${hostId}" entry from known_hosts.json and try again.`
          : `Unknown host key for ${hostId}.`;
        const err = new Error(msg);
        err.hostKeyFingerprint = hostKeyProblem.fingerprint;
        err.hostKeyChanged = hostKeyProblem.changed;
        return fail(err);
      }
      fail(new Error(e.message));
    });
    client.connect(cfg);
  });
}

function sshRequireConn(s) {
  if (!s.ssh) throw new Error('Not connected to a server (SSH)');
  return s.ssh;
}

function sftpList(sftp, dir) {
  return new Promise((resolve, reject) => {
    sftp.readdir(dir, (err, list) => (err ? reject(new Error(err.message)) : resolve(list)));
  });
}
function sftpReadFile(sftp, file) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const stream = sftp.createReadStream(file, { encoding: null });
    stream.on('data', (c) => chunks.push(c));
    stream.on('error', (e) => reject(new Error(e.message)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}
function sftpWriteFile(sftp, file, buf) {
  return new Promise((resolve, reject) => {
    const stream = sftp.createWriteStream(file);
    stream.on('error', (e) => reject(new Error(e.message)));
    stream.on('close', () => resolve());
    stream.end(buf);
  });
}
function sftpOp(sftp, method, ...args) {
  return new Promise((resolve, reject) => {
    sftp[method](...args, (err, result) => (err ? reject(new Error(err.message)) : resolve(result)));
  });
}
const joinRemote = (a, b) => (a.endsWith('/') ? a : a + '/') + b;

// ---------------------------------------------------------------- connect
async function connect(s, { host, user, token, insecure }) {
  if (!user || !token) throw new Error('Username and API token are required');
  const conn = { base: normalizeHost(host), user: String(user).trim(), token: String(token).trim(), insecure: !!insecure };
  const r = await uapi(conn, 'DomainInfo', 'list_domains', {});
  if (!r.ok) throw new Error(r.errors.join('; ') || 'Could not connect');
  s.conn = conn;
  return { host: conn.base, user: conn.user, mainDomain: r.data && r.data.main_domain, insecure: conn.insecure };
}

// ---------------------------------------------------------------- routes
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

async function handleApi(req, res, s, route) {
  const body = await readJson(req);

  switch (route) {
    case 'status':
      return send(res, 200, {
        connected: !!s.conn,
        conn: s.conn && { host: s.conn.base, user: s.conn.user, insecure: s.conn.insecure },
        vault: !!vaultNames(),
        ssh: s.ssh && { host: s.ssh.host, port: s.ssh.port, username: s.ssh.username },
      });

    case 'connect':
      return send(res, 200, { ok: true, info: await connect(s, body) });

    case 'logout':
      s.conn = null;
      return send(res, 200, { ok: true });

    case 'ssh/connect':
      return send(res, 200, { ok: true, info: await sshConnect(s, body) });

    case 'ssh/disconnect':
      if (s.ssh) try { s.ssh.client.end(); } catch {}
      s.ssh = null;
      return send(res, 200, { ok: true });

    case 'vault/save': {
      if (!s.conn) throw new Error('Connect first');
      if (!body.passphrase || body.passphrase.length < 8) throw new Error('Passphrase must be at least 8 characters');
      const name = String(body.name || s.conn.user).slice(0, 60);
      const v = vaultRead(body.passphrase);
      v[name] = { host: s.conn.base, user: s.conn.user, token: s.conn.token, insecure: s.conn.insecure };
      vaultWrite(body.passphrase, v);
      return send(res, 200, { ok: true });
    }
    case 'vault/list': {
      const v = vaultRead(body.passphrase || '');
      return send(res, 200, { ok: true, profiles: Object.keys(v).map((n) => ({ name: n, host: v[n].host, user: v[n].user })) });
    }
    case 'vault/load': {
      const v = vaultRead(body.passphrase || '');
      const p = v[body.name];
      if (!p) throw new Error('Profile not found');
      return send(res, 200, { ok: true, info: await connect(s, p) });
    }
    case 'vault/delete': {
      const v = vaultRead(body.passphrase || '');
      delete v[body.name];
      vaultWrite(body.passphrase, v);
      return send(res, 200, { ok: true });
    }
  }

  if (route.startsWith('sftp/')) {
    const ssh = sshRequireConn(s);
    switch (route) {
      case 'sftp/list':
        return send(res, 200, { ok: true, data: await sftpList(ssh.sftp, body.dir || '.') });
      case 'sftp/realpath':
        return send(res, 200, { ok: true, data: await sftpOp(ssh.sftp, 'realpath', body.path || '.') });
      case 'sftp/read': {
        const buf = await sftpReadFile(ssh.sftp, body.path);
        return send(res, 200, { ok: true, data: { content: buf.toString('utf8') } });
      }
      case 'sftp/write':
        await sftpWriteFile(ssh.sftp, body.path, Buffer.from(body.content ?? '', 'utf8'));
        return send(res, 200, { ok: true });
      case 'sftp/mkdir':
        await sftpOp(ssh.sftp, 'mkdir', body.path);
        return send(res, 200, { ok: true });
      case 'sftp/rmdir':
        await sftpOp(ssh.sftp, 'rmdir', body.path);
        return send(res, 200, { ok: true });
      case 'sftp/unlink':
        await sftpOp(ssh.sftp, 'unlink', body.path);
        return send(res, 200, { ok: true });
      case 'sftp/rename':
        await sftpOp(ssh.sftp, 'rename', body.from, body.to);
        return send(res, 200, { ok: true });
      case 'sftp/chmod':
        await sftpOp(ssh.sftp, 'chmod', body.path, Number(body.mode));
        return send(res, 200, { ok: true });
      case 'sftp/upload':
        if (!body.dir || !body.name || typeof body.b64 !== 'string') throw new Error('dir, name and file are required');
        await sftpWriteFile(ssh.sftp, joinRemote(body.dir, body.name), Buffer.from(body.b64, 'base64'));
        return send(res, 200, { ok: true });
    }
    return send(res, 404, { ok: false, errors: ['Unknown endpoint'] });
  }

  if (!s.conn) return send(res, 401, { ok: false, errors: ['Not connected'] });

  switch (route) {
    case 'uapi':
      return send(res, 200, await uapi(s.conn, body.module, body.func, body.params));
    case 'api2':
      return send(res, 200, await api2(s.conn, body.module, body.func, body.params));
    case 'upload':
      if (!body.dir || !body.name || typeof body.b64 !== 'string') throw new Error('dir, name and file are required');
      return send(res, 200, await uploadFile(s.conn, body.dir, body.name, body.b64));
  }
  return send(res, 404, { ok: false, errors: ['Unknown endpoint'] });
}

const server = http.createServer(async (req, res) => {
  try {
    // DNS-rebinding protection: only accept localhost Host headers.
    const hostHdr = (req.headers.host || '').toLowerCase();
    if (hostHdr !== `127.0.0.1:${PORT}` && hostHdr !== `localhost:${PORT}`) return send(res, 421, 'Invalid Host');

    const url = new URL(req.url, `http://${hostHdr}`);
    const cookies = parseCookies(req);
    let s = cookies.sid && sessions.get(cookies.sid);

    // Launch-token exchange -> session cookie
    if (url.pathname === '/' && url.searchParams.has('t')) {
      if (launchTokenUsed || !safeEqual(url.searchParams.get('t'), LAUNCH_TOKEN)) {
        return send(res, 403, 'This launch link was already used or is invalid. Restart the server to get a new one.');
      }
      launchTokenUsed = true;
      const [sid] = newSession();
      return send(res, 302, '', {
        Location: '/',
        'Set-Cookie': `sid=${sid}; HttpOnly; SameSite=Strict; Path=/`,
      });
    }

    if (!s) return send(res, 401, 'Not authorized. Open the launch link printed in the terminal.');
    s.last = Date.now();

    if (url.pathname.startsWith('/api/')) {
      if (req.method !== 'POST') return send(res, 405, { ok: false, errors: ['POST only'] });
      if (!safeEqual(req.headers['x-csrf-token'] || '', s.csrf)) return send(res, 403, { ok: false, errors: ['CSRF check failed'] });
      if (!(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, { ok: false, errors: ['JSON only'] });
      try {
        return await handleApi(req, res, s, url.pathname.slice(5));
      } catch (e) {
        const extra = {};
        if (e.hostKeyFingerprint) extra.hostKeyFingerprint = e.hostKeyFingerprint;
        if (e.hostKeyChanged) extra.hostKeyChanged = true;
        return send(res, 200, { ok: false, errors: [e.message], ...extra });
      }
    }

    if (req.method !== 'GET') return send(res, 405, 'Method not allowed');

    // Static files. index.html gets the CSRF token injected.
    let rel = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file)) return send(res, 404, 'Not found');
    let content = fs.readFileSync(file);
    if (rel === '/index.html') content = Buffer.from(content.toString('utf8').replace('__CSRF__', s.csrf));
    return send(res, 200, content, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  } catch (e) {
    console.error(e);
    send(res, 500, 'Internal error');
  }
});

// ---------------------------------------------------------------- WebSocket terminal
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  try {
    const hostHdr = (req.headers.host || '').toLowerCase();
    if (hostHdr !== `127.0.0.1:${PORT}` && hostHdr !== `localhost:${PORT}`) return socket.destroy();

    const origin = (req.headers.origin || '').toLowerCase();
    const allowedOrigins = [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`];
    if (origin && !allowedOrigins.includes(origin)) return socket.destroy();

    const url = new URL(req.url, `http://${hostHdr}`);
    if (url.pathname !== '/ws/terminal') return socket.destroy();

    const cookies = parseCookies(req);
    const s = cookies.sid && sessions.get(cookies.sid);
    if (!s) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
    if (!s.ssh) { socket.write('HTTP/1.1 409 Conflict\r\n\r\n'); return socket.destroy(); }
    s.last = Date.now();

    const cols = Math.max(2, Math.min(500, Number(url.searchParams.get('cols')) || 80));
    const rows = Math.max(2, Math.min(200, Number(url.searchParams.get('rows')) || 24));
    const client = s.ssh.client;

    wss.handleUpgrade(req, socket, head, (ws) => {
      client.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
        if (err) {
          try { ws.send(`Failed to start shell: ${err.message}\r\n`); } catch {}
          return ws.close();
        }
        stream.on('data', (chunk) => { if (ws.readyState === WebSocket.OPEN) ws.send(chunk); });
        stream.stderr.on('data', (chunk) => { if (ws.readyState === WebSocket.OPEN) ws.send(chunk); });
        stream.on('close', () => { try { ws.close(); } catch {} });
        ws.on('message', (data, isBinary) => {
          if (isBinary) return stream.write(data);
          try {
            const msg = JSON.parse(data.toString('utf8'));
            if (msg.type === 'resize') stream.setWindow(msg.rows, msg.cols);
          } catch {}
        });
        ws.on('close', () => { try { stream.end(); } catch {} });
        ws.on('error', () => { try { stream.end(); } catch {} });
      });
    });
  } catch {
    try { socket.destroy(); } catch {}
  }
});

server.listen(PORT, HOST, () => {
  console.log('\n  cPanel Local is running (local only).');
  console.log(`  Open this link (works once):\n\n    http://127.0.0.1:${PORT}/?t=${LAUNCH_TOKEN}\n`);
  console.log('  Press Ctrl+C to stop. Your API token is kept in memory only.\n');
});
