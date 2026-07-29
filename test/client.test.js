'use strict';
// 클라이언트 경계 스모크 — 광고 표시 창구가 오버레이 하나로 모인 뒤(CLAW-134) clawad가
// 지켜야 하는 것: statusLine 슬롯 미점유, 광고 경로의 무네트워크·무비밀키, 수집 금지 데이터 미접근,
// 실행 가능한 명령 안내. 노출 인정·리워드 동작 자체는 overlay-events.test.js가 검증한다.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLIENT_DIR = path.join(__dirname, '..', 'client');
const read = (name) => fs.readFileSync(path.join(CLIENT_DIR, name), 'utf8');

/** 광고 표시 사실을 원장으로 옮기는 경로. 오버레이가 트리거하거나 sync가 주기 실행한다. */
const AD_PATH_MODULES = ['overlay-events.js', 'work-activity.js', 'work-activity-store.js', 'ledger-summary.js'];

test('clawad는 statusLine 광고 서피스를 배포하지 않는다 (CLAW-134)', () => {
  for (const name of ['statusline.js', 'statusline-wrapper.js', 'statusline-command.js']) {
    assert.ok(!fs.existsSync(path.join(CLIENT_DIR, name)), `${name}은 제거됐어야 한다`);
  }
});

test('어떤 클라이언트 모듈도 statusLine 실행 명령을 만들지 않는다 (CLAW-134)', () => {
  // 슬롯은 하나뿐이라 우리가 잡으면 오버레이가 Claude 구독 쿼터를 읽지 못한다. 슬롯을 다시
  // 점유하려면 우리 스크립트를 가리키는 명령을 만들어야 하므로, 그 경로 구성이 없는지 본다.
  // (install.js는 옛 등록을 알아보기 위해 파일명을 문자열로 읽기만 한다.)
  for (const name of fs.readdirSync(CLIENT_DIR)) {
    if (!name.endsWith('.js')) continue;
    assert.doesNotMatch(read(name), /path\.join\([^)]*statusline[^)]*\.js['"]/i, `${name}이 statusLine 실행 경로를 만들면 안 된다`);
  }
});

test('광고 경로에 네트워크 호출 코드가 없다', () => {
  for (const name of AD_PATH_MODULES) {
    const src = read(name);
    for (const forbidden of ['fetch(', 'http.request', 'https.request', 'net.connect']) {
      assert.ok(!src.includes(forbidden), `${name}에 ${forbidden}가 있으면 안 된다`);
    }
  }
});

test('광고 경로가 서비스 비밀 키나 HMAC을 만들지 않는다', () => {
  for (const name of AD_PATH_MODULES) {
    const src = read(name);
    assert.ok(!src.includes('createHmac'), `${name}은 HMAC을 만들지 않는다 (rules §10)`);
    assert.ok(!/SECRET|_secret/.test(src), `${name}은 서비스 비밀 키를 보유하지 않는다`);
  }
});

test('광고 경로가 수집 금지 데이터에 접근하지 않는다', () => {
  // 환경변수는 데이터 경로 지정용만 허용. 프롬프트·트랜스크립트·호스트명·네트워크 인터페이스는 금지.
  for (const name of AD_PATH_MODULES) {
    const src = read(name);
    for (const forbidden of ['process.cwd', 'transcript', 'os.hostname', 'networkInterfaces', 'prompt']) {
      assert.ok(!src.includes(forbidden), `${name}이 ${forbidden}에 접근하면 안 된다`);
    }
  }
});

// 안내 명령은 사용자가 그대로 실행할 수 있어야 한다 (CLAW-103).
test('전역 clawad 명령 유무에 따라 실행 가능한 명령을 안내한다 (CLAW-103)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawad-cli-'));
  const distFile = path.join(dir, 'distribution.json');
  const packageUrl = 'https://example.test/releases/download/v9.9.9/clawad-cli.tgz';
  fs.writeFileSync(distFile, JSON.stringify({
    apiOrigin: 'https://api.example.test',
    webOrigin: 'https://example.test',
    releaseManifestUrl: 'https://example.test/manifest.json',
    packageUrl,
  }));
  const previous = { dist: process.env.CLAWAD_DISTRIBUTION, data: process.env.CLAWAD_DATA };
  process.env.CLAWAD_DISTRIBUTION = distFile;
  process.env.CLAWAD_DATA = dir;
  try {
    const config = require('../client/distribution-config');

    // 전역 명령이 없으면 설치에 사용한 npx 형태로 되돌린다.
    assert.strictEqual(config.cliBinaryAvailable(), false);
    assert.strictEqual(config.userCommand('update'), `npx --yes ${packageUrl} update`);

    // 전역 명령이 있으면 짧은 명령을 그대로 안내한다.
    fs.writeFileSync(path.join(dir, 'cli-binary.json'), JSON.stringify({ version: 1, installed: true, updatedAt: Date.now() }));
    assert.strictEqual(config.cliBinaryAvailable(), true);
    assert.strictEqual(config.userCommand('update'), 'clawad update');

    // 설치 기록이 거짓이면 짧은 명령을 안내하지 않는다.
    fs.writeFileSync(path.join(dir, 'cli-binary.json'), JSON.stringify({ version: 1, installed: false, updatedAt: Date.now() }));
    assert.strictEqual(config.userCommand('update'), `npx --yes ${packageUrl} update`);
  } finally {
    if (previous.dist === undefined) delete process.env.CLAWAD_DISTRIBUTION;
    else process.env.CLAWAD_DISTRIBUTION = previous.dist;
    if (previous.data === undefined) delete process.env.CLAWAD_DATA;
    else process.env.CLAWAD_DATA = previous.data;
  }
});

test('저장소 개발 모드에서는 npm run clawad 안내를 유지한다 (CLAW-103)', () => {
  const previous = process.env.CLAWAD_DISTRIBUTION;
  process.env.CLAWAD_DISTRIBUTION = path.join(os.tmpdir(), 'clawad-absent-distribution.json');
  try {
    const config = require('../client/distribution-config');
    assert.strictEqual(config.userCommand('uninstall'), 'npm run clawad:uninstall');
  } finally {
    if (previous === undefined) delete process.env.CLAWAD_DISTRIBUTION;
    else process.env.CLAWAD_DISTRIBUTION = previous;
  }
});
