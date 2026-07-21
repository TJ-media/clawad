'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { runCompose } = require('./lib/production-compose');

const ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.join(ROOT, 'deploy', 'production', '.env');
const ALERT_TIMEOUT_MS = 180_000;
const POLL_MS = 5_000;
const confirmationIndex = process.argv.indexOf('--confirm');
const confirmation = confirmationIndex >= 0 ? process.argv[confirmationIndex + 1] : '';

function readEnvValue(key) {
  const raw = fs.readFileSync(ENV_FILE, 'utf8').replace(/^\uFEFF/, '');
  const line = raw.split(/\r?\n/).find((entry) => entry.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : '';
}

function assertQaScope() {
  if (confirmation !== 'CLAW-65' || process.env.CLAWAD_DRILL_ENV !== 'qa') {
    throw new Error('QA 장애 드릴은 CLAWAD_DRILL_ENV=qa와 --confirm CLAW-65를 함께 지정해야 합니다.');
  }
  const hostname = readEnvValue('API_DOMAIN').toLowerCase();
  if (!/(^|[.-])(qa|staging|test|localhost)([.-]|$)/.test(hostname)) {
    throw new Error('API_DOMAIN이 qa/staging/test 환경으로 식별되지 않아 장애 주입을 거부했습니다.');
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function activeAlerts() {
  return runCompose([
    'exec', '-T', 'alertmanager',
    'amtool', '--alertmanager.url=http://127.0.0.1:9093', 'alert', 'query',
  ], { capture: true, failureMessage: 'Alertmanager 활성 알림 조회 실패' });
}

async function waitForAlert(alertName, shouldExist) {
  const deadline = Date.now() + ALERT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const exists = activeAlerts().includes(alertName);
    if (exists === shouldExist) return;
    await wait(POLL_MS);
  }
  throw new Error(`${alertName} 알림이 제한 시간 안에 ${shouldExist ? '발생' : '해소'}하지 않았습니다.`);
}

function recover(flags) {
  const pending = ['postgres', 'redis', 'api'].filter((service) => flags[`${service}Stopped`]);
  if (pending.length === 0) return [];
  const errors = [];
  for (const service of pending) {
    try {
      runCompose(['start', service], { failureMessage: `${service} 복구 시작 실패` });
    } catch (error) {
      errors.push(error.message);
    }
  }
  try {
    runCompose(['up', '-d', '--wait', 'postgres', 'redis', 'api'], { failureMessage: 'QA 서비스 준비 상태 복구 실패' });
    for (const service of pending) flags[`${service}Stopped`] = false;
    return [];
  } catch (error) {
    errors.push(error.message);
    return errors;
  }
}

async function drillApi(flags) {
  if (activeAlerts().includes('ClawadApiDown')) throw new Error('드릴 시작 전에 ClawadApiDown이 이미 활성 상태입니다.');
  flags.apiStopped = true;
  runCompose(['stop', 'api'], { failureMessage: 'QA API 장애 주입 실패' });
  await waitForAlert('ClawadApiDown', true);
  console.log('QA 장애 확인: API stop → ClawadApiDown firing');
  runCompose(['start', 'api'], { failureMessage: 'QA API 복구 실패' });
  runCompose(['up', '-d', '--wait', 'api'], { failureMessage: 'QA API 준비 상태 복구 실패' });
  flags.apiStopped = false;
  await waitForAlert('ClawadApiDown', false);
  console.log('QA 복구 확인: API → ClawadApiDown resolved');
}

async function drillDependency(service, flags) {
  const label = service === 'postgres' ? 'PostgreSQL' : 'Redis';
  if (activeAlerts().includes('ClawadDependencyDown')) {
    throw new Error(`드릴 시작 전에 ClawadDependencyDown이 이미 활성 상태입니다(${label}).`);
  }
  flags[`${service}Stopped`] = true;
  runCompose(['stop', service], { failureMessage: `${label} 장애 주입 실패` });
  await waitForAlert('ClawadDependencyDown', true);
  console.log(`QA 장애 확인: ${label} stop → ClawadDependencyDown firing`);
  runCompose(['start', service], { failureMessage: `${label} 복구 실패` });
  runCompose(['up', '-d', '--wait', service, 'api'], { failureMessage: `${label}/API 준비 상태 복구 실패` });
  flags[`${service}Stopped`] = false;
  await waitForAlert('ClawadDependencyDown', false);
  console.log(`QA 복구 확인: ${label} → ClawadDependencyDown resolved`);
}

async function main() {
  assertQaScope();
  const flags = { apiStopped: false, redisStopped: false, postgresStopped: false };
  const onSignal = () => {
    const recoveryErrors = recover(flags);
    if (recoveryErrors.length > 0) {
      console.error(`QA 장애 드릴 signal 복구 실패: ${recoveryErrors.join(' / ')}`);
      process.exit(1);
    }
    process.exit(130);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  let failure = null;
  try {
    await drillApi(flags);
    await drillDependency('redis', flags);
    await drillDependency('postgres', flags);
    console.log('QA 관측 장애 드릴 완료: API/Redis/PostgreSQL firing 및 resolved 확인');
  } catch (error) {
    failure = error;
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    const recoveryErrors = recover(flags);
    if (recoveryErrors.length > 0) {
      const recoveryFailure = new Error(`QA 장애 드릴 복구 실패: ${recoveryErrors.join(' / ')}`);
      failure = failure ? new Error(`${failure.message}; ${recoveryFailure.message}`) : recoveryFailure;
    }
  }
  if (failure) throw failure;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
