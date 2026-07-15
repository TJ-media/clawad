'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const REPORT = path.join(__dirname, '..', 'scripts', 'alpha-e2e-report.js');
const { markdown, requiredCaseIds, template, validate } = require(REPORT);

function validInput(status = 'BLOCKED') {
  const input = template();
  input.environment.commit = 'a'.repeat(40);
  input.environment.apiOrigin = 'https://api.alpha.internal';
  input.environment.webOrigin = 'https://app.alpha.internal';
  input.environment.evidenceIndexOrigin = 'https://evidence.alpha.internal';
  input.environment.preflights = Object.fromEntries([
    ['windows', 'win32'],
    ['macos', 'darwin'],
    ['linux', 'linux'],
  ].map(([osName, platform]) => [osName, {
    evidence: `EVIDENCE:CLAW64/preflight/${osName}`,
    commit: input.environment.commit,
    platform,
    completedAt: new Date().toISOString(),
  }]));
  input.environment.campaignKey = 'QA-ALPHA-20260714-01';
  input.cases = input.cases.map((item, index) => ({
    ...item,
    status,
    evidence: `EVIDENCE:CLAW64/case/${String(index).padStart(3, '0')}`,
    notes: status === 'PASS' ? '기대 결과 확인' : '외부 테스트 환경 대기',
  }));
  return input;
}

test('필수 매트릭스는 3 OS, 3 OAuth 공급자의 전체 여정과 복원력 93건을 포함한다', () => {
  const ids = requiredCaseIds();
  assert.equal(ids.length, 93);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes('OS.windows.UNINSTALL_RESTORE'));
  assert.ok(ids.includes('OAUTH.macos.kakao.REFRESH'));
  assert.ok(ids.includes('OAUTH.linux.naver.UNLINK'));
  assert.ok(ids.includes('E2E.windows.google.AD_VIEW_5S_SYNC_PENDING_CONFIRMED'));
  assert.ok(ids.includes('E2E.macos.kakao.SAFE_CLICK_DASHBOARD_CTR'));
  assert.ok(ids.includes('FLOW.QA_DATA_CLEANUP'));
});

test('모든 항목 PASS일 때만 GO 보고서를 만든다', () => {
  const input = validInput('PASS');
  const report = markdown(input, validate(input));
  assert.match(report, /판정: \*\*GO\*\*/);
  assert.match(report, /PASS 93 \/ FAIL 0 \/ BLOCKED 0/);
  assert.match(report, /전용 QA 데이터 정리 증거가 확인됐습니다/);
});

test('BLOCKED가 하나라도 있으면 NO-GO 보고서를 만든다', () => {
  const input = validInput('PASS');
  input.cases[0].status = 'BLOCKED';
  input.cases[0].notes = 'Windows 테스트 장비 대기';
  const report = markdown(input, validate(input));
  assert.match(report, /판정: \*\*NO-GO\*\*/);
  assert.match(report, /PASS 92 \/ FAIL 0 \/ BLOCKED 1/);
});

test('누락·중복·알 수 없는 case를 거부한다', () => {
  const missing = validInput();
  missing.cases.pop();
  assert.throws(() => validate(missing), /필수 case 누락/);

  const duplicate = validInput();
  duplicate.cases[1].id = duplicate.cases[0].id;
  assert.throws(() => validate(duplicate), /중복 case id/);

  const unknown = validInput();
  unknown.cases[0].id = 'FLOW.UNKNOWN';
  assert.throws(() => validate(unknown), /알 수 없는 case id/);
});

test('환경 격리와 실패 재현 및 비밀정보 금지 규칙을 강제한다', () => {
  const runId = validInput();
  runId.runId = 'other-project-run';
  assert.throws(() => validate(runId), /CLAW-64-/);

  const insecure = validInput();
  insecure.environment.apiOrigin = 'http://api.example.test';
  assert.throws(() => validate(insecure), /HTTPS origin/);

  const campaign = validInput();
  campaign.environment.campaignKey = 'PROD-ALPHA-01';
  assert.throws(() => validate(campaign), /QA-ALPHA-/);

  const placeholderOrigin = validInput();
  placeholderOrigin.environment.webOrigin = 'https://app.example.com';
  assert.throws(() => validate(placeholderOrigin), /placeholder origin/);

  const placeholderEvidence = validInput();
  placeholderEvidence.cases[0].evidence = 'EVIDENCE:replace/case';
  assert.throws(() => validate(placeholderEvidence), /placeholder가 아닌/);

  const duplicateEvidence = validInput();
  duplicateEvidence.cases[1].evidence = duplicateEvidence.cases[0].evidence;
  assert.throws(() => validate(duplicateEvidence), /다른 case와 공유/);

  const mismatchedPreflight = validInput();
  mismatchedPreflight.environment.preflights.windows.commit = 'b'.repeat(40);
  assert.throws(() => validate(mismatchedPreflight), /배포 commit과 같아야/);

  const noReproduction = validInput();
  noReproduction.cases[0].status = 'FAIL';
  assert.throws(() => validate(noReproduction), /재현 절차/);

  const leakedSecret = validInput();
  leakedSecret.cases[0].notes = 'Cookie: session=do-not-record';
  assert.throws(() => validate(leakedSecret), /인증정보·토큰·이메일/);

  for (const leaked of [
    'Authorization: Basic Zm9vOmJhcg==',
    'callback?code=oauth-code',
    'client secret: copied-value',
    'OAuth code: copied-value',
    '{"code":"copied-value"}',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature',
    'user@example.com',
  ]) {
    const input = validInput();
    input.cases[0].notes = leaked;
    assert.throws(() => validate(input), /인증정보·토큰·이메일/);
  }
});

test('여러 줄 증거와 메모가 Markdown 표 구조를 깨뜨리지 않는다', () => {
  const input = validInput('PASS');
  input.cases[0].notes = '첫 줄\n확인 | 완료';
  const report = markdown(input, validate(input));
  assert.match(report, /첫 줄 확인 \\\| 완료/);
  assert.doesNotMatch(report, /첫 줄\n확인/);
});

test('CLI는 BOM JSON을 읽고 NO-GO를 종료 코드와 보고서에 반영한다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawad-alpha-e2e-'));
  const inputFile = path.join(dir, 'result.json');
  const outputFile = path.join(dir, 'report.md');
  fs.writeFileSync(inputFile, `\uFEFF${JSON.stringify(validInput())}`);

  const noGo = spawnSync(process.execPath, [REPORT, inputFile, outputFile], { encoding: 'utf8' });
  assert.equal(noGo.status, 2);
  assert.match(fs.readFileSync(outputFile, 'utf8'), /판정: \*\*NO-GO\*\*/);

  const allowed = spawnSync(process.execPath, [REPORT, inputFile, '--allow-no-go'], { encoding: 'utf8' });
  assert.equal(allowed.status, 0);
  assert.match(allowed.stdout, /BLOCKED 93/);
});
