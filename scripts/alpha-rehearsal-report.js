'use strict';

/**
 * CLAW-66 HOUSE·TEST 캠페인·리워드 지급 리허설 리포트 생성기.
 *
 * 실제 테스터 투입 전, 과금·현금성 지급 없이 전체 운영 흐름을 리허설한 결과를 운영자가 JSON으로
 * 채워 넣으면, 이 스크립트가 (1) 비밀·PII 미기록, (2) HOUSE·TEST가 광고주 매출·미지급 리워드 부채를
 * 만들지 않았다는 하드 게이트, (3) 필수 리허설 케이스 완주 여부를 검증하고 Markdown 리포트를 낸다.
 *
 * 프로덕션 원장·지급 로직은 건드리지 않는다. 무의존성(node 내장)만 쓴다.
 * 검증·집계 지표만 다루며 userId·이메일·토큰·쿠폰 코드 등 원시 식별자는 기록을 거부한다.
 *
 * 사용:
 *   node scripts/alpha-rehearsal-report.js --init result.json   # 템플릿 생성
 *   node scripts/alpha-rehearsal-report.js result.json [out.md]  # 검증 후 리포트 렌더
 */

const fs = require('node:fs');
const path = require('node:path');

// 리허설이 반드시 다뤄야 하는 고정 케이스. 임의 문자열을 케이스 id로 허용하지 않는다.
const REQUIRED_CASES = [
  // 준비
  ['SETUP.HOUSE_CAMPAIGN', 'HOUSE 캠페인·안전한 소재·클릭 목적지 준비'],
  ['SETUP.TEST_CAMPAIGN', 'TEST 캠페인·테스트 포인트 준비'],
  // 캠페인 유형별 과금·리워드 자격 분리
  ['SEPARATION.PAID_BILLABLE', 'PAID 유효 노출은 과금 자격이 있다(정책 확인)'],
  ['SEPARATION.HOUSE_NO_REVENUE', 'HOUSE는 광고주 매출을 만들지 않는다(billing_ledger)'],
  ['SEPARATION.HOUSE_REWARD_ONLY_IF_FUNDED', 'HOUSE는 rewardPolicyId(회사 재원)가 있을 때만 리워드를 적립한다'],
  ['SEPARATION.TEST_NO_REVENUE_NO_LIABILITY', 'TEST는 매출·미지급 리워드 부채를 만들지 않는다'],
  // 전체 지급 흐름
  ['FLOW.IMPRESSION_TO_PENDING', '노출→검증 중(예상 적립) 반영'],
  ['FLOW.CONFIRM', '확정 배치로 확정 리워드 전이'],
  ['FLOW.REDEEM_WITH_EMAIL', '교환 신청(발송 이메일 입력·동의, CLAW-74)→교환 대기'],
  ['FLOW.MANUAL_DELIVER', '운영자 수동 쿠폰 발송→지급 완료, 발송 이메일 파기 확인'],
  // 원장 일치 시나리오
  ['LEDGER.REFUND', '환불 시 지급 원장·포인트 일치'],
  ['LEDGER.CLAW_BACK', 'claw_back 회수 시 원장·포인트 일치'],
  ['LEDGER.DELIVERY_FAIL_RETRY', '발송 실패·재시도 시 원장·포인트 일치'],
  ['LEDGER.ADMIN_ADJUST', '관리자 조정 시 원장·포인트 일치'],
  // 사용자 화면 vs 서버 원장
  ['CONSISTENCY.USER_VS_LEDGER', '예상/검증 중/확정 값이 사용자 화면과 서버 원장에서 일치'],
  // 산출물·운영 통제
  ['REPORT.ANON_ADVERTISER_SAMPLE', '익명 광고주 성과 보고서 샘플 생성'],
  ['OPS.CAMPAIGN_STOP', 'kill switch로 캠페인을 안전하게 중지'],
  ['OPS.PAYOUT_HOLD', '지급 보류(교환 대기 유지·운영자 검토)를 안전하게 수행'],
  ['CLEANUP.QA_DATA', '리허설 전용 데이터 정리'],
];
const REQUIRED_CASE_IDS = REQUIRED_CASES.map(([id]) => id);
const STATUSES = new Set(['PASS', 'FAIL', 'BLOCKED']);

// HOUSE·TEST가 만들지 않아야 하는 값(완료 조건). 반드시 정확히 0이어야 GO 가능.
const ZERO_GATE_FIELDS = ['houseRevenueKrw', 'testRevenueKrw', 'testUnpaidRewardLiabilityKrw'];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

function template() {
  const now = new Date().toISOString();
  return {
    runId: `CLAW-66-${now.slice(0, 10)}`,
    environment: {
      apiOrigin: 'https://api.example.com',
      commit: '40자리 git commit SHA',
      campaignKey: 'QA-ALPHA-YYYYMMDD-01',
      startedAt: now,
    },
    // HOUSE·TEST 분리 하드 게이트. 리허설 원장에서 관측한 값을 채운다.
    separation: {
      houseRevenueKrw: 0,
      testRevenueKrw: 0,
      testUnpaidRewardLiabilityKrw: 0,
      paidBillableImpressions: 0,
    },
    // 익명 광고주 성과 보고서 샘플. 집계 지표만 — 원시 식별자를 넣지 않는다.
    advertiserReport: {
      validImpressions: 0,
      invalidImpressions: 0,
      clicks: 0,
      uniqueClicks: 0,
      ctr: 0,
      billedImpressions: 0,
      budgetSpentKrw: 0,
      invalidReasons: { EXAMPLE_REASON_CODE: 0 },
    },
    cases: REQUIRED_CASES.map(([id, title]) => ({
      id,
      title,
      status: 'BLOCKED',
      evidence: `EVIDENCE:replace/${id.replaceAll('.', '/')}`,
      notes: '관찰 결과 또는 미실행 사유',
      reproduction: '',
      executedAt: now,
    })),
  };
}

function validateText(value, field, required = true) {
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > 1000) {
    throw new Error(`${field}: ${required ? '비어 있지 않은 ' : ''}1000자 이하 문자열이어야 합니다.`);
  }
  // 인증정보·토큰·이메일·쿠폰 코드 등 원시 식별자 기록 차단(로그 규칙, 익명성).
  if (/bearer\s+[a-z0-9._-]+|authorization\s*:|(?:set-)?cookie\s*:|client[\s_-]*secret|refresh[\s_-]*token|access[\s_-]*token|oauth[\s_-]*code|["']code["']\s*:|eyJ[a-z0-9_-]+\.eyJ[a-z0-9_-]+\.[a-z0-9_-]+|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(value)) {
    throw new Error(`${field}: 인증정보·토큰·이메일 원문을 기록할 수 없습니다.`);
  }
}

function validateEvidence(value, field) {
  if (typeof value !== 'string' || !/^EVIDENCE:(?!replace(?:\/|$))[A-Za-z0-9._/-]{8,200}$/.test(value)) {
    throw new Error(`${field}: placeholder가 아닌 불투명 EVIDENCE 참조가 필요합니다.`);
  }
}

function nonNegativeInt(value, field) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${field}: 0 이상 정수여야 합니다.`);
  return value;
}

function validateEnvironment(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) throw new Error('environment가 필요합니다.');
  let url;
  try { url = new URL(env.apiOrigin); } catch { throw new Error('environment.apiOrigin: 올바른 URL이 아닙니다.'); }
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('environment.apiOrigin: 자격증명·경로 없는 HTTPS origin이어야 합니다.');
  }
  if (typeof env.commit !== 'string' || !/^[0-9a-f]{40}$/i.test(env.commit) || /^0{40}$/.test(env.commit)) {
    throw new Error('environment.commit: 40자리 commit SHA여야 합니다.');
  }
  if (typeof env.campaignKey !== 'string' || !/^QA-ALPHA-[A-Z0-9-]{4,48}$/.test(env.campaignKey) || env.campaignKey.includes('YYYYMMDD')) {
    throw new Error('environment.campaignKey: QA-ALPHA- 전용 접두사가 필요합니다(리허설은 전용 캠페인만).');
  }
  if (typeof env.startedAt !== 'string' || Number.isNaN(Date.parse(env.startedAt))) {
    throw new Error('environment.startedAt: ISO 날짜·시간이어야 합니다.');
  }
}

function validateSeparation(separation) {
  if (!separation || typeof separation !== 'object' || Array.isArray(separation)) {
    throw new Error('separation이 필요합니다.');
  }
  // 완료 조건: HOUSE·TEST는 광고주 매출·미지급 리워드 부채를 만들지 않는다. 정확히 0만 허용.
  for (const field of ZERO_GATE_FIELDS) {
    const value = separation[field];
    if (value !== 0) throw new Error(`separation.${field}: HOUSE·TEST 분리 위반 — 정확히 0이어야 합니다(관측값 ${JSON.stringify(value)}).`);
  }
  nonNegativeInt(separation.paidBillableImpressions, 'separation.paidBillableImpressions');
}

function validateAdvertiserReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    throw new Error('advertiserReport가 필요합니다.');
  }
  const valid = nonNegativeInt(report.validImpressions, 'advertiserReport.validImpressions');
  nonNegativeInt(report.invalidImpressions, 'advertiserReport.invalidImpressions');
  const clicks = nonNegativeInt(report.clicks, 'advertiserReport.clicks');
  const uniqueClicks = nonNegativeInt(report.uniqueClicks, 'advertiserReport.uniqueClicks');
  const billed = nonNegativeInt(report.billedImpressions, 'advertiserReport.billedImpressions');
  nonNegativeInt(report.budgetSpentKrw, 'advertiserReport.budgetSpentKrw');
  if (uniqueClicks > clicks) throw new Error('advertiserReport.uniqueClicks: clicks 이하여야 합니다.');
  if (billed > valid) throw new Error('advertiserReport.billedImpressions: validImpressions 이하여야 합니다.');
  if (typeof report.ctr !== 'number' || !Number.isFinite(report.ctr) || report.ctr < 0 || report.ctr > 1) {
    throw new Error('advertiserReport.ctr: 0~1 사이 수치여야 합니다.');
  }
  const reasons = report.invalidReasons;
  if (!reasons || typeof reasons !== 'object' || Array.isArray(reasons)) {
    throw new Error('advertiserReport.invalidReasons가 필요합니다(없으면 빈 객체).');
  }
  for (const [code, count] of Object.entries(reasons)) {
    // 거절 사유는 저카디널리티 고정 코드만 — 자유 텍스트·식별자를 label로 쓰지 않는다.
    if (!/^[A-Z][A-Z0-9_]{1,48}$/.test(code)) throw new Error(`advertiserReport.invalidReasons: 잘못된 사유 코드 '${code}'.`);
    nonNegativeInt(count, `advertiserReport.invalidReasons.${code}`);
  }
}

function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('결과 루트는 객체여야 합니다.');
  validateText(input.runId, 'runId');
  if (!/^CLAW-66-[A-Za-z0-9._-]{4,80}$/.test(input.runId)) {
    throw new Error('runId: CLAW-66- 접두사와 안전한 식별자만 사용할 수 있습니다.');
  }
  validateEnvironment(input.environment);
  validateSeparation(input.separation);
  validateAdvertiserReport(input.advertiserReport);

  if (!Array.isArray(input.cases)) throw new Error('cases 배열이 필요합니다.');
  const byId = new Map();
  const evidenceRefs = new Set();
  for (const item of input.cases) {
    if (!item || typeof item !== 'object') throw new Error('각 case는 객체여야 합니다.');
    if (!REQUIRED_CASE_IDS.includes(item.id)) throw new Error(`알 수 없는 case id: ${item.id}`);
    if (byId.has(item.id)) throw new Error(`중복 case id: ${item.id}`);
    if (!STATUSES.has(item.status)) throw new Error(`${item.id}: status는 PASS/FAIL/BLOCKED 중 하나여야 합니다.`);
    validateEvidence(item.evidence, `${item.id}.evidence`);
    if (evidenceRefs.has(item.evidence)) throw new Error(`${item.id}: 증거 참조를 다른 case와 공유할 수 없습니다.`);
    evidenceRefs.add(item.evidence);
    validateText(item.notes, `${item.id}.notes`);
    validateText(item.reproduction ?? '', `${item.id}.reproduction`, false);
    if (item.status === 'FAIL' && !String(item.reproduction || '').trim()) {
      throw new Error(`${item.id}: FAIL에는 재현 절차가 필요합니다.`);
    }
    if (typeof item.executedAt !== 'string' || Number.isNaN(Date.parse(item.executedAt))) {
      throw new Error(`${item.id}.executedAt: 실행 날짜·시간이 필요합니다.`);
    }
    byId.set(item.id, item);
  }
  const missing = REQUIRED_CASE_IDS.filter((id) => !byId.has(id));
  if (missing.length) throw new Error(`필수 case 누락: ${missing.join(', ')}`);
  return { byId };
}

function markdown(input, validation) {
  const counts = { PASS: 0, FAIL: 0, BLOCKED: 0 };
  for (const item of validation.byId.values()) counts[item.status] += 1;
  // 분리 게이트는 이미 validate에서 0을 강제했으므로, 남은 판정은 케이스 완주 여부다.
  const verdict = counts.FAIL === 0 && counts.BLOCKED === 0 ? 'GO' : 'NO-GO';
  const cell = (value) => String(value).replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|');
  const report = input.advertiserReport;
  const reasonRows = Object.entries(report.invalidReasons);
  const caseRows = REQUIRED_CASES.map(([id, title]) => {
    const item = validation.byId.get(id);
    return `| ${id} | ${cell(title)} | ${item.status} | ${item.executedAt} | ${cell(item.evidence)} | ${cell(item.notes)} |`;
  });
  const failures = REQUIRED_CASE_IDS
    .map((id) => validation.byId.get(id))
    .filter((item) => item.status === 'FAIL')
    .map((item) => `### ${item.id}\n\n${item.reproduction}`);
  return [
    `# HOUSE·TEST 리허설 리포트 — ${input.runId}`,
    '',
    `- 판정: **${verdict}**`,
    `- Commit: \`${input.environment.commit}\``,
    `- API: ${input.environment.apiOrigin}`,
    `- 리허설 캠페인: \`${input.environment.campaignKey}\``,
    `- 실행 시작: ${input.environment.startedAt}`,
    `- 결과: PASS ${counts.PASS} / FAIL ${counts.FAIL} / BLOCKED ${counts.BLOCKED}`,
    '',
    '## HOUSE·TEST 분리 게이트 (매출·부채 0)',
    '',
    '| 항목 | 관측값 | 기준 |',
    '| --- | --- | --- |',
    `| HOUSE 광고주 매출(KRW) | ${input.separation.houseRevenueKrw} | 0 |`,
    `| TEST 광고주 매출(KRW) | ${input.separation.testRevenueKrw} | 0 |`,
    `| TEST 미지급 리워드 부채(KRW) | ${input.separation.testUnpaidRewardLiabilityKrw} | 0 |`,
    `| PAID 과금 대상 유효 노출 | ${input.separation.paidBillableImpressions} | 참고 |`,
    '',
    '## 익명 광고주 성과 보고서 샘플',
    '',
    '집계 지표만 포함하며 사용자·기기·토큰 등 원시 식별자는 담지 않는다.',
    '',
    '| 지표 | 값 |',
    '| --- | --- |',
    `| 유효 노출 | ${report.validImpressions} |`,
    `| 무효 노출 | ${report.invalidImpressions} |`,
    `| 클릭 | ${report.clicks} |`,
    `| 순 클릭 | ${report.uniqueClicks} |`,
    `| CTR | ${report.ctr} |`,
    `| 과금 노출 | ${report.billedImpressions} |`,
    `| 소진 예산(KRW) | ${report.budgetSpentKrw} |`,
    '',
    '### 거절 사유 집계',
    '',
    reasonRows.length ? '| 사유 코드 | 건수 |\n| --- | --- |' : '거절 사유가 없습니다.',
    ...reasonRows.map(([code, count]) => `| ${code} | ${count} |`),
    '',
    '## 리허설 케이스',
    '',
    '| Case | 항목 | 상태 | 실행 시각 | 증거 | 메모 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...caseRows,
    '',
    '## 실패 재현 절차',
    '',
    failures.length ? failures.join('\n\n') : '실패로 기록된 항목이 없습니다.',
    '',
    '## 데이터 정리 게이트',
    '',
    validation.byId.get('CLEANUP.QA_DATA').status === 'PASS'
      ? '리허설 전용 데이터 정리 증거가 확인됐습니다.'
      : '리허설 전용 데이터 정리가 PASS가 아니므로 GO 판정을 내릴 수 없습니다.',
    '',
  ].join('\n');
}

function atomicWrite(file, contents) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, contents);
  fs.renameSync(temporary, target);
}

function main(argv) {
  if (argv[0] === '--init') {
    if (!argv[1]) throw new Error('초기 결과 JSON 경로를 전달하세요.');
    atomicWrite(argv[1], `${JSON.stringify(template(), null, 2)}\n`);
    console.log(`리허설 결과 템플릿 생성: ${path.resolve(argv[1])}`);
    return;
  }
  const inputFile = argv[0];
  if (!inputFile) throw new Error('결과 JSON 경로를 전달하세요.');
  const input = readJson(inputFile);
  const validation = validate(input);
  const report = markdown(input, validation);
  const outputFile = argv.find((arg, index) => index > 0 && !arg.startsWith('--'));
  if (outputFile) atomicWrite(outputFile, report);
  else process.stdout.write(report);
  const hasNoGo = [...validation.byId.values()].some((item) => item.status !== 'PASS');
  if (hasNoGo && !argv.includes('--allow-no-go')) process.exitCode = 2;
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`ALPHA_REHEARSAL_REPORT_INVALID ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { markdown, template, validate, REQUIRED_CASE_IDS };
