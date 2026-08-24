#!/usr/bin/env node
// Claude Code·Codex 훅 입력에서 session_id만 사용한다 (CLAW-203). 두 에이전트 모두 페이로드에
// 대화 본문·응답·작업 경로를 함께 실어 보내지만 이 파일이 꺼내는 키는 session_id 하나뿐이다.
// 남기는 것은 세션 해시와 시작·종료 시각이다 (금지 항목은 rules §6, 검사는 client.test.js).
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { defaultDataDir } = require('./distribution-config');
const { updateActivity } = require('./work-activity-store');

const ROOT = path.join(__dirname, '..');
const DATA = process.env.CLAWAD_DATA || defaultDataDir();
const WORK_STATE_DIR = path.join(DATA, 'work-state');
// 정책을 못 읽으면 stale 종료를 적용하지 않는다(Infinity). 기본값으로 넘겨짚으면 활성 구간이
// 잘못된 길이로 잘린 채 파일에 굳고, 이후 표시된 광고가 전부 BELOW_MIN_VIEW로 미인정된다 (CLAW-258).
// 좀비 세션 처리는 정책값을 읽는 수거 쪽(overlay-events)이 책임진다.
let staleActiveMs = Infinity;
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
