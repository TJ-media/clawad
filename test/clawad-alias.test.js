'use strict';
// `npx clawad`용 이름 별칭 패키지 (packages/clawad-alias).
// npx의 인자는 bin 이름이 아니라 패키지 이름이므로, 이 패키지가 없으면 `npx clawad`는 404다.
// 별칭이 실제 CLI를 못 따라가면 조용히 옛 버전으로 붙으므로 의존 범위를 여기서 강제한다.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const DIR = path.join(__dirname, '..', 'packages', 'clawad-alias');
const alias = JSON.parse(fs.readFileSync(path.join(DIR, 'package.json'), 'utf8'));
const root = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

function runAlias(command, registryResult = { status: 0, stdout: '"0.2.5"\n', stderr: '' }, currentVersion = '0.2.3') {
  const source = fs.readFileSync(path.join(DIR, 'bin.js'), 'utf8');
  const errors = [];
  const npmCalls = [];
  let targetLoaded = false;
  const moduleValue = { exports: {} };
  function fakeRequire(id) {
    if (id === '@clawad/cli/package.json') {
      return { version: currentVersion, bin: { clawad: 'client/cli.js' } };
    }
    if (id === 'node:child_process' || id === 'child_process') {
      return {
        spawnSync(file, args) {
          npmCalls.push({ file, args });
          return registryResult;
        },
      };
    }
    if (id === 'resolved-cli') {
      targetLoaded = true;
      return {};
    }
    return require(id);
  }
  fakeRequire.resolve = () => 'resolved-cli';
  fakeRequire.main = moduleValue;

  vm.runInNewContext(source, {
    console: { error: (line) => errors.push(String(line)), log() {} },
    module: moduleValue,
    exports: moduleValue.exports,
    require: fakeRequire,
    __filename: path.join(DIR, 'bin.js'),
    __dirname: DIR,
    process: {
      argv: [process.execPath, path.join(DIR, 'bin.js'), command],
      env: {},
      execPath: process.execPath,
      platform: process.platform,
      exit(code) { throw new Error(`unexpected exit ${code}`); },
    },
  });
  return { errors, npmCalls, targetLoaded };
}

test('별칭 패키지는 clawad 이름을 잡고 clawad bin을 노출한다', () => {
  assert.strictEqual(alias.name, 'clawad', '선점 대상 이름이어야 한다');
  assert.strictEqual(alias.bin.clawad, 'bin.js');
  assert.ok(fs.existsSync(path.join(DIR, 'bin.js')));
  for (const file of alias.files) assert.ok(fs.existsSync(path.join(DIR, file)), `${file}이 있어야 한다`);
  assert.ok(fs.existsSync(path.join(DIR, 'LICENSE')), '클라이언트 라이선스를 함께 배포해야 한다');
});

// `^0.MINOR.PATCH`만 다룬다 — 알파 내내 0.1.x이고, 0.2로 올라갈 때 이 테스트가 갱신을 강제한다.
test('의존 범위가 현재 클라이언트 버전을 덮는다', () => {
  const range = alias.dependencies['@clawad/cli'];
  const m = /^\^0\.(\d+)\.(\d+)$/.exec(range);
  assert.ok(m, `범위 형식이 ^0.x.y가 아니다: ${range} — 이 테스트를 함께 갱신하라`);
  const [, rMinor, rPatch] = m.map(Number);
  const [major, minor, patch] = root.version.split('.').map(Number);
  assert.strictEqual(major, 0, '클라이언트가 1.x가 되면 별칭 범위 규칙을 다시 정해야 한다');
  assert.strictEqual(minor, rMinor, `클라이언트 0.${minor}.x인데 별칭은 ^0.${rMinor}을 가리킨다`);
  assert.ok(patch >= rPatch, `별칭 범위(${range})가 현재 버전(${root.version})보다 앞서 있다`);
});

// 내부 배치가 바뀌어도 깨지지 않아야 한다. 경로를 적어두면 다음 리팩터에서 조용히 실패한다.
test('별칭 bin은 CLI 내부 경로를 하드코딩하지 않는다', () => {
  const src = fs.readFileSync(path.join(DIR, 'bin.js'), 'utf8');
  assert.ok(!src.includes('client/cli.js'), '의존 패키지의 bin 선언을 따라가야 한다');
  assert.match(src, /@clawad\/cli\/package\.json/, 'bin 선언을 읽어 대상을 정해야 한다');
  assert.match(src, /require\.resolve/, '해석은 require.resolve에 맡겨야 한다');
  // CLI가 없을 때 스택 트레이스를 던지지 않고 대안을 알려줘야 한다.
  assert.match(src, /@clawad\/cli setup/, '직접 실행 방법을 안내해야 한다');
  assert.match(src, /process\.exit\(1\)/, '실패를 종료 코드로 알려야 한다');
});

test('setup 별칭이 캐시된 구버전을 로드하면 npm 최신 버전을 경고한다 (CLAW-237)', () => {
  const result = runAlias('setup');

  assert.strictEqual(result.targetLoaded, true, '경고 뒤에도 CLI 실행을 계속해야 한다');
  assert.ok(result.errors.some((line) => /0\.2\.3/.test(line) && /0\.2\.5/.test(line)),
    `현재·최신 버전을 함께 알려야 한다: ${result.errors.join(' | ')}`);
});

test('일반 별칭 명령은 레지스트리를 조회하지 않는다 (CLAW-237)', () => {
  const result = runAlias('status');

  assert.strictEqual(result.targetLoaded, true);
  assert.deepStrictEqual(result.npmCalls, []);
});

test('별칭은 같은 core의 prerelease도 npm stable보다 오래됐다고 경고한다 (CLAW-237)', () => {
  const result = runAlias('setup', { status: 0, stdout: '"0.2.5"\n', stderr: '' }, '0.2.5-beta.1');

  assert.ok(result.errors.some((line) => /0\.2\.5-beta\.1/.test(line) && /0\.2\.5/.test(line)));
});
