'use strict';
const path = require('path');
const { spawn } = require('child_process');
const { writeJsonAtomic } = require('./sync-runtime');

function requestInitialSync(options = {}) {
  const data = options.data;
  const stateFile = path.join(data, 'preparation-state.json');
  writeJsonAtomic(stateFile, { version: 1, state: 'SYNCING', requestedAt: new Date().toISOString() }, 0o600);
  if (process.env.CLAWAD_INITIAL_SYNC_DRY_RUN === '1') return { started: false, dryRun: true };
  try {
    const child = spawn(process.execPath, [path.join(__dirname, 'sync.js')], {
      stdio: 'ignore', detached: true, windowsHide: true, env: process.env,
    });
    child.unref();
    return { started: true, dryRun: false };
  } catch {
    writeJsonAtomic(stateFile, { version: 1, state: 'RETRY', requestedAt: new Date().toISOString() }, 0o600);
    return { started: false, dryRun: false };
  }
}

module.exports = { requestInitialSync };
