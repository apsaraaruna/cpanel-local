'use strict';
/* cPanel Local — frontend. No innerHTML with server data: everything goes through textContent. */

const CSRF = document.querySelector('meta[name="csrf"]').content;
const $ = (s) => document.querySelector(s);
const state = { home: '', cwd: '', user: '', domains: [], prefix: '', ssh: null };

// ------------------------------------------------------------ appearance / theme
const THEME_KEY = 'cpanelLocal.theme';
const THEMES = ['system', 'light', 'dark', 'midnight'];
const darkMedia = window.matchMedia('(prefers-color-scheme: dark)');

function getThemePref() {
  const saved = localStorage.getItem(THEME_KEY);
  return THEMES.includes(saved) ? saved : 'system';
}
function resolveTheme(pref) {
  return pref === 'system' ? (darkMedia.matches ? 'dark' : 'light') : pref;
}
const THEME_META = {
  system: { icon: '\u{1F5A5}', label: 'Auto' },
  light: { icon: '☀', label: 'Light' },
  dark: { icon: '\u{1F319}', label: 'Dark' },
  midnight: { icon: '✦', label: 'Midnight' },
};
function applyTheme(pref) {
  if (!THEMES.includes(pref)) pref = 'system';
  localStorage.setItem(THEME_KEY, pref);
  document.documentElement.dataset.theme = resolveTheme(pref);
  document.querySelectorAll('.theme-opt').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.themeOpt === pref));
  });
  const meta = THEME_META[pref];
  document.querySelectorAll('[data-theme-icon]').forEach((el) => { el.textContent = meta.icon; });
  document.querySelectorAll('[data-theme-label]').forEach((el) => { el.textContent = meta.label; });
}
applyTheme(getThemePref());
darkMedia.addEventListener('change', () => { if (getThemePref() === 'system') applyTheme('system'); });
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.theme-opt');
  if (btn) {
    applyTheme(btn.dataset.themeOpt);
    const d = btn.closest('details.theme-dropdown');
    if (d) d.open = false;
    return;
  }
  document.querySelectorAll('details.theme-dropdown[open]').forEach((d) => {
    if (!d.contains(e.target)) d.open = false;
  });
});

// ------------------------------------------------------------ utils
async function post(route, body = {}) {
  const r = await fetch('/api/' + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({ ok: false, errors: ['Bad response from local server'] }));
  if (r.status === 401 && route !== 'status') { showConnect(); }
  return j;
}
const uapi = (module, func, params = {}) => post('uapi', { module, func, params });
const api2 = (module, func, params = {}) => post('api2', { module, func, params });

// Runs a call, toasts errors, returns data or throws.
async function call(promise, okMsg) {
  const r = await promise;
  if (!r.ok) { toast((r.errors || ['Failed']).join('\n'), true); throw new Error('call failed'); }
  if (okMsg) toast(okMsg);
  return r.data;
}

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else e[k] = v;
  }
  for (const k of kids.flat()) if (k != null) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
}
const btn = (label, fn, cls = '') => el('button', { class: cls, type: 'button', onclick: fn }, label);
const actions = (...b) => el('td', { class: 'actions' }, ...b);
function emptyRow(tbody, cols, text = 'Nothing here') {
  tbody.replaceChildren(el('tr', {}, el('td', { colSpan: cols, class: 'muted' }, text)));
}

let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), err ? 6000 : 2500);
}
const formData = (f) => Object.fromEntries(new FormData(f).entries());
const joinPath = (a, b) => (a.endsWith('/') ? a : a + '/') + b;
const silent = (fn) => (...a) => fn(...a).catch(() => {});

// ------------------------------------------------------------ connect / views
function showConnect() {
  $('#appView').classList.add('hidden');
  $('#connectView').classList.remove('hidden');
  document.querySelectorAll('#connectTabs button').forEach((b) => b.classList.toggle('active', b.dataset.ctab === 'cpanel'));
  $('#connectPanel-cpanel').classList.remove('hidden');
  $('#connectPanel-ssh').classList.add('hidden');
}
function setCpanelTabsVisible(visible) {
  document.querySelectorAll('#tabs button[data-tab]').forEach((b) => {
    if (b.dataset.tab !== 'server' && b.dataset.tab !== 'settings') b.classList.toggle('hidden', !visible);
  });
}

async function showApp(info) {
  $('#connectView').classList.add('hidden');
  $('#appView').classList.remove('hidden');
  setCpanelTabsVisible(true);
  state.user = info.user;
  $('#connInfo').textContent = `${info.user} @ ${info.host.replace(/^https?:\/\//, '')}${info.insecure ? ' ⚠ TLS unverified' : ''}`;
  $('#overviewUser').textContent = info.user;

  const u = await uapi('Variables', 'get_user_information', { name: 'home' });
  state.home = (u.ok && u.data && u.data.home) || `/home/${info.user}`;
  await loadDomainList().catch(() => {});
  selectTab('overview');
}

$('#connectForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = formData(e.target);
  const b = e.target.querySelector('button');
  b.disabled = true; b.textContent = 'Connecting…';
  const r = await post('connect', { ...f, insecure: !!f.insecure });
  b.disabled = false; b.textContent = 'Connect';
  if (!r.ok) return toast(r.errors.join('\n'), true);
  e.target.token.value = '';
  showApp(r.info);
});

$('#logoutBtn').onclick = async () => { await post('logout'); showConnect(); };

function showServerOnly() {
  $('#connectView').classList.add('hidden');
  $('#appView').classList.remove('hidden');
  $('#connInfo').textContent = '(no cPanel connection)';
  setCpanelTabsVisible(false);
  document.querySelectorAll('#tabs button[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'server'));
  document.querySelectorAll('.tab').forEach((d) => d.classList.toggle('hidden', d.id !== 'tab-server'));
  $('#breadcrumb').textContent = TAB_LABELS.server;
  if (term) safeFitTerminal();
}
$('#connectTabs').addEventListener('click', (e) => {
  const t = e.target.dataset.ctab;
  if (!t) return;
  document.querySelectorAll('#connectTabs button').forEach((b) => b.classList.toggle('active', b === e.target));
  $('#connectPanel-cpanel').classList.toggle('hidden', t !== 'cpanel');
  $('#connectPanel-ssh').classList.toggle('hidden', t !== 'ssh');
});
$('#goSshBtn').onclick = () => showServerOnly();

$('#saveProfileBtn').onclick = async () => {
  const name = prompt('Profile name:', state.user);
  if (!name) return;
  const passphrase = prompt('Vault passphrase (min 8 chars). Use the same one every time:');
  if (!passphrase) return;
  const r = await post('vault/save', { name, passphrase });
  r.ok ? toast('Profile saved (encrypted)') : toast(r.errors.join('\n'), true);
};

let vaultPass = '';
$('#vaultForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  vaultPass = e.target.passphrase.value;
  renderProfiles();
});
async function renderProfiles() {
  const r = await post('vault/list', { passphrase: vaultPass });
  const ul = $('#profileList');
  if (!r.ok) { ul.replaceChildren(); return toast(r.errors.join('\n'), true); }
  if (!r.profiles.length) return ul.replaceChildren(el('li', { class: 'muted' }, 'No saved profiles'));
  ul.replaceChildren(...r.profiles.map((p) => el('li', {},
    el('span', { class: 'grow' }, `${p.name} — ${p.user}@${p.host.replace(/^https?:\/\//, '')}`),
    btn('Connect', async () => {
      const x = await post('vault/load', { name: p.name, passphrase: vaultPass });
      x.ok ? showApp(x.info) : toast(x.errors.join('\n'), true);
    }, 'primary'),
    btn('Delete', async () => {
      if (!confirm(`Delete profile "${p.name}"?`)) return;
      await post('vault/delete', { name: p.name, passphrase: vaultPass });
      renderProfiles();
    }, 'danger'),
  )));
}

// ------------------------------------------------------------ tabs
const TAB_LABELS = {
  overview: 'Overview', files: 'Files', email: 'Email', domains: 'Domains', db: 'Databases',
  cron: 'Cron Jobs', ftp: 'FTP Accounts', server: 'Server / SSH', console: 'API Console', settings: 'Settings',
};
const loaders = {
  overview: loadOverview,
  files: () => openDir(state.cwd || state.home), email: loadEmail, domains: loadDomains, db: loadDb, console: () => {},
  cron: loadCron, ftp: loadFtp,
  server: () => { if (term) safeFitTerminal(); },
  settings: () => {},
};
function closeSidebar() {
  $('#sidebar').classList.remove('open');
  $('#sidebarOverlay').classList.remove('show');
}
function selectTab(t) {
  if (!loaders[t]) return;
  document.querySelectorAll('#tabs button[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
  document.querySelectorAll('.tab').forEach((d) => d.classList.toggle('hidden', d.id !== 'tab-' + t));
  $('#breadcrumb').textContent = TAB_LABELS[t] || t;
  closeSidebar();
  silent(async () => loaders[t]())();
}
$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (b) selectTab(b.dataset.tab);
});
document.addEventListener('click', (e) => {
  const g = e.target.closest('[data-go]');
  if (g) selectTab(g.dataset.go);
});
$('#mobileToggle').onclick = () => {
  $('#sidebar').classList.add('open');
  $('#sidebarOverlay').classList.add('show');
};
$('#sidebarOverlay').onclick = closeSidebar;

async function loadOverview() {
  $('#statDomains').textContent = String(state.domains.length || 0);
  $('#statConnFoot').textContent = $('#connInfo').textContent;
  const pops = (await call(uapi('Email', 'list_pops_with_disk')).catch(() => [])) || [];
  $('#statEmail').textContent = String(pops.filter((p) => (p.email || '').includes('@')).length);
  const dbs = (await call(uapi('Mysql', 'list_databases')).catch(() => [])) || [];
  $('#statDb').textContent = String(dbs.length);
  const jobs = (await call(api2('Cron', 'listcron')).catch(() => [])) || [];
  $('#statCron').textContent = String(jobs.filter((j) => j && j.command).length);
  const ftps = (await call(uapi('Ftp', 'list_ftp_with_disk')).catch(() => [])) || [];
  $('#statFtp').textContent = String(ftps.length);
}

// ------------------------------------------------------------ FILES
async function openDir(dir) {
  state.cwd = dir;
  $('#pathInput').value = dir;
  const tbody = $('#fileRows');
  emptyRow(tbody, 5, 'Loading…');
  const r = await uapi('Fileman', 'list_files', {
    dir, types: 'dir|file', include_mime: 0, include_permissions: 1, show_hidden: $('#showHidden').checked ? 1 : 0,
  });
  if (!r.ok) { emptyRow(tbody, 5, (r.errors || []).join(' ')); return; }
  const items = (r.data || []).sort((a, b) => (a.type === b.type ? a.file.localeCompare(b.file) : a.type === 'dir' ? -1 : 1));
  if (!items.length) return emptyRow(tbody, 5, 'Empty folder');
  tbody.replaceChildren(...items.map(fileRow));
}

function fileRow(f) {
  const full = f.fullpath || joinPath(state.cwd, f.file);
  const isDir = f.type === 'dir';
  const name = el('a', { href: '#', onclick: (e) => { e.preventDefault(); isDir ? openDir(full) : editFile(f.file); } },
    (isDir ? '📁 ' : '📄 ') + f.file);
  return el('tr', {},
    el('td', {}, name),
    el('td', {}, isDir ? '' : f.humansize || f.size || ''),
    el('td', {}, f.nicemode || f.mode || ''),
    el('td', {}, f.mtime ? new Date(f.mtime * 1000).toLocaleString() : ''),
    actions(
      btn('Rename', silent(async () => {
        const n = prompt('New name:', f.file);
        if (!n || n === f.file) return;
        await call(api2('Fileman', 'fileop', { op: 'rename', sourcefiles: full, destfiles: joinPath(state.cwd, n) }), 'Renamed');
        openDir(state.cwd);
      })),
      btn('Chmod', silent(async () => {
        const m = prompt('Permissions (e.g. 0644 or 0755):', f.nicemode ? '0' + f.nicemode.replace(/^0/, '') : '0644');
        if (!m || !/^0?[0-7]{3}$/.test(m)) return;
        await call(api2('Fileman', 'fileop', { op: 'chmod', sourcefiles: full, metadata: m.padStart(4, '0') }), 'Permissions updated');
        openDir(state.cwd);
      })),
      btn('Delete', silent(async () => {
        if (!confirm(`Move "${f.file}" to trash?`)) return;
        await call(api2('Fileman', 'fileop', { op: 'trash', sourcefiles: full }), 'Moved to trash');
        openDir(state.cwd);
      }), 'danger'),
    ));
}

let editing = null;
async function editFile(file) {
  const d = await call(uapi('Fileman', 'get_file_content', { dir: state.cwd, file, from_charset: '_DETECT_', to_charset: 'UTF-8' })).catch(() => null);
  if (!d) return;
  editing = { source: 'cpanel', dir: state.cwd, file };
  $('#editorTitle').textContent = joinPath(state.cwd, file);
  $('#editorText').value = d.content || '';
  $('#editor').showModal();
}
$('#editorSave').addEventListener('click', silent(async (e) => {
  e.preventDefault();
  if (editing.source === 'sftp') {
    await call(post('sftp/write', { path: editing.path, content: $('#editorText').value }), 'Saved');
    $('#editor').close();
    openSftpDir(sftpCwd);
    return;
  }
  await call(uapi('Fileman', 'save_file_content', { dir: editing.dir, file: editing.file, content: $('#editorText').value, from_charset: 'UTF-8', to_charset: 'UTF-8' }), 'Saved');
  $('#editor').close();
  openDir(state.cwd);
}));

$('#goBtn').onclick = () => openDir($('#pathInput').value.trim() || state.home);
$('#pathInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#goBtn').click(); });
$('#showHidden').onchange = () => openDir(state.cwd);
$('#upBtn').onclick = () => {
  const p = state.cwd.replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '/';
  openDir(p);
};
$('#newFileBtn').onclick = silent(async () => {
  const n = prompt('New file name:');
  if (!n) return;
  await call(uapi('Fileman', 'save_file_content', { dir: state.cwd, file: n, content: '' }), 'File created');
  openDir(state.cwd);
});
$('#newDirBtn').onclick = silent(async () => {
  const n = prompt('New folder name:');
  if (!n) return;
  await call(api2('Fileman', 'mkdir', { path: state.cwd, name: n }), 'Folder created');
  openDir(state.cwd);
});
$('#uploadInput').onchange = silent(async (e) => {
  for (const file of e.target.files) {
    if (file.size > 40 * 1024 * 1024) { toast(`${file.name} is over 40 MB — use FTP for big files`, true); continue; }
    toast(`Uploading ${file.name}…`);
    const b64 = await new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result).split(',')[1] || '');
      fr.onerror = rej;
      fr.readAsDataURL(file);
    });
    await call(post('upload', { dir: state.cwd, name: file.name, b64 }), `Uploaded ${file.name}`).catch(() => {});
  }
  e.target.value = '';
  openDir(state.cwd);
});

// ------------------------------------------------------------ DOMAINS (shared list)
async function loadDomainList() {
  const d = await call(uapi('DomainInfo', 'list_domains'));
  state.mainDomain = d.main_domain;
  state.domainsData = d;
  state.domains = [d.main_domain, ...(d.addon_domains || []), ...(d.parked_domains || [])].filter(Boolean);
  document.querySelectorAll('.domainSelect').forEach((s) => {
    const cur = s.value;
    s.replaceChildren(...state.domains.map((x) => el('option', { value: x }, x)));
    if (state.domains.includes(cur)) s.value = cur;
  });
}

async function loadDomains() {
  await loadDomainList();
  $('#mainDomain').textContent = state.mainDomain;

  const dd = await call(uapi('DomainInfo', 'domains_data', { format: 'hash' })).catch(() => ({}));
  const subs = dd.sub_domains || [];
  const subRows = $('#subRows');
  if (!subs.length) emptyRow(subRows, 3);
  else subRows.replaceChildren(...subs.map((s) => {
    const root = state.domains.find((r) => s.domain.endsWith('.' + r)) || state.mainDomain;
    const label = s.domain.slice(0, -(root.length + 1));
    return el('tr', {}, el('td', {}, s.domain), el('td', {}, s.documentroot || ''),
      actions(
        btn('Doc root', silent(async () => {
          const dir = prompt('New document root (relative to home):', (s.documentroot || '').replace(state.home + '/', ''));
          if (!dir) return;
          await call(api2('SubDomain', 'changedocroot', { subdomain: label, rootdomain: root, dir }), 'Document root changed');
          loadDomains();
        })),
        btn('Delete', silent(async () => {
          if (!confirm(`Delete subdomain ${s.domain}? (files are kept)`)) return;
          await call(api2('SubDomain', 'delsubdomain', { domain: s.domain }), 'Subdomain deleted');
          loadDomains();
        }), 'danger')));
  }));

  const addons = (await call(api2('AddonDomain', 'listaddondomains')).catch(() => [])) || [];
  const addonRows = $('#addonRows');
  if (!addons.length) emptyRow(addonRows, 3);
  else addonRows.replaceChildren(...addons.map((a) => el('tr', {}, el('td', {}, a.domain), el('td', {}, a.dir || ''),
    actions(btn('Delete', silent(async () => {
      if (!confirm(`Remove addon domain ${a.domain}? (files are kept)`)) return;
      await call(api2('AddonDomain', 'deladdondomain', { domain: a.domain, subdomain: `${a.subdomain}_${a.rootdomain}` }), 'Addon domain removed');
      loadDomains();
    }), 'danger')))));

  const parked = state.domainsData.parked_domains || [];
  const parkRows = $('#parkRows');
  if (!parked.length) emptyRow(parkRows, 2);
  else parkRows.replaceChildren(...parked.map((p) => el('tr', {}, el('td', {}, p),
    actions(btn('Delete', silent(async () => {
      if (!confirm(`Remove alias ${p}?`)) return;
      await call(api2('Park', 'unpark', { domain: p }), 'Alias removed');
      loadDomains();
    }), 'danger')))));
}

$('#addSubForm').addEventListener('submit', silent(async (e) => {
  e.preventDefault();
  const f = formData(e.target);
  const params = { domain: f.sub.trim(), rootdomain: f.root };
  if (f.dir.trim()) params.dir = f.dir.trim();
  await call(uapi('SubDomain', 'addsubdomain', params), 'Subdomain created');
  e.target.reset(); loadDomains();
}));
$('#addAddonForm').addEventListener('submit', silent(async (e) => {
  e.preventDefault();
  const f = formData(e.target);
  const dom = f.domain.trim().toLowerCase();
  const label = dom.split('.')[0].replace(/[^a-z0-9]/g, '').slice(0, 30) || 'addon';
  await call(api2('AddonDomain', 'addaddondomain', { newdomain: dom, subdomain: label, dir: f.dir.trim() || dom }), 'Addon domain added');
  e.target.reset(); loadDomains();
}));
$('#addParkForm').addEventListener('submit', silent(async (e) => {
  e.preventDefault();
  await call(api2('Park', 'park', { domain: formData(e.target).domain.trim() }), 'Alias added');
  e.target.reset(); loadDomains();
}));

// ------------------------------------------------------------ EMAIL
async function loadEmail() {
  if (!state.domains.length) await loadDomainList();
  const pops = (await call(uapi('Email', 'list_pops_with_disk')).catch(() => [])) || [];
  const rows = $('#emailRows');
  const accounts = pops.filter((p) => (p.email || '').includes('@'));
  if (!accounts.length) emptyRow(rows, 4, 'No email accounts');
  else rows.replaceChildren(...accounts.map((p) => {
    const [user, domain] = p.email.split('@');
    return el('tr', {}, el('td', {}, p.email), el('td', {}, p.humandiskused || ''), el('td', {}, p.humandiskquota || ''),
      actions(
        btn('Password', silent(async () => {
          const pw = prompt(`New password for ${p.email}:`);
          if (!pw) return;
          await call(uapi('Email', 'passwd_pop', { email: user, domain, password: pw }), 'Password changed');
        })),
        btn('Quota', silent(async () => {
          const q = prompt('New quota in MB (0 = unlimited):', p.diskquota === 'unlimited' ? '0' : p.diskquota);
          if (q === null || !/^\d+$/.test(q)) return;
          await call(uapi('Email', 'edit_pop_quota', { email: user, domain, quota: q }), 'Quota updated');
          loadEmail();
        })),
        btn('Delete', silent(async () => {
          if (!confirm(`Delete ${p.email} and all its mail?`)) return;
          await call(uapi('Email', 'delete_pop', { email: user, domain }), 'Account deleted');
          loadEmail();
        }), 'danger')));
  }));

  const fwds = (await call(uapi('Email', 'list_forwarders')).catch(() => [])) || [];
  const frows = $('#fwdRows');
  if (!fwds.length) emptyRow(frows, 3, 'No forwarders');
  else frows.replaceChildren(...fwds.map((f) => el('tr', {}, el('td', {}, f.dest), el('td', {}, f.forward),
    actions(btn('Delete', silent(async () => {
      if (!confirm(`Delete forwarder ${f.dest} → ${f.forward}?`)) return;
      await call(uapi('Email', 'delete_forwarder', { address: f.dest, forwarder: f.forward }), 'Forwarder deleted');
      loadEmail();
    }), 'danger')))));
}

$('#addEmailForm').addEventListener('submit', silent(async (e) => {
  e.preventDefault();
  const f = formData(e.target);
  await call(uapi('Email', 'add_pop', { email: f.user.trim(), domain: f.domain, password: f.password, quota: f.quota || 0 }), 'Email account created');
  e.target.reset(); loadDomainList(); loadEmail();
}));
$('#addFwdForm').addEventListener('submit', silent(async (e) => {
  e.preventDefault();
  const f = formData(e.target);
  await call(uapi('Email', 'add_forwarder', { domain: f.domain, email: `${f.user.trim()}@${f.domain}`, fwdopt: 'fwd', fwdemail: f.dest.trim() }), 'Forwarder added');
  e.target.reset(); loadDomainList(); loadEmail();
}));

// ------------------------------------------------------------ DATABASES
async function loadDb() {
  if (!state.prefix) {
    const r = await uapi('Mysql', 'get_restrictions');
    state.prefix = (r.ok && r.data && r.data.prefix) || '';
  }
  $('#dbPrefix').textContent = state.prefix || '(none)';

  const dbs = (await call(uapi('Mysql', 'list_databases')).catch(() => [])) || [];
  const users = (await call(uapi('Mysql', 'list_users')).catch(() => [])) || [];

  const dbRows = $('#dbRows');
  if (!dbs.length) emptyRow(dbRows, 4);
  else dbRows.replaceChildren(...dbs.map((d) => el('tr', {}, el('td', {}, d.database), el('td', {}, (d.users || []).join(', ')),
    el('td', {}, d.disk_usage != null ? (d.disk_usage / 1048576).toFixed(2) + ' MB' : ''),
    actions(btn('Delete', silent(async () => {
      if (!confirm(`DROP database ${d.database}? This cannot be undone.`)) return;
      await call(uapi('Mysql', 'delete_database', { name: d.database }), 'Database deleted');
      loadDb();
    }), 'danger')))));

  const uRows = $('#dbUserRows');
  if (!users.length) emptyRow(uRows, 3);
  else uRows.replaceChildren(...users.map((u) => el('tr', {}, el('td', {}, u.user), el('td', {}, (u.databases || []).join(', ')),
    actions(
      btn('Password', silent(async () => {
        const pw = prompt(`New password for ${u.user}:`);
        if (!pw) return;
        await call(uapi('Mysql', 'set_password', { user: u.user, password: pw }), 'Password changed');
      })),
      btn('Delete', silent(async () => {
        if (!confirm(`Delete MySQL user ${u.user}?`)) return;
        await call(uapi('Mysql', 'delete_user', { name: u.user }), 'User deleted');
        loadDb();
      }), 'danger')))));

  $('#grantUser').replaceChildren(...users.map((u) => el('option', { value: u.user }, u.user)));
  $('#grantDb').replaceChildren(...dbs.map((d) => el('option', { value: d.database }, d.database)));
}
const withPrefix = (n) => (state.prefix && !n.startsWith(state.prefix) ? state.prefix + n : n);
$('#addDbForm').addEventListener('submit', silent(async (e) => {
  e.preventDefault();
  await call(uapi('Mysql', 'create_database', { name: withPrefix(formData(e.target).name.trim()) }), 'Database created');
  e.target.reset(); loadDb();
}));
$('#addDbUserForm').addEventListener('submit', silent(async (e) => {
  e.preventDefault();
  const f = formData(e.target);
  await call(uapi('Mysql', 'create_user', { name: withPrefix(f.name.trim()), password: f.password }), 'User created');
  e.target.reset(); loadDb();
}));
$('#grantForm').addEventListener('submit', silent(async (e) => {
  e.preventDefault();
  const f = formData(e.target);
  await call(uapi('Mysql', 'set_privileges_on_database', { user: f.user, database: f.db, privileges: 'ALL PRIVILEGES' }), 'Privileges granted');
  loadDb();
}));

// ------------------------------------------------------------ CRON
// No UAPI equivalent exists for cron management, so this uses the (still supported) API 2 module.
async function loadCron() {
  const jobs = (await call(api2('Cron', 'listcron')).catch(() => [])) || [];
  const rows = $('#cronRows');
  const valid = jobs.filter((j) => j && j.command);
  if (!valid.length) emptyRow(rows, 3, 'No cron jobs');
  else rows.replaceChildren(...valid.map((j) => el('tr', {},
    el('td', {}, `${j.minute} ${j.hour} ${j.day} ${j.month} ${j.weekday}`),
    el('td', {}, j.command),
    actions(btn('Delete', silent(async () => {
      if (!confirm(`Delete cron job "${j.command}"?`)) return;
      await call(api2('Cron', 'remove_line', { line: j.count }), 'Cron job deleted');
      loadCron();
    }), 'danger')))));
}
$('#addCronForm').addEventListener('submit', silent(async (e) => {
  e.preventDefault();
  const f = formData(e.target);
  await call(api2('Cron', 'add_line', {
    minute: f.minute.trim() || '*', hour: f.hour.trim() || '*', day: f.day.trim() || '*',
    month: f.month.trim() || '*', weekday: f.weekday.trim() || '*', command: f.command.trim(),
  }), 'Cron job created');
  e.target.reset();
  loadCron();
}));

// ------------------------------------------------------------ FTP
async function loadFtp() {
  if (!state.domains.length) await loadDomainList();
  const accounts = (await call(uapi('Ftp', 'list_ftp_with_disk')).catch(() => [])) || [];
  const rows = $('#ftpRows');
  if (!accounts.length) emptyRow(rows, 5, 'No FTP accounts');
  else rows.replaceChildren(...accounts.map((a) => {
    const [user, domain] = (a.login || '').split('@');
    return el('tr', {}, el('td', {}, a.login), el('td', {}, a.dir || ''),
      el('td', {}, a.humandiskused || ''), el('td', {}, a.humandiskquota || ''),
      actions(
        btn('Password', silent(async () => {
          const pw = prompt(`New password for ${a.login}:`);
          if (!pw) return;
          await call(uapi('Ftp', 'passwd', { user, domain, pass: pw }), 'Password changed');
        })),
        btn('Quota', silent(async () => {
          const q = prompt('New quota in MB (0 = unlimited):');
          if (q === null || !/^\d+$/.test(q)) return;
          await call(uapi('Ftp', 'set_quota', { user, domain, quota: q }), 'Quota updated');
          loadFtp();
        })),
        btn('Delete', silent(async () => {
          if (!confirm(`Delete FTP account ${a.login}?`)) return;
          await call(uapi('Ftp', 'delete_ftp', { user, domain }), 'FTP account deleted');
          loadFtp();
        }), 'danger')));
  }));
}
$('#addFtpForm').addEventListener('submit', silent(async (e) => {
  e.preventDefault();
  const f = formData(e.target);
  const params = { user: f.user.trim(), domain: f.domain, pass: f.password, quota: f.quota || 0 };
  if (f.dir.trim()) params.homedir = f.dir.trim();
  await call(uapi('Ftp', 'add_ftp', params), 'FTP account created');
  e.target.reset(); loadFtp();
}));

// ------------------------------------------------------------ CONSOLE
$('#consoleForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = formData(e.target);
  let params;
  try { params = JSON.parse(f.params || '{}'); } catch { return toast('Params must be valid JSON', true); }
  $('#consoleOut').textContent = 'Running…';
  const r = await post(f.api, { module: f.module.trim(), func: f.func.trim(), params });
  $('#consoleOut').textContent = JSON.stringify(r, null, 2);
});

// ------------------------------------------------------------ SERVER (SSH + SFTP + terminal)
let sftpCwd = '.';
let term = null, fitAddon = null, termSocket = null, termOpened = false;

$('#sshConnectForm').addEventListener('change', (e) => {
  if (e.target.name !== 'authMethod') return;
  const isKey = e.target.form.authMethod.value === 'key';
  $('#sshKeyFields').classList.toggle('hidden', !isKey);
  $('#sshPasswordFields').classList.toggle('hidden', isKey);
});

$('#sshConnectForm').addEventListener('submit', (e) => {
  e.preventDefault();
  trySshConnect(formData(e.target));
});

async function trySshConnect(f, trustedFingerprint) {
  const body = { host: f.host.trim(), port: Number(f.port) || 22, username: f.username.trim(), authMethod: f.authMethod };
  if (f.authMethod === 'password') {
    body.password = f.password;
  } else {
    body.keyPath = (f.keyPath || '').trim();
    body.keyText = f.keyText || '';
    body.passphrase = f.passphrase || '';
  }
  if (trustedFingerprint) { body.trustHostKey = true; body.trustedFingerprint = trustedFingerprint; }

  const r = await post('ssh/connect', body);
  if (!r.ok) {
    if (r.hostKeyFingerprint && !r.hostKeyChanged) return askTrustHostKey(f, body.host, body.port, r.hostKeyFingerprint);
    return toast((r.errors || ['Failed']).join('\n'), true);
  }
  f.password = ''; f.passphrase = ''; f.keyText = '';
  state.ssh = r.info;
  onSshConnected();
}

function askTrustHostKey(f, host, port, fingerprint) {
  $('#hostKeyTarget').textContent = `${host}:${port}`;
  $('#hostKeyFingerprint').textContent = fingerprint;
  const dlg = $('#hostKeyDialog');
  dlg.showModal();
  dlg.addEventListener('close', function onClose() {
    dlg.removeEventListener('close', onClose);
    if (dlg.returnValue === 'trust') trySshConnect(f, fingerprint);
  }, { once: true });
}

function onSshConnected() {
  $('#sshConnectBox').classList.add('hidden');
  $('#sshAppBox').classList.remove('hidden');
  $('#sshConnInfo').textContent = `${state.ssh.username}@${state.ssh.host}:${state.ssh.port}`;
  openSftpHome();
  openTerminal();
}

$('#sshDisconnectBtn').onclick = async () => {
  await post('ssh/disconnect');
  closeTerminal();
  state.ssh = null;
  $('#sshAppBox').classList.add('hidden');
  $('#sshConnectBox').classList.remove('hidden');
};

// ---- SFTP file browser
async function openSftpHome() {
  const abs = await call(post('sftp/realpath', { path: '.' })).catch(() => '.');
  openSftpDir(typeof abs === 'string' ? abs : '.');
}

function isDirAttr(entry) {
  const mode = entry.attrs && entry.attrs.mode;
  return mode != null && (mode & 0o170000) === 0o040000;
}
const permString = (mode) => (mode & 0o777).toString(8).padStart(3, '0');

async function openSftpDir(dir) {
  sftpCwd = dir;
  $('#sftpPathInput').value = dir;
  const tbody = $('#sftpRows');
  emptyRow(tbody, 5, 'Loading…');
  const r = await post('sftp/list', { dir });
  if (!r.ok) { emptyRow(tbody, 5, (r.errors || []).join(' ')); return; }
  const items = (r.data || []).filter((x) => x.filename !== '.' && x.filename !== '..')
    .sort((a, b) => {
      const ad = isDirAttr(a), bd = isDirAttr(b);
      return ad === bd ? a.filename.localeCompare(b.filename) : ad ? -1 : 1;
    });
  if (!items.length) return emptyRow(tbody, 5, 'Empty folder');
  tbody.replaceChildren(...items.map(sftpRow));
}

function sftpRow(entry) {
  const full = joinPath(sftpCwd, entry.filename);
  const isDir = isDirAttr(entry);
  const mode = entry.attrs && entry.attrs.mode;
  const size = entry.attrs && entry.attrs.size;
  const mtime = entry.attrs && entry.attrs.mtime;
  const name = el('a', { href: '#', onclick: (e) => { e.preventDefault(); isDir ? openSftpDir(full) : editSftpFile(full); } },
    (isDir ? '📁 ' : '📄 ') + entry.filename);
  return el('tr', {},
    el('td', {}, name),
    el('td', {}, isDir ? '' : String(size ?? '')),
    el('td', {}, mode != null ? permString(mode) : ''),
    el('td', {}, mtime ? new Date(mtime * 1000).toLocaleString() : ''),
    actions(
      btn('Rename', silent(async () => {
        const n = prompt('New name:', entry.filename);
        if (!n || n === entry.filename) return;
        await call(post('sftp/rename', { from: full, to: joinPath(sftpCwd, n) }), 'Renamed');
        openSftpDir(sftpCwd);
      })),
      btn('Chmod', silent(async () => {
        const m = prompt('Permissions (octal, e.g. 644):', mode != null ? permString(mode) : '644');
        if (!m || !/^[0-7]{3,4}$/.test(m)) return;
        await call(post('sftp/chmod', { path: full, mode: parseInt(m, 8) }), 'Permissions updated');
        openSftpDir(sftpCwd);
      })),
      btn('Delete', silent(async () => {
        if (!confirm(`Delete "${entry.filename}" on the server? This cannot be undone.`)) return;
        await call(post(isDir ? 'sftp/rmdir' : 'sftp/unlink', { path: full }), 'Deleted');
        openSftpDir(sftpCwd);
      }), 'danger'),
    ));
}

async function editSftpFile(path) {
  const d = await call(post('sftp/read', { path })).catch(() => null);
  if (!d) return;
  editing = { source: 'sftp', path };
  $('#editorTitle').textContent = path;
  $('#editorText').value = d.content || '';
  $('#editor').showModal();
}

$('#sftpGoBtn').onclick = () => openSftpDir($('#sftpPathInput').value.trim() || '.');
$('#sftpPathInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#sftpGoBtn').click(); });
$('#sftpUpBtn').onclick = () => {
  const p = sftpCwd.replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '/';
  openSftpDir(p);
};
$('#sftpNewFileBtn').onclick = silent(async () => {
  const n = prompt('New file name:');
  if (!n) return;
  await call(post('sftp/write', { path: joinPath(sftpCwd, n), content: '' }), 'File created');
  openSftpDir(sftpCwd);
});
$('#sftpNewDirBtn').onclick = silent(async () => {
  const n = prompt('New folder name:');
  if (!n) return;
  await call(post('sftp/mkdir', { path: joinPath(sftpCwd, n) }), 'Folder created');
  openSftpDir(sftpCwd);
});
$('#sftpUploadInput').onchange = silent(async (e) => {
  for (const file of e.target.files) {
    if (file.size > 40 * 1024 * 1024) { toast(`${file.name} is over 40 MB`, true); continue; }
    toast(`Uploading ${file.name}…`);
    const b64 = await new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result).split(',')[1] || '');
      fr.onerror = rej;
      fr.readAsDataURL(file);
    });
    await call(post('sftp/upload', { dir: sftpCwd, name: file.name, b64 }), `Uploaded ${file.name}`).catch(() => {});
  }
  e.target.value = '';
  openSftpDir(sftpCwd);
});

// ---- interactive terminal (xterm.js over a WebSocket)
function initTerminalOnce() {
  if (termOpened) return;
  term = new Terminal({ cursorBlink: true, fontSize: 13, scrollback: 5000 });
  fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open($('#terminal'));
  termOpened = true;
  term.onData((data) => {
    if (termSocket && termSocket.readyState === WebSocket.OPEN) termSocket.send(new TextEncoder().encode(data));
  });
  window.addEventListener('resize', () => {
    const tab = document.getElementById('tab-server');
    if (tab && !tab.classList.contains('hidden')) safeFitTerminal();
  });
}

function safeFitTerminal() {
  try { fitAddon.fit(); } catch { return; }
  if (termSocket && termSocket.readyState === WebSocket.OPEN) {
    termSocket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  }
}

function openTerminal() {
  initTerminalOnce();
  fitAddon.fit();
  if (termSocket) try { termSocket.close(); } catch {}
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  termSocket = new WebSocket(`${proto}//${location.host}/ws/terminal?cols=${term.cols}&rows=${term.rows}`);
  termSocket.binaryType = 'arraybuffer';
  termSocket.onmessage = (ev) => {
    term.write(typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data));
  };
  termSocket.onclose = () => term.write('\r\n\x1b[31m[connection closed]\x1b[0m\r\n');
}

function closeTerminal() {
  if (termSocket) { try { termSocket.close(); } catch {} termSocket = null; }
  if (term) { term.dispose(); term = null; termOpened = false; }
}

// ------------------------------------------------------------ boot
(async () => {
  const s = await post('status');
  if (s.vault) $('#vaultBox').classList.remove('hidden'); else $('#vaultBox').classList.add('hidden');
  if (s.connected) showApp(s.conn); else if (s.ssh) showServerOnly(); else showConnect();
  if (s.ssh) {
    state.ssh = s.ssh;
    onSshConnected();
  }
})();
