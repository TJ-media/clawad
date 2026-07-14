'use strict';

const fs = require('node:fs');
const path = require('node:path');

const OS_NAMES = ['windows', 'macos', 'linux'];
const PROVIDERS = ['google', 'kakao', 'naver'];
const OS_CASES = ['INSTALL', 'UPDATE', 'UNINSTALL_RESTORE', 'SPACE_UNICODE_PATH', 'DESKTOP_IDE_PATH'];
const OAUTH_CASES = ['SIGNUP', 'RELOGIN', 'REFRESH', 'LOGOUT', 'LINK', 'UNLINK'];
const COMBINATION_CASES = ['AD_VIEW_5S_SYNC_PENDING_CONFIRMED', 'SAFE_CLICK_DASHBOARD_CTR'];
const FLOW_CASES = [
  'MULTI_SESSION',
  'TWO_DEVICE',
  'OFFLINE_RECOVERY',
  'REDIS_RESTART',
  'API_RESTART',
  'QA_DATA_CLEANUP',
];
const STATUSES = new Set(['PASS', 'FAIL', 'BLOCKED']);
const PLATFORMS = { windows: 'win32', macos: 'darwin', linux: 'linux' };

function requiredCaseIds() {
  return [
    ...OS_NAMES.flatMap((os) => OS_CASES.map((name) => `OS.${os}.${name}`)),
    ...OS_NAMES.flatMap((os) => PROVIDERS.flatMap((provider) =>
      OAUTH_CASES.map((name) => `OAUTH.${os}.${provider}.${name}`))),
    ...OS_NAMES.flatMap((os) => PROVIDERS.flatMap((provider) =>
      COMBINATION_CASES.map((name) => `E2E.${os}.${provider}.${name}`))),
    ...FLOW_CASES.map((name) => `FLOW.${name}`),
  ];
}

function template() {
  return {
    runId: `CLAW-64-${new Date().toISOString().slice(0, 10)}`,
    environment: {
      apiOrigin: 'https://api.example.com',
      webOrigin: 'https://app.example.com',
      commit: '40자리 git commit SHA',
      campaignKey: 'QA-ALPHA-YYYYMMDD-01',
      startedAt: new Date().toISOString(),
      evidenceIndexOrigin: 'https://evidence.example.com',
      preflights: Object.fromEntries(OS_NAMES.map((os) => [os, {
        evidence: `EVIDENCE:replace/preflight/${os}`,
        commit: '40자리 git commit SHA',
        platform: PLATFORMS[os],
        completedAt: new Date().toISOString(),
      }])),
    },
    cases: requiredCaseIds().map((id) => ({
      id,
      status: 'BLOCKED',
      evidence: `EVIDENCE:replace/${id.replaceAll('.', '/')}`,
      notes: '미실행 사유 또는 관찰 결과',
      reproduction: '',
      executedAt: new Date().toISOString(),
    })),
  };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function validateHttpsOrigin(value, field, rejectPlaceholder = false) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${field}: 올바른 URL이 아닙니다.`); }
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error(`${field}: 자격증명·경로 없는 HTTPS origin이어야 합니다.`);
  }
  if (rejectPlaceholder && (url.hostname === 'example.com' || url.hostname.endsWith('.example.com'))) {
    throw new Error(`${field}: placeholder origin을 실제 환경으로 교체해야 합니다.`);
  }
}

function validateText(value, field, required = true) {
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > 1000) {
    throw new Error(`${field}: ${required ? '비어 있지 않은 ' : ''}1000자 이하 문자열이어야 합니다.`);
  }
  if (/bearer\s+[a-z0-9._-]+|authorization\s*:|(?:set-)?cookie\s*:|client[\s_-]*secret|refresh[\s_-]*token|access[\s_-]*token|oauth[\s_-]*code|["']code["']\s*:|(?:[?&]|\b)code\s*[=:][^\s&]+|eyJ[a-z0-9_-]+\.eyJ[a-z0-9_-]+\.[a-z0-9_-]+|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(value)) {
    throw new Error(`${field}: 인증정보·토큰·이메일 원문을 기록할 수 없습니다.`);
  }
}

function validateEvidence(value, field) {
  if (typeof value !== 'string' || !/^EVIDENCE:(?!replace(?:\/|$))[A-Za-z0-9._/-]{8,200}$/.test(value)) {
    throw new Error(`${field}: placeholder가 아닌 불투명 EVIDENCE 참조가 필요합니다.`);
  }
}

function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('결과 루트는 객체여야 합니다.');
  validateText(input.runId, 'runId');
  if (!/^CLAW-64-[A-Za-z0-9._-]{4,80}$/.test(input.runId)) {
    throw new Error('runId: CLAW-64- 접두사와 안전한 식별자만 사용할 수 있습니다.');
  }
  const env = input.environment;
  if (!env || typeof env !== 'object') throw new Error('environment가 필요합니다.');
  validateHttpsOrigin(env.apiOrigin, 'environment.apiOrigin', true);
  validateHttpsOrigin(env.webOrigin, 'environment.webOrigin', true);
  validateHttpsOrigin(env.evidenceIndexOrigin, 'environment.evidenceIndexOrigin', true);
  if (typeof env.commit !== 'string' || !/^[0-9a-f]{40}$/i.test(env.commit) || /^0{40}$/.test(env.commit)) {
    throw new Error('environment.commit: 40자리 commit SHA여야 합니다.');
  }
  if (typeof env.campaignKey !== 'string' || !/^QA-ALPHA-[A-Z0-9-]{4,48}$/.test(env.campaignKey) || env.campaignKey.includes('YYYYMMDD')) {
    throw new Error('environment.campaignKey: QA-ALPHA- 전용 접두사가 필요합니다.');
  }
  if (typeof env.startedAt !== 'string' || Number.isNaN(Date.parse(env.startedAt))) {
    throw new Error('environment.startedAt: ISO 날짜·시간이어야 합니다.');
  }
  if (!env.preflights || typeof env.preflights !== 'object' || Array.isArray(env.preflights)) {
    throw new Error('environment.preflights가 필요합니다.');
  }
  const preflightRefs = OS_NAMES.map((os) => {
    const preflight = env.preflights[os];
    if (!preflight || typeof preflight !== 'object' || Array.isArray(preflight)) {
      throw new Error(`environment.preflights.${os}가 필요합니다.`);
    }
    validateEvidence(preflight.evidence, `environment.preflights.${os}.evidence`);
    if (preflight.commit !== env.commit) throw new Error(`environment.preflights.${os}.commit은 배포 commit과 같아야 합니다.`);
    if (preflight.platform !== PLATFORMS[os]) throw new Error(`environment.preflights.${os}.platform이 OS와 일치하지 않습니다.`);
    if (typeof preflight.completedAt !== 'string' || Number.isNaN(Date.parse(preflight.completedAt))) {
      throw new Error(`environment.preflights.${os}.completedAt이 필요합니다.`);
    }
    return preflight.evidence;
  });
  if (new Set(preflightRefs).size !== OS_NAMES.length) throw new Error('OS별 preflight 증거 참조는 서로 달라야 합니다.');
  if (!Array.isArray(input.cases)) throw new Error('cases 배열이 필요합니다.');

  const expected = requiredCaseIds();
  const byId = new Map();
  const evidenceRefs = new Set();
  for (const item of input.cases) {
    if (!item || typeof item !== 'object') throw new Error('각 case는 객체여야 합니다.');
    if (!expected.includes(item.id)) throw new Error(`알 수 없는 case id: ${item.id}`);
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
  const missing = expected.filter((id) => !byId.has(id));
  if (missing.length) throw new Error(`필수 case 누락: ${missing.join(', ')}`);
  return { expected, byId };
}

function markdown(input, validation) {
  const counts = { PASS: 0, FAIL: 0, BLOCKED: 0 };
  for (const item of validation.byId.values()) counts[item.status] += 1;
  const verdict = counts.FAIL === 0 && counts.BLOCKED === 0 ? 'GO' : 'NO-GO';
  const tableCell = (value) => value.replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|');
  const rows = validation.expected.map((id) => {
    const item = validation.byId.get(id);
    return `| ${id} | ${item.status} | ${item.executedAt} | ${tableCell(item.evidence)} | ${tableCell(item.notes)} |`;
  });
  const failures = validation.expected
    .map((id) => validation.byId.get(id))
    .filter((item) => item.status === 'FAIL')
    .map((item) => `### ${item.id}\n\n${item.reproduction}`);
  return [
    `# 알파 E2E Go/No-Go — ${input.runId}`,
    '',
    `- 판정: **${verdict}**`,
    `- Commit: \`${input.environment.commit}\``,
    `- API: ${input.environment.apiOrigin}`,
    `- Web: ${input.environment.webOrigin}`,
    `- 증거 인덱스: ${input.environment.evidenceIndexOrigin}`,
    `- QA 캠페인: \`${input.environment.campaignKey}\``,
    `- 실행 시작: ${input.environment.startedAt}`,
    `- 결과: PASS ${counts.PASS} / FAIL ${counts.FAIL} / BLOCKED ${counts.BLOCKED}`,
    '',
    '## OS별 사전검증',
    '',
    '| OS | Platform | Commit | 완료 시각 | 증거 |',
    '| --- | --- | --- | --- | --- |',
    ...OS_NAMES.map((os) => {
      const item = input.environment.preflights[os];
      return `| ${os} | ${item.platform} | \`${item.commit}\` | ${item.completedAt} | ${item.evidence} |`;
    }),
    '',
    '## 필수 케이스',
    '',
    '| Case | 상태 | 실행 시각 | 증거 | 메모 |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
    '## 실패 재현 절차',
    '',
    failures.length ? failures.join('\n\n') : '실패로 기록된 항목이 없습니다.',
    '',
    '## 데이터 정리 게이트',
    '',
    validation.byId.get('FLOW.QA_DATA_CLEANUP').status === 'PASS'
      ? '전용 QA 데이터 정리 증거가 확인됐습니다.'
      : '전용 QA 데이터 정리가 PASS가 아니므로 GO 판정을 내릴 수 없습니다.',
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
    console.log(`알파 E2E 결과 템플릿 생성: ${path.resolve(argv[1])}`);
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
    console.error(`ALPHA_E2E_REPORT_INVALID ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { markdown, requiredCaseIds, template, validate };
