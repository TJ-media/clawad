#!/usr/bin/env node
// Claude Code 훅 입력에서 session_id만 사용한다. 프롬프트·경로·소스는 읽거나 저장하지 않는다.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { defaultDataDir } = require('./distribution-config');
const { updateActivity } = require('./work-activity-store');

const ROOT = path.join(__dirname, '..');
const DATA = process.env.CLAWAD_DATA || defaultDataDir();
const WORK_STATE_DIR = path.join(DATA, 'work-state');
let staleActiveMs = 120000;
try { staleActiveMs = require('../policy/policy').loadPolicy().activity.staleActiveMs; } catch {}

function sessionKey() {
  try {
    const input = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, ''));
    const sessionId = input && input.session_id;
    if (typeof sessionId !== 'string' || sessionId.length < 1 || sessionId.length > 256 || /[\u0000-\u001f\u007f]/.test(sessionId)) return null;
    return crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 32);
  } catch {
    return null;
  }
}

const action = process.argv[2];
const key = sessionKey();
if ((action === 'start' || action === 'stop') && key) updateActivity(WORK_STATE_DIR, key, action, Date.now(), staleActiveMs);
process.exit(0);
