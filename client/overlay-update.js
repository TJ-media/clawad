'use strict';

// 오버레이 갱신 (CLAW-160). 오버레이가 이 스크립트를 분리 실행하고 스스로 종료하면,
// 여기서 종료를 기다렸다가 교체하고 다시 띄운다.
//
// **왜 CLI가 하는가**
//   1) 격리 속성 — 브라우저로 받으면 macOS가 com.apple.quarantine을 붙이고, 무서명 빌드는
//      Gatekeeper에 막힌다. Node로 받아 ditto로 풀면 애초에 붙지 않는다 (overlay-install.js 헤더).
//   2) 자기 교체 회피 — 실행 중인 앱이 자기 번들을 지우면 그 순간 자기 코드도 사라진다.
//      교체 주체가 앱 밖에 있으면 실패해도 구 버전을 되돌릴 수 있다.
//
// 오버레이가 꺼지지 않으면 교체하지 않는다. 반쯤 교체된 앱을 만드는 것보다 갱신을 미루는 편이 낫다.

const path = require('path');
const { spawn, spawnSync } = require('child_process');

const { installOverlay } = require('./overlay-install');
const { overlayManifestUrl } = require('./distribution-config');

/** 오버레이가 꺼지기를 기다리는 한도. 사용자가 종료를 취소하면 여기서 포기한다. */
const QUIT_TIMEOUT_MS = 60 * 1000;
const POLL_INTERVAL_MS = 500;
const PRODUCT_PATTERN = /^[A-Za-z0-9._-]+$/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 오버레이가 실행 중인가. 설치 경로로 시작하는 프로세스만 센다 — 이름만 같은 다른 프로세스를
 * 세면 영영 기다리게 된다.
 */
function isRunning(productName, platform = process.platform, run = spawnSync) {
  if (!PRODUCT_PATTERN.test(productName)) return false;
  if (platform !== 'darwin') return false;
  const result = run('/usr/bin/pgrep', ['-f', `${productName}.app/Contents/MacOS/`], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: false, timeout: 5000,
  });
  return !!(result && typeof result.stdout === 'string' && result.stdout.trim());
}

async function waitForExit(productName, options = {}) {
  const platform = options.platform || process.platform;
  const run = options.spawnSync || spawnSync;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : QUIT_TIMEOUT_MS;
  const intervalMs = Number.isFinite(options.intervalMs) ? options.intervalMs : POLL_INTERVAL_MS;
  const wait = options.sleep || sleep;
  const now = options.now || (() => Date.now());

  const deadline = now() + timeoutMs;
  while (isRunning(productName, platform, run)) {
    if (now() >= deadline) return false;
    await wait(intervalMs);
  }
  return true;
}

/** 교체가 끝난 뒤 다시 띄운다. 실패해도 갱신 자체는 성공이다 — 사용자가 직접 열면 된다. */
function relaunch(productName, options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'darwin') return false;
  if (!PRODUCT_PATTERN.test(productName)) return false;
  try {
    const launch = options.spawn || spawn;
    const child = launch('/usr/bin/open', ['-a', `${productName}.app`], {
      stdio: 'ignore', detached: true, shell: false,
    });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * 갱신 한 번. throw하지 않는다 — 분리 실행이라 예외를 볼 사람이 없다.
 * status: updated | up-to-date | busy | skipped | unsupported | failed
 */
async function updateOverlay(options = {}) {
  const platform = options.platform || process.platform;
  const log = typeof options.log === 'function' ? options.log : () => {};
  const productName = options.productName || 'Claw-Ad';

  // Windows는 electron-updater가 서명 없이도 설치까지 한다. CLI가 낄 이유가 없다.
  if (platform !== 'darwin') return { status: 'unsupported', reason: 'platform', platform };

  const manifestUrl = options.manifestUrl || overlayManifestUrl();
  if (!manifestUrl) return { status: 'skipped', reason: 'no-manifest-url' };

  log('오버레이 종료를 기다립니다…');
  const exited = await (options.waitForExit || waitForExit)(productName, options);
  if (!exited) {
    log('오버레이가 종료되지 않아 갱신을 미룹니다.');
    return { status: 'busy', reason: 'still-running', productName };
  }

  const result = await (options.installOverlay || installOverlay)({
    ...options,
    manifestUrl,
    allowUpgrade: true,
    log,
  });

  if (result.status === 'installed') {
    log(`오버레이를 v${result.version}으로 갱신했습니다.`);
    (options.relaunch || relaunch)(result.productName || productName, options);
    return { status: 'updated', version: result.version };
  }
  if (result.status === 'skipped' && result.reason === 'up-to-date') {
    log('오버레이가 이미 최신입니다.');
    (options.relaunch || relaunch)(productName, options);
    return { status: 'up-to-date', version: result.version };
  }

  // 갱신에 실패했어도 앱은 다시 띄운다. 구 버전이 제자리에 남아 있다.
  log(`오버레이를 갱신하지 못했습니다: ${result.message || result.reason || result.status}`);
  (options.relaunch || relaunch)(productName, options);
  return result;
}

module.exports = { isRunning, relaunch, updateOverlay, waitForExit };

if (require.main === module) {
  updateOverlay({ log: (line) => console.log(line) })
    .then((result) => {
      process.exitCode = result.status === 'updated' || result.status === 'up-to-date' ? 0 : 1;
    })
    .catch((err) => {
      console.error(`오버레이 갱신 중 오류: ${err && err.message}`);
      process.exitCode = 1;
    });
}
