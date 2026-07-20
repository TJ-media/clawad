'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { npmInvocation } = require('../client/release');

const minimumNodeMajor = 24;

function run(args, options = {}) {
  console.log(`\n[preflight] npm ${args.join(' ')}`);
  const invocation = npmInvocation(args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: process.cwd(),
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm ${args.join(' ')} 실패 (${result.status})`);
}

function inspect(command, args, spawn = spawnSync) {
  const result = spawn(command, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} 실행에 실패했습니다.`);
  return result.stdout.trim();
}

function checkoutInfo(spawn = spawnSync) {
  const dirty = inspect('git', ['status', '--porcelain', '--untracked-files=normal'], spawn);
  if (dirty) throw new Error('사전검증은 변경 사항이 없는 clean checkout에서만 실행할 수 있습니다.');
  const commit = inspect('git', ['rev-parse', 'HEAD'], spawn);
  if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error('현재 commit SHA를 확인할 수 없습니다.');
  return commit;
}

function ensureProjectInfraStopped(spawn = spawnSync) {
  const services = inspect('docker', ['compose', 'ps', '--status', 'running', '--services'], spawn);
  if (services) {
    throw new Error(`실행 중인 프로젝트 Compose 서비스가 있습니다(${services.replace(/\s+/g, ', ')}). 전용 환경에서 다시 실행하세요.`);
  }
}

function execute(dependencies = {}) {
  const runCommand = dependencies.runCommand || run;
  const getCommit = dependencies.checkout || checkoutInfo;
  const ensureStopped = dependencies.ensureStopped || ensureProjectInfraStopped;
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (!Number.isInteger(nodeMajor) || nodeMajor < minimumNodeMajor) {
    throw new Error(`Node.js ${minimumNodeMajor}+가 필요합니다. 현재 ${process.versions.node}`);
  }

  const commit = getCommit();
  let failure;
  let infraAttempted = false;
  try {
    runCommand(['run', 'lint']);
    // Codex/CI의 TERM=dumb가 OSC 8 지원 테스트를 무효화하지 않도록 지원 터미널 조건을 명시한다.
    runCommand(['test'], { env: { TERM: 'xterm' } });
    runCommand(['run', 'typecheck']);
    runCommand(['run', 'api:build']);
    ensureStopped();
    infraAttempted = true;
    runCommand(['run', 'infra:up']);
    runCommand(['run', 'api:e2e']);
    runCommand(['run', 'infra:test-redis-persistence']);
  } catch (error) {
    failure = error;
  } finally {
    if (infraAttempted) {
      try {
        runCommand(['run', 'infra:down']);
      } catch (cleanupError) {
        if (!failure) failure = cleanupError;
        else console.error(`[preflight] 인프라 정리 실패: ${cleanupError.message}`);
      }
    }
  }
  if (failure) throw failure;
  const endingCommit = getCommit();
  if (endingCommit !== commit) throw new Error('사전검증 중 checkout commit이 변경됐습니다.');
  return {
    schemaVersion: 1,
    issueKey: 'CLAW-64',
    commit,
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    completedAt: new Date().toISOString(),
    checks: ['lint', 'node-test', 'typecheck', 'api-build', 'api-e2e', 'redis-persistence'],
  };
}

function atomicWrite(file, value) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
}

function main(argv) {
  if (!argv[0]) throw new Error('OS별 preflight manifest 저장 경로를 전달하세요.');
  const manifest = execute();
  atomicWrite(argv[0], manifest);
  console.log(`\nALPHA_PREFLIGHT_PASS commit=${manifest.commit} platform=${manifest.platform} arch=${manifest.arch} node=${manifest.node}`);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`ALPHA_PREFLIGHT_FAIL ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { checkoutInfo, ensureProjectInfraStopped, execute };
