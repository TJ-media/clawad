'use strict';

// CLAW-66 HOUSE·TEST 리허설 리포트 생성기 스모크. 분리 게이트·PII 차단·필수 케이스 완주를 검증한다.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const REPORT = path.join(__dirname, '..', 'scripts', 'alpha-rehearsal-report.js');
const { markdown, template, validate, REQUIRED_CASE_IDS } = require(REPORT);

// 모든 케이스를 PASS로 채운 유효 입력.
function validInput() {
  const input = template();
  input.environment.commit = 'a'.repeat(40);
  input.environment.apiOrigin = 'https://api.alpha.internal';
  input.environment.campaignKey = 'QA-ALPHA-20260717-01';
  input.advertiserReport = {
    validImpressions: 120,
    invalidImpressions: 8,
    clicks: 10,
    uniqueClicks: 9,
    ctr: 0.075,
    billedImpressions: 0, // HOUSE·TEST라 과금 노출 0
    budgetSpentKrw: 0,
    invalidReasons: { CONCURRENT_USER_IMPRESSION: 5, BELOW_MIN_DURATION: 3 },
  };
  input.cases = input.cases.map((item, index) => ({
    ...item,
    status: 'PASS',
    evidence: `EVIDENCE:CLAW66/case/${index}`,
    notes: '관찰 결과 정상',
    reproduction: '',
  }));
  return input;
}

function runCli(args, { input } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claw66-'));
  const inputFile = path.join(dir, 'result.json');
  if (input) fs.writeFileSync(inputFile, JSON.stringify(input));
  const result = spawnSync(process.execPath, [REPORT, ...args.map((a) => (a === '@input' ? inputFile : a))], {
    encoding: 'utf8',
  });
  return { ...result, dir, inputFile };
}

test('유효 입력은 GO 리포트를 렌더한다', () => {
  const input = validInput();
  const md = markdown(input, validate(input));
  assert.match(md, /판정: \*\*GO\*\*/);
  assert.match(md, /HOUSE·TEST 분리 게이트/);
  assert.match(md, /익명 광고주 성과 보고서 샘플/);
  for (const id of REQUIRED_CASE_IDS) assert.ok(md.includes(id), `${id}가 리포트에 있어야 한다`);
});

test('BLOCKED·FAIL이 있으면 NO-GO', () => {
  const input = validInput();
  input.cases[0].status = 'BLOCKED';
  assert.match(markdown(input, validate(input)), /판정: \*\*NO-GO\*\*/);
});

test('HOUSE·TEST 매출/부채가 0이 아니면 거부한다 (분리 위반)', () => {
  for (const field of ['houseRevenueKrw', 'testRevenueKrw', 'testUnpaidRewardLiabilityKrw']) {
    const input = validInput();
    input.separation[field] = 1;
    assert.throws(() => validate(input), new RegExp(`separation\\.${field}`));
  }
});

test('필수 리허설 케이스가 빠지면 거부한다', () => {
  const input = validInput();
  input.cases = input.cases.filter((c) => c.id !== 'FLOW.MANUAL_DELIVER');
  assert.throws(() => validate(input), /필수 case 누락/);
});

test('알 수 없는 케이스 id는 거부한다', () => {
  const input = validInput();
  input.cases[0].id = 'FLOW.SOMETHING_ELSE';
  assert.throws(() => validate(input), /알 수 없는 case id/);
});

test('메모·거절 사유에 이메일·토큰 등 PII를 기록하면 거부한다', () => {
  const email = validInput();
  email.cases[0].notes = '발송 tester@example.com 확인';
  assert.throws(() => validate(email), /이메일 원문을 기록할 수 없습니다/);

  const token = validInput();
  token.cases[1].notes = 'authorization: Bearer abc.def.ghi';
  assert.throws(() => validate(token), /기록할 수 없습니다/);
});

test('거절 사유 코드는 저카디널리티 고정 코드만 허용한다', () => {
  const input = validInput();
  input.advertiserReport.invalidReasons = { 'user@x.com': 1 };
  assert.throws(() => validate(input), /잘못된 사유 코드/);
});

test('ctr 범위·집계 정합성을 강제한다', () => {
  const over = validInput();
  over.advertiserReport.ctr = 1.5;
  assert.throws(() => validate(over), /ctr: 0~1/);

  const unique = validInput();
  unique.advertiserReport.uniqueClicks = 999;
  assert.throws(() => validate(unique), /uniqueClicks/);
});

test('FAIL에는 재현 절차가 필요하다', () => {
  const input = validInput();
  input.cases[0].status = 'FAIL';
  input.cases[0].reproduction = '';
  assert.throws(() => validate(input), /재현 절차가 필요/);
});

test('리허설 캠페인 키는 QA-ALPHA- 전용이어야 한다', () => {
  const input = validInput();
  input.environment.campaignKey = 'PROD-CAMPAIGN-1';
  assert.throws(() => validate(input), /QA-ALPHA-/);
});

test('CLI: --init 템플릿은 placeholder라 채우기 전 검증이 거부된다 (종료코드 1)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claw66-'));
  const file = path.join(dir, 'r.json');
  const init = spawnSync(process.execPath, [REPORT, '--init', file], { encoding: 'utf8' });
  assert.equal(init.status, 0);
  assert.ok(fs.existsSync(file));
  // 템플릿은 commit·evidence·campaignKey가 placeholder이므로 그대로 검증하면 실패한다(채워야 함).
  const render = spawnSync(process.execPath, [REPORT, file], { encoding: 'utf8' });
  assert.equal(render.status, 1);
  assert.match(render.stderr, /ALPHA_REHEARSAL_REPORT_INVALID/);
});

test('CLI: 유효 입력이지만 BLOCKED가 남으면 NO-GO로 종료코드 2', () => {
  const input = validInput();
  input.cases[0].status = 'BLOCKED';
  const run = runCli(['@input'], { input });
  assert.equal(run.status, 2);
  assert.match(run.stdout, /NO-GO/);
});

test('CLI: 유효 GO 입력은 종료코드 0', () => {
  const run = runCli(['@input'], { input: validInput() });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /판정: \*\*GO\*\*/);
});

test('CLI: 잘못된 입력은 종료코드 1과 안전한 오류 코드', () => {
  const bad = validInput();
  bad.separation.houseRevenueKrw = 500;
  const run = runCli(['@input'], { input: bad });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /ALPHA_REHEARSAL_REPORT_INVALID/);
});
