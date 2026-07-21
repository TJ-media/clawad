'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { backupDir, runCompose } = require('./lib/production-compose');

const ROOT_DIR = path.resolve(__dirname, '..');
const DEPLOY_ENV_FILE = path.join(ROOT_DIR, 'deploy', 'production', '.env');
const SHA_PATTERN = /^[0-9a-f]{40}$/;

function assertSha(name, value) {
  if (!SHA_PATTERN.test(value || '') || new Set(value).size === 1) {
    throw new Error(`${name}는 placeholder가 아닌 40자리 소문자 Git commit SHA여야 합니다.`);
  }
  return value;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    windowsHide: true,
    stdio: options.capture ? 'pipe' : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(options.failureMessage || `${command} 명령이 실패했습니다.`);
  return options.capture ? result.stdout.trim() : '';
}

function readDeployEnv() {
  let raw;
  try {
    raw = fs.readFileSync(DEPLOY_ENV_FILE, 'utf8').replace(/^\uFEFF/, '');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new Error('deploy/production/.env가 없습니다. .env.example을 기준으로 접근 제한된 파일을 만드세요.');
    }
    throw error;
  }
  const configuredBackupDir = valueFromEnv(raw, 'BACKUP_DIR');
  if (configuredBackupDir && !process.env.BACKUP_DIR) process.env.BACKUP_DIR = configuredBackupDir;
  return raw;
}

function valueFromEnv(raw, key) {
  const line = raw.split(/\r?\n/).find((entry) => entry.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : '';
}

function withReleaseValues(raw, releaseSha, rollbackSha) {
  const values = { RELEASE_SHA: releaseSha, ROLLBACK_SHA: rollbackSha };
  const found = new Set();
  const lines = raw.split(/\r?\n/).map((line) => {
    for (const [key, value] of Object.entries(values)) {
      if (line.startsWith(`${key}=`)) {
        found.add(key);
        return `${key}=${value}`;
      }
    }
    return line;
  });
  for (const [key, value] of Object.entries(values)) {
    if (!found.has(key)) lines.push(`${key}=${value}`);
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

function writeAtomic(file, body, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, body, { mode });
    try { fs.chmodSync(temporary, mode); } catch (error) { if (process.platform !== 'win32') throw error; }
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
}

function setProcessRelease(releaseSha, rollbackSha) {
  process.env.RELEASE_SHA = releaseSha;
  process.env.ROLLBACK_SHA = rollbackSha;
}

function inspectLiveService(service) {
  const containerId = runCompose(['ps', '-q', service], { capture: true, failureMessage: `운영 ${service} 컨테이너 조회 실패` });
  if (!containerId) return null;
  // 현재 revision은 compose 환경값/서비스 label이 아니라 실제 container image ID에서 읽는다.
  const format = ['{{.Image}}', '{{index .Config.Labels "ai.clawad.rollback-revision"}}'].join('|');
  const output = run('docker', ['inspect', '--format', format, containerId], {
    capture: true,
    failureMessage: `운영 ${service} release label 조회 실패`,
  });
  const [imageId, rollback] = output.split('|');
  // 이 기능 도입 전의 legacy 컨테이너에는 release label이 없다. 최초 전환 배포에서만
  // 미관리 상태로 취급한다. 다만 이 이미지는 호환 baseline 없이는 rollback에 쓸 수 없다.
  if (!imageId || !rollback) return null;
  const current = inspectImageId(imageId, undefined, service);
  return { current: assertSha('live current release', current), rollback: assertSha('live rollback release', rollback) };
}

function inspectLive() {
  const api = inspectLiveService('api');
  const web = inspectLiveService('user-web');
  const edge = inspectLiveService('caddy');
  if (!api && !web && !edge) return null;
  if (!api || !web || !edge || api.current !== web.current || api.current !== edge.current
    || api.rollback !== web.rollback || api.rollback !== edge.rollback) {
    throw new Error('운영 API·user-web·HTTPS edge release label이 다릅니다. 부분 배포 상태에서 배포·rollback을 중단합니다.');
  }
  return api;
}

function inspectImageId(imageId, expected, service = 'api') {
  const format = [
    '{{index .Config.Labels "org.opencontainers.image.revision"}}',
    '{{index .Config.Labels "ai.clawad.emergency-stop-compatible"}}',
  ].join('|');
  const output = run('docker', ['image', 'inspect', '--format', format, imageId], {
    capture: true,
    failureMessage: `${service} 이미지의 release label을 확인할 수 없습니다.`,
  });
  const [revision, emergencyStopCompatible] = output.split('|');
  const checkedRevision = assertSha('image revision label', revision);
  if (expected && checkedRevision !== expected) {
    throw new Error(`${service} 이미지의 불변 revision label이 tag(${expected})와 다릅니다.`);
  }
  if (service === 'api' && emergencyStopCompatible !== 'true') {
    throw new Error('API 이미지는 긴급 중지 호환성이 검증되지 않아 배포·rollback 대상으로 사용할 수 없습니다.');
  }
  return checkedRevision;
}

function inspectImage(sha, service = 'api') {
  const expected = assertSha('image release', sha);
  const imageRef = `clawad-${service}:${expected}`;
  const imageId = run('docker', ['image', 'inspect', '--format', '{{.Id}}', imageRef], {
    capture: true,
    failureMessage: `${service} 이미지 ${imageRef}를 로컬에서 확인할 수 없습니다.`,
  });
  inspectImageId(imageId, expected, service);
  return imageId;
}

function inspectReleaseImages(sha) {
  inspectImage(sha, 'api');
  inspectImage(sha, 'user-web');
}

function stateFile() {
  return path.join(backupDir(), 'release-state.json');
}

function readState() {
  try {
    const value = JSON.parse(fs.readFileSync(stateFile(), 'utf8').replace(/^\uFEFF/, ''));
    if (value.version !== 1) throw new Error();
    if (typeof value.deployedAt !== 'string' || new Date(value.deployedAt).toISOString() !== value.deployedAt) {
      throw new Error();
    }
    return {
      current: assertSha('state current release', value.current),
      rollback: assertSha('state rollback release', value.rollback),
      deployedAt: value.deployedAt,
    };
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw new Error('release-state.json이 없거나 손상되었습니다. 운영 release label과 대조해 복구하세요.');
  }
}

function recordState(current, rollback) {
  const body = JSON.stringify({ version: 1, current, rollback, deployedAt: new Date().toISOString() }, null, 2);
  writeAtomic(stateFile(), `${body}\n`);
}

function backup() {
  run(process.execPath, [path.join(__dirname, 'production-backup.js')], {
    failureMessage: '배포 전 PostgreSQL 백업에 실패했습니다.',
  });
}

function smoke(apiOrigin, webOrigin, releaseSha) {
  if (!apiOrigin || !webOrigin) throw new Error('공개 HTTPS API와 user-web origin을 전달하세요.');
  run(process.execPath, [path.join(__dirname, 'production-smoke.js'), apiOrigin, webOrigin, releaseSha], {
    failureMessage: '배포 후 공개 API·user-web smoke test에 실패했습니다.',
  });
}

function prepareEnv(raw, current, rollback) {
  writeAtomic(DEPLOY_ENV_FILE, withReleaseValues(raw, current, rollback));
  setProcessRelease(current, rollback);
}

function restoreEnv(raw, current, rollback) {
  writeAtomic(DEPLOY_ENV_FILE, withReleaseValues(raw, current, rollback));
  setProcessRelease(current, rollback);
}

function status() {
  const raw = readDeployEnv();
  const live = inspectLive();
  if (!live) throw new Error('실행 중인 운영 API 컨테이너가 없습니다.');
  const configured = {
    current: assertSha('configured RELEASE_SHA', valueFromEnv(raw, 'RELEASE_SHA')),
    rollback: assertSha('configured ROLLBACK_SHA', valueFromEnv(raw, 'ROLLBACK_SHA')),
  };
  if (configured.current !== live.current || configured.rollback !== live.rollback) {
    throw new Error('운영 .env와 실행 중인 API release label이 다릅니다. 재기동 전에 drift를 해소하세요.');
  }
  inspectReleaseImages(configured.rollback);
  const state = readState();
  if (state && (state.current !== live.current || state.rollback !== live.rollback)) {
    throw new Error('release-state.json과 실행 중인 API release label이 다릅니다.');
  }
  console.log(`현재 배포 commit: ${live.current}`);
  console.log(`rollback 대상 commit: ${live.rollback}`);
  console.log(`release 상태 기록: ${state ? state.deployedAt : '없음(다음 성공 배포에서 생성)'}`);
}

function deploy(releaseSha, rollbackSha, apiOrigin, webOrigin) {
  assertSha('RELEASE_SHA', releaseSha);
  assertSha('ROLLBACK_SHA', rollbackSha);
  if (releaseSha === rollbackSha) throw new Error('RELEASE_SHA와 ROLLBACK_SHA는 달라야 합니다.');
  const head = run('git', ['rev-parse', 'HEAD'], { capture: true, failureMessage: '현재 Git commit을 확인할 수 없습니다.' });
  if (head !== releaseSha) throw new Error(`현재 checkout(${head})과 RELEASE_SHA가 다릅니다.`);
  const worktree = run('git', ['status', '--porcelain', '--untracked-files=normal'], {
    capture: true,
    failureMessage: '현재 Git 작업 트리 상태를 확인할 수 없습니다.',
  });
  if (worktree) {
    throw new Error('Git 작업 트리에 미커밋 파일이 있습니다. release commit과 이미지 내용의 일치를 위해 배포를 거부했습니다.');
  }

  const raw = readDeployEnv();
  const live = inspectLive();
  if (live && live.current !== rollbackSha) {
    throw new Error(`지정한 ROLLBACK_SHA가 현재 배포 commit(${live.current})과 다릅니다.`);
  }
  // 긴급 중지를 모르는 구 이미지는 active/history row를 무시해 과금·적립을 재개할 수 있다.
  // 실제 image metadata가 현재 tag와 일치하고 gate 구현을 포함한다고 선언한 경우만 허용한다.
  inspectReleaseImages(rollbackSha);
  // 최초 전환 실패 시 검증되지 않은 새 release를 rollback 대상으로 기록하지 않는다.
  // 이전 세대에는 별도 rollback image가 없으므로 현재 정상 image 자신을 가리킨다.
  const previous = live || { current: rollbackSha, rollback: rollbackSha };

  backup();
  prepareEnv(raw, releaseSha, rollbackSha);
  try {
    runCompose(['build', 'api', 'user-web'], { failureMessage: '새 API·user-web 이미지 build에 실패했습니다.' });
    inspectReleaseImages(releaseSha);
    runCompose(['up', '-d', '--wait'], { failureMessage: '새 release 기동에 실패했습니다.' });
    smoke(apiOrigin || process.env.CLAWAD_API_URL, webOrigin || process.env.CLAWAD_WEB_URL, releaseSha);
    recordState(releaseSha, rollbackSha);
    console.log(`운영 배포 완료: ${releaseSha} (rollback ${rollbackSha})`);
  } catch (error) {
    restoreEnv(raw, previous.current, previous.rollback);
    try {
      inspectReleaseImages(previous.current);
      runCompose(['up', '-d', '--wait', '--no-build'], { failureMessage: '자동 rollback 기동에 실패했습니다.' });
      smoke(apiOrigin || process.env.CLAWAD_API_URL, webOrigin || process.env.CLAWAD_WEB_URL, previous.current);
      recordState(previous.current, previous.rollback);
    } catch (rollbackError) {
      throw new Error(`배포 실패(${error.message}) 후 자동 rollback도 실패했습니다: ${rollbackError.message}`);
    }
    throw new Error(`배포 검증 실패로 ${previous.current}에 rollback했습니다: ${error.message}`);
  }
}

function rollback(apiOrigin, webOrigin) {
  const raw = readDeployEnv();
  const live = inspectLive();
  if (!live) throw new Error('rollback할 실행 중 API 컨테이너가 없습니다.');
  inspectReleaseImages(live.rollback);
  backup();
  prepareEnv(raw, live.rollback, live.current);
  try {
    runCompose(['up', '-d', '--wait', '--no-build'], { failureMessage: 'rollback release 기동에 실패했습니다.' });
    smoke(apiOrigin || process.env.CLAWAD_API_URL, webOrigin || process.env.CLAWAD_WEB_URL, live.rollback);
    recordState(live.rollback, live.current);
    console.log(`운영 rollback 완료: ${live.rollback} (되돌림 대상 ${live.current})`);
  } catch (error) {
    restoreEnv(raw, live.current, live.rollback);
    try {
      inspectReleaseImages(live.current);
      runCompose(['up', '-d', '--wait', '--no-build'], { failureMessage: '실패한 rollback의 원 release 복구에 실패했습니다.' });
      smoke(apiOrigin || process.env.CLAWAD_API_URL, webOrigin || process.env.CLAWAD_WEB_URL, live.current);
      recordState(live.current, live.rollback);
    } catch (recoveryError) {
      throw new Error(`rollback 실패(${error.message}) 후 원 release 복구도 실패했습니다: ${recoveryError.message}`);
    }
    throw new Error(`rollback 검증 실패로 원 release ${live.current}을 복구했습니다: ${error.message}`);
  }
}

function usage() {
  console.error('사용법: production-release.js status | deploy <releaseSha> <rollbackSha> <apiHttpsOrigin> <webHttpsOrigin> | rollback <apiHttpsOrigin> <webHttpsOrigin>');
  process.exitCode = 2;
}

try {
  const [, , command, ...args] = process.argv;
  if (command === 'status' && args.length === 0) status();
  else if (command === 'deploy' && (args.length === 2 || args.length === 4)) deploy(args[0], args[1], args[2], args[3]);
  else if (command === 'rollback' && (args.length === 0 || args.length === 2)) rollback(args[0], args[1]);
  else usage();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
