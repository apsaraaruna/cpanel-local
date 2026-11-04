#!/usr/bin/env node
'use strict';
/* Builds standalone, cross-platform executables (no Node.js install required) via pkg. */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const VERSION = require(path.join(ROOT, 'package.json')).version;

// ssh2's native accelerators (cpu-features, sshcrypto) are optional — ssh2 falls back to a
// pure-JS implementation if they fail to load. We exclude them from the bundle so a single
// Windows build machine can produce correct executables for every target OS, instead of
// shipping a Windows-only .node file next to the macOS/Linux binaries.
const NATIVE_FILES = [
  path.join(ROOT, 'node_modules/cpu-features/build/Release/cpufeatures.node'),
  path.join(ROOT, 'node_modules/ssh2/lib/protocol/crypto/build/Release/sshcrypto.node'),
];

function withNativeAddonsHidden(fn) {
  const stashed = [];
  for (const f of NATIVE_FILES) {
    if (fs.existsSync(f)) {
      const stash = f + '.stash';
      fs.renameSync(f, stash);
      stashed.push([stash, f]);
    }
  }
  try {
    fn();
  } finally {
    for (const [stash, original] of stashed) fs.renameSync(stash, original);
  }
}

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

const pkgBin = path.join(ROOT, 'node_modules', '@yao-pkg', 'pkg', 'lib-es5', 'bin.js');
const targetsArg = process.argv[2]; // optional: comma-separated targets to override package.json's list

withNativeAddonsHidden(() => {
  // --no-bytecode: cross-compiling from one OS can't fabricate V8 bytecode for a *different*
  // target OS — pkg does it by spawning that target's own binary locally, which only works for
  // the host's own platform (a Windows host can't spawn a macOS/Linux binary at all, so even
  // --fallback-to-source can't help: there's nothing to fall back from). Shipping plain JS
  // source for every target sidesteps needing to execute any target binary locally.
  const args = [pkgBin, 'server.js', '-c', path.join(ROOT, 'package.json'), '--out-path', DIST, '--no-bytecode'];
  if (targetsArg) args.push('-t', targetsArg);
  execFileSync(process.execPath, args, { stdio: 'inherit', cwd: ROOT });
});

// Add a version suffix and a checksum file for each built executable.
const files = fs.readdirSync(DIST);
const shaLines = [];
for (const file of files) {
  const ext = path.extname(file);
  const base = path.basename(file, ext);
  const versioned = `${base}-v${VERSION}${ext}`;
  fs.renameSync(path.join(DIST, file), path.join(DIST, versioned));
  const buf = fs.readFileSync(path.join(DIST, versioned));
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  shaLines.push(`${sha256}  ${versioned}`);
  console.log(`${versioned}  (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
}
fs.writeFileSync(path.join(DIST, 'SHA256SUMS.txt'), shaLines.join('\n') + '\n');
console.log(`\nWrote ${files.length} executable(s) + SHA256SUMS.txt to dist/`);
