'use strict';

// CLAW-133: 오버레이 앱(clawad-overlay)을 CLI 설치 흐름 안에서 함께 설치한다.
// CLAW-92: macOS를 같은 흐름에 넣는다. 플랫폼별 산출물은 매니페스트의 artifacts에서 고른다.
//
// 두 산출물을 하나의 파일로 묶지 않는다 — 각자의 저장소 릴리스에서 따로 배포하고
// 설치 흐름만 잇는다. 오버레이는 AGPL-3.0이고 이 저장소는 비오픈소스라, 하나의
// 결합 저작물로 배포하면 카피레프트가 서버 코드로 번질 위험이 있다
// (clawad-overlay/docs/BOUNDARY.md, 규칙 §8).
//
// 신뢰 경로는 CLI가 자기 tarball을 받을 때와 같다: 매니페스트를 조회해
// SHA-256을 대조한 뒤에만 실행한다. release.js의 secureUrl·download·sha256을 쓴다.
//
// 서명 상태: 알파는 무서명으로 배포한다(CLAW-95의 예외 조항). Gatekeeper·SmartScreen
// 우회를 코드로 시도하지 않는다 — quarantine 속성이나 MOTW를 지우지 않는다. 우리가
// 내려받아 푼 파일에는 애초에 붙지 않을 뿐이고, 그 동작에 기대는 것은 방책이 아니다
// (CLAW-92 참고). 서명을 취득하면 매니페스트 형식은 그대로 두고 빌드만 바꾸면 된다.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { download, secureUrl, sha256 } = require('./release');

// 인스톨러는 100 MB를 넘는다. release.js의 기본 상한(50 MB)은 CLI tarball 기준이므로
// 여기서만 따로 둔다. 매니페스트의 bytes와 대조하므로 이 값은 방어 한계일 뿐이다.
const MAX_INSTALLER_BYTES = 300 * 1024 * 1024;
// 정상 설치가 약 45초 걸린다(CLAW-144 실측). 멈춘 인스톨러가 CLI를 무한히 붙잡지 않도록
// 넉넉히 잡되 반드시 끊는다. 서버 정책값이 아니라 클라이언트 방어 한계라 여기 둔다.
const INSTALLER_TIMEOUT_MS = 5 * 60 * 1000;
// 종료 코드 숫자만으로는 일시적 장애·백신 차단·권한 취소를 구분할 수 없다(CLAW-144).
// 알려진 값만 사람이 읽을 수 있게 옮기고, 다시 시도해 볼 가치가 있는지도 함께 정한다.
// 사용자가 스스로 취소한 경우를 되풀이하지 않기 위해 retryable을 나눈다.
const KNOWN_INSTALLER_EXITS = new Map([
  [1, { text: '설치가 취소됐습니다', retryable: false }],
  [2, { text: '인스톨러가 실행을 거부했습니다. 백신·보안 정책이 막았을 수 있습니다', retryable: false }],
  [1223, { text: '관리자 권한 요청이 취소됐습니다', retryable: false }],
  [3221225477, { text: '액세스 위반(0xC0000005). 오버레이가 실행 중이거나 이전 설치·업데이트가 정리되지 않았을 수 있습니다', retryable: true }],
]);
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
// 무인 실행 인수는 매니페스트가 정하지만, 임의 문자열을 그대로 넘기지 않는다.
const ALLOWED_SILENT_ARGS = new Set(['/S', '/SILENT', '/VERYSILENT', '/NCRC']);
// 제품명은 파일 경로와 osascript 인수로 쓰이므로 형태를 좁게 고정한다.
const PRODUCT_PATTERN = /^[A-Za-z0-9._-]+$/;
// 산출물 이름 규칙. clawad-overlay의 electron-builder artifactName과 짝을 이룬다.
//   win32: Claw-Ad-Setup-0.1.2-x64.exe   (build.win.artifactName)
//   darwin: Claw-Ad-0.1.2-arm64.zip      (build.mac.artifactName, zip 타깃)
const INSTALLER_NAME_PATTERNS = {
  nsis: /^(?<product>[A-Za-z0-9._-]+)-Setup-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?-(?<arch>[A-Za-z0-9]+)\.exe$/,
  zip: /^(?<product>[A-Za-z0-9._-]+)-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?-(?<arch>[A-Za-z0-9]+)\.zip$/,
};
// 플랫폼별로 받아들이는 설치 방식. 매니페스트가 엉뚱한 조합을 보내면 실행하지 않는다.
const PLATFORM_KINDS = { win32: 'nsis', darwin: 'zip' };

function artifactKey(platform, arch) {
  return `${platform}-${arch}`;
}

// 게시된 v0.1.1까지의 매니페스트는 플랫폼 하나를 평평하게 담았다. 새 CLI가 옛 매니페스트를
// 만나도 동작하도록 같은 모양으로 변환해서 읽는다 — 릴리스 순서에 의존하지 않기 위해서다.
function artifactsOf(value) {
  if (value.artifacts && typeof value.artifacts === 'object') return value.artifacts;
  const platform = typeof value.platform === 'string' ? value.platform : 'win32';
  const arch = typeof value.arch === 'string' ? value.arch : 'x64';
  return {
    [artifactKey(platform, arch)]: {
      installerUrl: value.installerUrl,
      sha256: value.sha256,
      bytes: value.bytes,
      silentArgs: value.silentArgs,
      productName: value.productName,
      kind: 'nsis',
    },
  };
}

/**
 * 매니페스트에서 현재 플랫폼·아키텍처에 맞는 산출물 하나를 골라 검증한다.
 * target을 주지 않으면 실행 중인 프로세스 기준으로 고른다.
 */
function readManifestFields(value, target = {}) {
  if (!value || typeof value !== 'object') throw new Error('오버레이 매니페스트를 읽을 수 없습니다.');
  if (!VERSION_PATTERN.test(value.version || '')) throw new Error('오버레이 매니페스트의 version이 올바르지 않습니다.');

  const platform = target.platform || process.platform;
  const arch = target.arch || process.arch;
  const expectedKind = PLATFORM_KINDS[platform];
  if (!expectedKind) throw new Error(`오버레이가 지원하지 않는 플랫폼입니다: ${platform}`);

  const artifacts = artifactsOf(value);
  const entry = artifacts[artifactKey(platform, arch)];
  if (!entry || typeof entry !== 'object') {
    throw new Error(`오버레이 매니페스트에 ${artifactKey(platform, arch)} 산출물이 없습니다.`);
  }

  const kind = typeof entry.kind === 'string' ? entry.kind : expectedKind;
  if (kind !== expectedKind) {
    throw new Error(`${platform}에서 지원하지 않는 설치 방식입니다: ${kind}`);
  }

  const url = secureUrl(entry.installerUrl, 'installerUrl');
  if (!SHA256_PATTERN.test(entry.sha256 || '')) throw new Error('오버레이 매니페스트의 SHA-256이 올바르지 않습니다.');

  const bytes = Number(entry.bytes);
  if (!Number.isInteger(bytes) || bytes <= 0 || bytes > MAX_INSTALLER_BYTES) {
    throw new Error('오버레이 매니페스트의 bytes가 올바르지 않습니다.');
  }

  // zip은 인스톨러를 실행하지 않고 풀기만 하므로 인수를 받지 않는다. 인수가 실려 오면
  // 매니페스트가 다른 설치 방식을 의도한 것이라 보고 거절한다.
  let silentArgs = [];
  if (kind === 'nsis') {
    silentArgs = Array.isArray(entry.silentArgs) ? entry.silentArgs : ['/S'];
    for (const arg of silentArgs) {
      if (typeof arg !== 'string' || !ALLOWED_SILENT_ARGS.has(arg)) {
        throw new Error(`오버레이 매니페스트의 silentArgs에 허용되지 않은 값이 있습니다: ${String(arg)}`);
      }
    }
  } else if (Array.isArray(entry.silentArgs) && entry.silentArgs.length) {
    throw new Error(`${kind} 산출물에는 silentArgs를 쓸 수 없습니다.`);
  }

  // 설치 여부 판정과 실행 파일 이름은 제품명에서 나온다. 매니페스트가 명시하면 그것을 쓰고,
  // 없으면 인스톨러 파일명에서 끌어낸다 — 이름을 코드에 박지 않는다.
  const fileName = decodeURIComponent(url.pathname.split('/').pop() || '');
  const matched = INSTALLER_NAME_PATTERNS[kind].exec(fileName);
  const product = typeof entry.productName === 'string' && entry.productName
    ? entry.productName
    : (matched && matched.groups.product);
  if (!product) throw new Error(`오버레이 인스톨러 파일명에서 제품명을 얻지 못했습니다: ${fileName}`);
  if (!PRODUCT_PATTERN.test(product)) throw new Error(`오버레이 제품명에 쓸 수 없는 문자가 있습니다: ${product}`);

  return {
    version: value.version,
    installerUrl: url.href,
    sha256: entry.sha256,
    bytes,
    kind,
    silentArgs,
    fileName,
    productName: product,
    platform,
    arch,
    sourceUrl: typeof value.sourceUrl === 'string' ? value.sourceUrl : '',
    license: typeof value.license === 'string' ? value.license : '',
    // 경량 업데이트 (CLAW-161). **선택 항목이다** — 구 릴리스 매니페스트에는 없고,
    // 없으면 전체 교체로 간다.
    runtimeId: typeof value.runtimeId === 'string' && SHA256_PATTERN.test(value.runtimeId)
      ? value.runtimeId
      : '',
    codeUpdate: readCodeUpdate(value, platform, arch),
  };
}

/**
 * app.asar만 갈아끼우는 경로의 자산 (CLAW-161). 형식이 조금이라도 어긋나면 통째로 버린다 —
 * 잘못 갈면 다른 Electron 위에 우리 코드가 얹혀 앱이 켜지지 않는다. 전체 교체가 안전한 기본값이다.
 */
function readCodeUpdate(value, platform, arch) {
  const block = value && value.codeUpdate;
  if (!block || typeof block !== 'object') return null;
  const entry = block[artifactKey(platform, arch)];
  if (!entry || typeof entry !== 'object') return null;
  if (!SHA256_PATTERN.test(entry.sha256 || '')) return null;
  const bytes = Number(entry.bytes);
  if (!Number.isInteger(bytes) || bytes <= 0 || bytes > MAX_INSTALLER_BYTES) return null;
  let url;
  try {
    url = secureUrl(entry.url, 'codeUpdate.url');
  } catch {
    return null;
  }
  if (!/\.asar$/i.test(url.pathname)) return null;
  return { url: url.href, sha256: entry.sha256, bytes };
}

/**
 * 설치 폴더와 설치 여부를 판정할 경로.
 *   win32: electron-builder NSIS perMachine:false 기본 위치
 *   darwin: 사용자 Applications — 관리자 권한 없이 쓸 수 있어야 한다(규칙 §7)
 */
function installedPaths(productName, env = process.env, platform = process.platform) {
  if (platform === 'darwin') {
    const dir = path.join(env.HOME || os.homedir(), 'Applications');
    return { dir, target: path.join(dir, `${productName}.app`) };
  }
  const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const dir = path.join(localAppData, 'Programs', productName);
  return { dir, target: path.join(dir, `${productName}.exe`) };
}

/**
 * 설치본 버전. macOS는 번들 Info.plist에서 실제 버전을 읽는다 — 업그레이드 여부를 판단해야
 * 하기 때문이다 (CLAW-160). 그 전에는 오버레이 자체 자동 업데이트에 맡겼으나, 무서명 빌드는
 * 브라우저를 거치면 격리 속성이 붙어 Gatekeeper에 막힌다. 갱신을 CLI가 맡으면서 버전 비교도
 * 여기로 왔다.
 *
 * Windows는 실행 파일 버전을 읽으려면 외부 도구가 필요하다. 설치 여부만 돌려주고 갱신 판단은
 * 하지 않는다 — NSIS는 electron-updater가 서명 없이도 설치까지 하므로 CLI가 낄 이유가 없다.
 */
function readInstalledVersion(productName, env = process.env, platform = process.platform, run = spawnSync) {
  const { target } = installedPaths(productName, env, platform);
  if (!fs.existsSync(target)) return null;
  if (platform !== 'darwin') return 'installed';
  const plist = path.join(target, 'Contents', 'Info.plist');
  if (!fs.existsSync(plist)) return 'installed';
  // defaults는 macOS 기본 도구다(ditto와 같은 이유). XML·바이너리 plist를 모두 읽는다.
  const result = run('/usr/bin/defaults', ['read', plist, 'CFBundleShortVersionString'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: false, timeout: 10000,
  });
  const value = result && typeof result.stdout === 'string' ? result.stdout.trim() : '';
  return VERSION_PATTERN.test(value) ? value : 'installed';
}

async function fetchManifest(manifestUrl, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const response = await fetchImpl(secureUrl(manifestUrl, '오버레이 매니페스트 URL').href);
  if (!response.ok) throw new Error(`오버레이 매니페스트 조회 실패 (HTTP ${response.status})`);
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new Error('오버레이 매니페스트가 올바른 JSON이 아닙니다.');
  }
  return readManifestFields(parsed, { platform: deps.platform, arch: deps.arch });
}

// 알려진 종료 코드는 해석해서 돌려주고, 모르는 코드는 숫자를 남긴 채 한 번은 더 시도한다.
// 코드 숫자를 항상 메시지에 남긴다 — 해석이 틀렸을 때 원본 값이 사라지면 진단이 더 어려워진다.
function describeInstallerExit(code) {
  const known = KNOWN_INSTALLER_EXITS.get(code);
  if (known) return { message: `${known.text} (코드 ${code}).`, retryable: known.retryable };
  return { message: `인스톨러가 코드 ${code}로 종료했습니다.`, retryable: true };
}

// NSIS 인스톨러를 무인 실행한다. 멈추면 타임아웃으로 끊고, 일시적으로 보이는 실패만 한 번 더 시도한다.
function runNsisInstaller(installerPath, manifest, run, log = () => {}) {
  const attempt = () => {
    const result = run(installerPath, manifest.silentArgs, {
      stdio: 'ignore', windowsHide: true, shell: false, timeout: INSTALLER_TIMEOUT_MS,
    });
    // spawnSync는 타임아웃을 error(ETIMEDOUT)로 알린다. status보다 먼저 본다.
    if (result.error) {
      const timedOut = result.error.code === 'ETIMEDOUT';
      return {
        ok: false,
        retryable: timedOut,
        message: timedOut
          ? `인스톨러가 ${INSTALLER_TIMEOUT_MS / 1000}초 안에 끝나지 않아 중단했습니다.`
          : result.error.message,
      };
    }
    if (result.status !== 0) return { ok: false, ...describeInstallerExit(result.status) };
    return { ok: true };
  };

  const first = attempt();
  if (first.ok || !first.retryable) return first;
  // 재시도는 정확히 한 번이다. 무한 루프가 되면 CLI 설치를 붙잡는다(CLAW-144 예외 조항).
  log('  오버레이 설치에 실패해 한 번만 다시 시도합니다…');
  const second = attempt();
  if (second.ok) return second;
  return { ok: false, message: `${second.message} (2회 시도했습니다.)` };
}

/**
 * 설치 기록 (CLAW-161). 다음 갱신에서 "프레임워크·네이티브가 그대로인가"를 판단할 근거다.
 * 앱 번들 **밖에** 둔다 — 번들 안에 두면 교체할 때 함께 날아간다.
 *
 * 없으면(손으로 깔았거나 구 CLI가 깔았거나) 전체 교체로 간다. 모르는 상태에서 asar만 갈면
 * 다른 Electron 위에 우리 코드가 얹혀 앱이 켜지지 않는다.
 */
function installRecordPath(productName, env = process.env, platform = process.platform) {
  const { dir } = installedPaths(productName, env, platform);
  return path.join(dir, `.${productName}.install.json`);
}

function readInstallRecord(productName, env = process.env, platform = process.platform) {
  try {
    const raw = fs.readFileSync(installRecordPath(productName, env, platform), 'utf8').replace(/^\uFEFF/, '');
    const value = JSON.parse(raw);
    if (!value || value.version !== 1) return null;
    return {
      appVersion: typeof value.appVersion === 'string' ? value.appVersion : '',
      runtimeId: typeof value.runtimeId === 'string' ? value.runtimeId : '',
    };
  } catch {
    return null;
  }
}

function writeInstallRecord(manifest, env = process.env, platform = process.platform) {
  if (!manifest.runtimeId) return;
  try {
    fs.writeFileSync(
      installRecordPath(manifest.productName, env, platform),
      JSON.stringify({ version: 1, appVersion: manifest.version, runtimeId: manifest.runtimeId }, null, 2) + '\n',
      { mode: 0o600 },
    );
  } catch { /* 기록에 실패해도 설치는 성공이다 — 다음 갱신이 전체 교체로 갈 뿐이다 */ }
}

/**
 * app.asar만 갈아끼운다 (CLAW-161). 358MB 중 우리 코드는 6.8MB뿐이다.
 * 임시 파일로 받아 검증한 뒤 rename한다 — 검증 실패·중단 시 기존 asar가 그대로 남는다.
 */
const GAUGE_WIDTH = 24;

function gaugeLine(percent, received, total) {
  const filled = Math.round((percent / 100) * GAUGE_WIDTH);
  const bar = '█'.repeat(filled) + '░'.repeat(GAUGE_WIDTH - filled);
  const mb = (bytes) => (bytes / 1024 / 1024).toFixed(0);
  return `  [${bar}] ${String(percent).padStart(3)}%  ${mb(received)} / ${mb(total)} MB`;
}

// 100MB가 넘는 다운로드가 한 줄만 찍고 멈춰 있으면 사용자는 죽은 줄 안다 (알파 테스터 제보).
//
// 터미널이면 게이지 한 줄을 캐리지 리턴으로 덮어써 진행을 보여준다. 파이프·CI·로그 파일에서는
// 그 방식이 한 줄에 수백 개 조각으로 뭉치므로, 그때만 주입된 log seam으로 20% 단위 줄을 남긴다.
// 즉 사람이 보는 화면은 게이지, 기록에 남는 것은 다섯 줄이다.
function downloadProgress(log, step = 20, out = process.stdout) {
  const gauge = Boolean(out && out.isTTY && typeof out.write === 'function');
  let shownPercent = -1;
  let markedBytes = 0;
  let painted = false;
  const report = (received, total) => {
    // content-length가 없으면 비율을 모른다. 받은 양만 10MB마다 알린다.
    if (!total) {
      if (received - markedBytes < 10 * 1024 * 1024) return;
      markedBytes = received;
      log(`    ${(received / 1024 / 1024).toFixed(0)} MB 받았습니다…`);
      return;
    }
    const percent = Math.min(Math.floor((received / total) * 100), 100);
    if (percent === shownPercent && received < total) return;
    if (!gauge) {
      // 남기는 줄 수를 묶는다. 100%는 항상 남겨 완료를 기록에서 확인할 수 있게 한다.
      if (percent < shownPercent + step && received < total) return;
      shownPercent = percent - (percent % step);
      log(`    ${percent}% (${(received / 1024 / 1024).toFixed(0)} / ${(total / 1024 / 1024).toFixed(0)} MB)`);
      return;
    }
    shownPercent = percent;
    painted = true;
    out.write(`\r${gaugeLine(percent, received, total)}`);
    // 게이지 줄을 닫아야 다음 출력이 같은 줄에 붙지 않는다.
    if (received >= total) {
      out.write('\n');
      painted = false;
    }
  };
  // 중간에 실패하면 게이지 줄이 열린 채 남아 오류 메시지가 같은 줄에 붙는다. 호출부가 끝에서 닫는다.
  report.done = () => {
    if (!painted) return;
    out.write('\n');
    painted = false;
  };
  return report;
}

function replaceAsar(bytes, manifest, env) {
  const { target } = installedPaths(manifest.productName, env, 'darwin');
  const asar = path.join(target, 'Contents', 'Resources', 'app.asar');
  if (!fs.existsSync(asar)) return { ok: false, message: `교체할 app.asar가 없습니다: ${asar}` };
  const staged = `${asar}.new-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(staged, bytes, { mode: 0o644 });
    fs.renameSync(staged, asar);
    return { ok: true };
  } catch (err) {
    try { fs.rmSync(staged, { force: true }); } catch {}
    return { ok: false, message: `app.asar를 교체하지 못했습니다: ${err.message}` };
  }
}

/**
 * 번들이 스스로 선언하는 버전을 새 버전으로 고친다 (CLAW-216).
 *
 * 경량 갱신은 `app.asar`만 갈아끼우므로 `Contents/Info.plist`는 옛 버전을 그대로 말한다.
 * 그런데 `readInstalledVersion()`이 바로 그 값을 읽는다 — 고치지 않으면 갱신이 끝나도 CLI는
 * 옛 버전이 깔려 있다고 보고 **매번 다시 내려받는다.** macOS Electron의 `app.getVersion()`도
 * 이 값을 읽으므로 오버레이 화면에도 옛 번호가 남아, 두 저장소 버전을 맞춘 의미가 사라진다
 * (CLAW-214).
 *
 * `plutil`은 macOS 기본 도구다(`defaults`·`ditto`와 같은 이유). 파일 형식을 보존해 제자리에서
 * 고친다. `version`은 매니페스트 파싱에서 이미 형식 검증을 거쳤고 인자 배열로 넘기므로
 * 셸 해석이 끼어들지 않는다.
 */
function stampBundleVersion(manifest, env, run = spawnSync) {
  const { target } = installedPaths(manifest.productName, env, 'darwin');
  const plist = path.join(target, 'Contents', 'Info.plist');
  if (!fs.existsSync(plist)) return { ok: false, message: `Info.plist가 없습니다: ${plist}` };
  for (const key of ['CFBundleShortVersionString', 'CFBundleVersion']) {
    const result = run('/usr/bin/plutil', ['-replace', key, '-string', manifest.version, plist], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: false, timeout: 10000,
    });
    if (!result || result.error || result.status !== 0) {
      const detail = (result && typeof result.stderr === 'string' && result.stderr.trim())
        || (result && result.error && result.error.message)
        || `plutil이 ${result && result.status} 코드로 종료했습니다.`;
      return { ok: false, message: `${key}를 고치지 못했습니다: ${detail}` };
    }
  }
  return { ok: true };
}

// zip을 사용자 Applications에 푼다. ditto는 macOS 기본 도구이고 .app 번들 안의
// 심볼릭 링크와 확장 속성을 보존한다 — unzip은 Frameworks의 링크를 망가뜨린다.
function extractMacApp(archivePath, manifest, env, run) {
  const { dir, target } = installedPaths(manifest.productName, env, 'darwin');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    return { ok: false, message: `설치 폴더를 만들지 못했습니다: ${err.message}` };
  }

  // 설치 폴더 **안에** 스테이징한다. rename은 같은 볼륨에서만 원자적이고, os.tmpdir()이
  // 다른 볼륨이면 EXDEV로 실패한다. 갱신 도중 죽어도 구 번들이 제자리에 남아야 한다 (CLAW-160).
  const stamp = `${process.pid}-${Date.now()}`;
  const staging = path.join(dir, `.${manifest.productName}.staging-${stamp}`);
  const backup = path.join(dir, `.${manifest.productName}.old-${stamp}`);
  const staged = path.join(staging, `${manifest.productName}.app`);
  const cleanup = () => {
    for (const p of [staging, backup]) {
      try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
    }
  };

  try {
    fs.mkdirSync(staging, { recursive: true });
  } catch (err) {
    return { ok: false, message: `스테이징 폴더를 만들지 못했습니다: ${err.message}` };
  }

  // 압축 해제도 멈출 수 있다. NSIS와 같은 이유로 반드시 끊는다 (CLAW-144).
  const result = run('/usr/bin/ditto', ['-x', '-k', archivePath, staging], { stdio: 'ignore', shell: false, timeout: INSTALLER_TIMEOUT_MS });
  if (result.error) {
    cleanup();
    return {
      ok: false,
      message: result.error.code === 'ETIMEDOUT'
        ? `압축 해제가 ${INSTALLER_TIMEOUT_MS / 1000}초 안에 끝나지 않아 중단했습니다.`
        : result.error.message,
    };
  }
  if (result.status !== 0) {
    cleanup();
    return { ok: false, message: `압축 해제가 코드 ${result.status}로 종료했습니다.` };
  }
  if (!fs.existsSync(staged)) {
    cleanup();
    return { ok: false, message: `압축을 풀었지만 앱 번들이 없습니다: ${staged}` };
  }

  // 구 번들을 옆으로 밀고 새 것을 들인다. 덮어쓰기가 아니라 교체다 — 덮어쓰면 구 버전에만
  // 있던 파일이 남아 두 버전이 섞인다.
  let moved = false;
  try {
    if (fs.existsSync(target)) {
      fs.renameSync(target, backup);
      moved = true;
    }
    fs.renameSync(staged, target);
  } catch (err) {
    // 새 것을 들이다 실패했으면 구 번들을 반드시 되돌린다.
    if (moved && !fs.existsSync(target)) {
      try { fs.renameSync(backup, target); } catch {}
    }
    // 복원까지 실패했으면 backup은 구 번들의 마지막 사본이다 — cleanup으로 지우면
    // 구 번들도 새 번들도 없는 상태가 된다 (CLAW-270). staging만 지우고 위치를 알린다.
    const restored = !moved || fs.existsSync(target);
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
    if (!restored) {
      return { ok: false, message: `앱 번들을 교체하지 못했고 구 번들 복원도 실패했습니다. 구 번들은 ${backup}에 남아 있습니다. 원인: ${err.message}` };
    }
    try { fs.rmSync(backup, { recursive: true, force: true }); } catch {}
    return { ok: false, message: `앱 번들을 교체하지 못했습니다: ${err.message}` };
  }

  cleanup();
  return { ok: true };
}

/**
 * app.asar만 내려받아 갈아끼운다 (CLAW-161). 실패해도 throw하지 않는다 —
 * 호출부가 전체 교체로 내려간다.
 */
async function installCodeOnly(manifest, env, options, log) {
  const { bytes: expected, sha256: expectedHash, url } = manifest.codeUpdate;
  let bytes;
  const codeProgress = downloadProgress(log);
  try {
    log(`  오버레이 코드만 내려받습니다 (${(expected / 1024 / 1024).toFixed(1)} MB)…`);
    bytes = await (options.download || download)(url, MAX_INSTALLER_BYTES, codeProgress);
  } catch (err) {
    return { status: 'failed', stage: 'download', message: err.message };
  } finally {
    codeProgress.done();
  }
  if (bytes.length !== expected) {
    return { status: 'failed', stage: 'verify', message: `내려받은 크기가 매니페스트와 다릅니다 (${bytes.length} ≠ ${expected}).` };
  }
  if (sha256(bytes) !== expectedHash) {
    return { status: 'failed', stage: 'verify', message: 'app.asar 체크섬이 일치하지 않습니다.' };
  }
  const outcome = (options.replaceAsar || replaceAsar)(bytes, manifest, env);
  if (!outcome.ok) return { status: 'failed', stage: 'run', message: outcome.message };
  // 표기 갱신 실패는 갱신 실패가 아니다 — asar는 이미 새것이라 앱은 새 코드로 돈다.
  // 다만 조용히 넘기지 않는다. 다음 갱신이 같은 버전을 다시 받게 되는 상태라서다 (CLAW-216).
  const stamped = (options.stampBundleVersion || stampBundleVersion)(manifest, env, options.spawnSync || spawnSync);
  if (!stamped.ok) log(`  번들 버전 표기를 고치지 못해 다음 갱신에서 다시 받을 수 있습니다: ${stamped.message}`);
  (options.writeInstallRecord || writeInstallRecord)(manifest, env, 'darwin');
  return {
    status: 'installed',
    mode: 'code-only',
    version: manifest.version,
    productName: manifest.productName,
    sourceUrl: manifest.sourceUrl,
    license: manifest.license,
  };
}

/**
 * 오버레이를 설치한다. 절대 throw하지 않는다 — CLI 설치를 실패시키지 않기 위해
 * 결과를 { status, ... } 로만 돌려준다. status: installed | skipped | unsupported | failed
 */
async function installOverlay(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const log = typeof options.log === 'function' ? options.log : () => {};
  const manifestUrl = options.manifestUrl;

  if (!manifestUrl) return { status: 'skipped', reason: 'no-manifest-url' };
  if (!PLATFORM_KINDS[platform]) {
    return { status: 'unsupported', reason: 'platform', platform };
  }
  if (env.CLAWAD_SKIP_OVERLAY_INSTALL === '1') {
    return { status: 'skipped', reason: 'opt-out' };
  }

  let manifest;
  try {
    manifest = await (options.fetchManifest || fetchManifest)(manifestUrl, { ...options, platform, arch });
  } catch (err) {
    return { status: 'failed', stage: 'manifest', message: err.message };
  }

  if (manifest.platform !== platform) {
    return { status: 'unsupported', reason: 'platform-mismatch', platform, manifestPlatform: manifest.platform };
  }

  const run = options.spawnSync || spawnSync;
  const installed = readInstalledVersion(manifest.productName, env, platform, run);

  // 설치본이 매니페스트와 같은 버전이면 **그 빌드가 맞으므로** 런타임도 매니페스트의 것이다.
  // 내려받지 않는 경로에서도 기록을 남긴다 (CLAW-161). 안 남기면 이미 최신인 사용자는
  // 기록이 영영 안 생겨 경량 경로가 켜지지 않는다 — 매번 123MB를 받게 된다.
  if (installed && installed === manifest.version) {
    (options.writeInstallRecord || writeInstallRecord)(manifest, env, platform);
  }

  // 기본은 예전대로 "있으면 건너뛴다" — setup은 이미 깔린 앱을 다시 내려받지 않는다.
  // allowUpgrade는 갱신 경로(overlay-update.js)만 켠다 (CLAW-160).
  if (installed && !options.allowUpgrade) {
    return { status: 'skipped', reason: 'already-installed', productName: manifest.productName };
  }
  if (installed && installed === manifest.version) {
    return { status: 'skipped', reason: 'up-to-date', productName: manifest.productName, version: installed };
  }

  // 경량 경로 (CLAW-161): Electron·의존성이 그대로면 app.asar만 갈면 된다. 6.8MB로 끝난다.
  // 설치 기록이 없거나 runtimeId가 다르면 전체 교체 — 모르는 상태에서 갈지 않는다.
  if (installed && options.allowUpgrade && platform === 'darwin' && manifest.codeUpdate && manifest.runtimeId) {
    const record = (options.readInstallRecord || readInstallRecord)(manifest.productName, env, platform);
    if (record && record.runtimeId === manifest.runtimeId) {
      const light = await installCodeOnly(manifest, env, options, log);
      // 경량 교체가 실패하면 전체 교체로 내려간다 — 갱신을 포기하지 않는다.
      if (light.status === 'installed') return light;
      log(`  경량 업데이트에 실패해 전체 교체로 진행합니다: ${light.message || light.status}`);
    }
  }

  let bytes;
  const installerProgress = downloadProgress(log);
  try {
    log(`  오버레이 앱을 내려받습니다 (${(manifest.bytes / 1024 / 1024).toFixed(0)} MB)…`);
    bytes = await (options.download || download)(manifest.installerUrl, MAX_INSTALLER_BYTES, installerProgress);
  } catch (err) {
    return { status: 'failed', stage: 'download', message: err.message };
  } finally {
    installerProgress.done();
  }

  if (bytes.length !== manifest.bytes) {
    return { status: 'failed', stage: 'verify', message: `내려받은 크기가 매니페스트와 다릅니다 (${bytes.length} ≠ ${manifest.bytes}).` };
  }
  if (sha256(bytes) !== manifest.sha256) {
    return { status: 'failed', stage: 'verify', message: '오버레이 인스톨러 체크섬이 일치하지 않습니다.' };
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawad-overlay-'));
  const installerPath = path.join(tempDir, manifest.fileName);
  try {
    fs.writeFileSync(installerPath, bytes, { mode: 0o600 });
    log('  오버레이 앱을 설치합니다…');
    const outcome = manifest.kind === 'zip'
      ? extractMacApp(installerPath, manifest, env, run)
      : runNsisInstaller(installerPath, manifest, run, log);
    if (!outcome.ok) return { status: 'failed', stage: 'run', message: outcome.message };
    (options.writeInstallRecord || writeInstallRecord)(manifest, env, platform);
    return {
      status: 'installed',
      mode: 'full',
      version: manifest.version,
      productName: manifest.productName,
      sourceUrl: manifest.sourceUrl,
      license: manifest.license,
    };
  } catch (err) {
    return { status: 'failed', stage: 'run', message: err.message };
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * 오버레이를 제거한다. 설치와 마찬가지로 throw하지 않는다.
 * status: removed | skipped | unsupported | failed
 */
function uninstallOverlay(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const productName = options.productName || 'Claw-Ad';
  if (!PLATFORM_KINDS[platform]) return { status: 'unsupported', reason: 'platform', platform };
  if (!PRODUCT_PATTERN.test(productName)) return { status: 'failed', message: `제품명에 쓸 수 없는 문자가 있습니다: ${productName}` };

  const run = options.spawnSync || spawnSync;
  if (platform === 'darwin') return removeMacApp(productName, env, run);

  const { dir } = installedPaths(productName, env, platform);
  const uninstaller = path.join(dir, `Uninstall ${productName}.exe`);
  if (!fs.existsSync(uninstaller)) return { status: 'skipped', reason: 'not-installed' };

  // 설치와 같은 한계로 반드시 끊는다 (CLAW-266). 백신·잠긴 파일로 멈춘 언인스톨러가
  // uninstall 전체를 무한히 붙잡으면, 사용자가 Ctrl+C한 시점에 훅·전역 명령이 남는 반제거 상태가 된다.
  const result = run(uninstaller, ['/S'], { stdio: 'ignore', windowsHide: true, shell: false, timeout: INSTALLER_TIMEOUT_MS });
  if (result.error) return { status: 'failed', message: result.error.message };
  if (result.status !== 0) return { status: 'failed', message: `제거 프로그램이 코드 ${result.status}로 종료했습니다.` };
  return { status: 'removed', productName };
}

// macOS는 제거 프로그램이 따로 없다. 실행 중이면 종료를 요청한 뒤 번들을 지운다.
// 종료 요청이 실패해도(앱이 안 떠 있는 경우 포함) 제거는 계속한다.
// 오버레이가 등록한 것들(Claude 훅·statusLine·Codex 훅·기타 에이전트 연동)을 앱이 스스로
// 정리하게 하는 진입점. 번들이 노출하는 경로이며, **앱 코드를 import하지 않는다** — Windows에서
// `Uninstall Claw-Ad.exe /S`를 실행하는 것과 같은 모양이다 (규칙 §8 경계).
const OVERLAY_CLEANUP_ENTRY = path.join('Contents', 'Resources', 'app.asar.unpacked', 'hooks', 'cleanup-integrations.js');

/**
 * 오버레이 연동을 정리한다 (CLAW-212).
 *
 * macOS 제거는 번들을 지우기만 해서, 오버레이가 남긴 등록이 통째로 살아남았다 — 특히
 * `statusLine`이 **지워진 앱 경로**를 가리킨 채 남아 Claude Code가 매 렌더마다 없는 스크립트를
 * 실행했다. Windows는 NSIS 언인스톨러가 이 일을 하므로 영향이 없다.
 *
 * **앱이 종료된 뒤에 불러야 한다.** 떠 있으면 정리 직후 앱이 스스로 다시 등록한다(실측).
 */
function cleanupOverlayIntegrations(target, run) {
  const entry = path.join(target, OVERLAY_CLEANUP_ENTRY);
  if (!fs.existsSync(entry)) return { ok: false, reason: 'absent' };
  let result;
  try {
    result = run(process.execPath, [entry, '--silent'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: false, timeout: 60000, windowsHide: true,
    });
  } catch (err) {
    return { ok: false, reason: 'failed', message: err.message };
  }
  if (!result || result.error) return { ok: false, reason: 'failed', message: result && result.error && result.error.message };
  if (result.status !== 0) {
    const detail = (typeof result.stderr === 'string' && result.stderr.trim()) || `코드 ${result.status}`;
    return { ok: false, reason: 'failed', message: detail };
  }
  return { ok: true };
}

// 종료 요청 뒤 실제로 꺼졌는지 본다. 정리를 먼저 돌리면 살아 있는 앱이 곧바로 되돌린다.
function waitForQuit(productName, run, attempts = 20) {
  for (let i = 0; i < attempts; i++) {
    const probe = run('/usr/bin/pgrep', ['-f', `${productName}.app/Contents/MacOS/`], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: false, timeout: 5000,
    });
    const running = Boolean(probe && typeof probe.stdout === 'string' && probe.stdout.trim());
    if (!running) return true;
    run('/bin/sleep', ['0.25'], { stdio: 'ignore', shell: false, timeout: 5000 });
  }
  return false;
}

function removeMacApp(productName, env, run) {
  const { target } = installedPaths(productName, env, 'darwin');
  if (!fs.existsSync(target)) return { status: 'skipped', reason: 'not-installed' };

  try {
    // quit app은 앱의 응답을 기다린다 — 대화상자로 멈춘 앱이 여기서 제거 전체를 붙잡지 않게 끊는다 (CLAW-266).
    run('/usr/bin/osascript', ['-e', `quit app "${productName}"`], { stdio: 'ignore', shell: false, timeout: 10000 });
  } catch {}
  waitForQuit(productName, run);

  // 정리 실패는 제거를 막지 않는다 — 번들을 남기면 사용자는 앱도 등록도 못 지운다.
  // 대신 호출부가 무엇이 남았는지 알릴 수 있게 결과를 함께 돌려준다.
  const integrations = cleanupOverlayIntegrations(target, run);

  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (err) {
    return { status: 'failed', message: err.message };
  }
  return { status: 'removed', productName, integrations };
}

module.exports = {
  MAX_INSTALLER_BYTES,
  fetchManifest,
  installOverlay,
  installedPaths,
  downloadProgress,
  readInstallRecord,
  readInstalledVersion,
  readManifestFields,
  stampBundleVersion,
  uninstallOverlay,
};
