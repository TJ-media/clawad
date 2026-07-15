#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { defaultDataDir, distributionConfig } = require('./distribution-config');

const ROOT = path.join(__dirname, '..');
const DATA = process.env.CLAWAD_DATA || defaultDataDir();

function run(script, args = []) {
  return spawnSync(process.execPath, [script, ...args], {
    stdio: 'inherit', env: { ...process.env, CLAWAD_DATA: DATA }, windowsHide: true,
  });
}

function stableRoot() {
  const config = distributionConfig();
  if (!config.apiOrigin) return ROOT;
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8').replace(/^\uFEFF/, ''));
  const target = path.join(DATA, 'releases', pkg.version, 'package');
  if (path.resolve(ROOT) === path.resolve(target)) return ROOT;
  if (!fs.existsSync(target)) {
    const staging = `${target}.staging-${process.pid}`;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(ROOT, staging, { recursive: true, errorOnExist: true });
    fs.renameSync(staging, target);
  }
  return target;
}

const target = stableRoot();
const installed = run(path.join(target, 'client', 'install.js'), ['install']);
if (installed.status !== 0) process.exit(installed.status || 1);
const pkg = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8').replace(/^\uFEFF/, ''));
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(path.join(DATA, 'release-state.json'), JSON.stringify({
  version: pkg.version,
  root: target,
  updatedAt: new Date().toISOString(),
}, null, 2) + '\n', { mode: 0o600 });
const loggedIn = run(path.join(target, 'client', 'login.js'), process.argv.slice(2));
process.exit(loggedIn.status || 0);
