# CLI·오버레이 통합 업데이트 및 광고판 UI 수정 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 오버레이의 업데이트 버튼 한 번으로 CLI와 오버레이를 함께 갱신하고, 광고·안내 칩과 광고판의 두 행 레이아웃을 CLAW-167·CLAW-168·CLAW-169 요구사항에 맞춘다.

**Architecture:** 비공개 CLI는 `createUpdater()` 경계 안에서 자가 업데이트와 macOS 오버레이 교체를 조정하고, 공개 오버레이는 검증된 `overlay-trigger.json`의 형제 `update.js`만 비동기 실행한다. 광고판은 JavaScript 문자열 분할 없이 3열 2행 CSS Grid로 재배치하고, 세션 HUD의 상태 칩 색상 토큰을 재사용한다.

**Tech Stack:** Node.js 24+, CommonJS, `node:test`, Electron, electron-updater, HTML/CSS Grid

## Global Constraints

- 두 저장소 모두 `feat/claw-167-unified-update`에서 작업하고 `develop` PR을 거친 뒤 `develop`에서 `main`으로만 릴리스한다.
- 새 런타임 외부 의존성을 추가하지 않는다.
- 오버레이는 PATH나 셸 문자열로 `clawad`를 실행하지 않고 검증된 포인터의 형제 `update.js`만 실행한다.
- `[광고]`의 대괄호를 포함한 정확한 문자열을 유지한다.
- 텔레메트리는 기존 8개 필드만 유지하고 클릭·업데이트 이벤트를 추가하지 않는다.
- 서버 정책, 금액 결정, 정산, 부정방지 로직을 공개 오버레이 저장소에 기록하지 않는다.
- clawad의 사용자 소유 미추적 파일 `.claude/launch.json`, `ClawAd_Logo.png`, `ClawAd_Logo_140.png`, `docs/product/ClawAd-service-intro.md`, `docs/product/ClawAd-service-intro.pdf`를 stage하거나 수정하지 않는다.
- 릴리스 버전은 CLI `0.1.18`, 오버레이 `0.1.9`다.

---

### Task 1: CLI 업데이트 엔진을 멱등·조정 가능하게 분리 (CLAW-167)

**Files:**
- Create: `test/update.test.js`
- Modify: `client/update.js`

**Interfaces:**
- Produces: `createUpdater(deps = {}) -> { updateCli(options), run(options) }`
- Produces: `updateCli(options) -> Promise<{ status: "updated" | "up-to-date", version: string, root: string }>`
- Produces: `run({ manifestUrl, platform }) -> Promise<{ cli: object, overlay: object | null }>`
- `deps` supplies production defaults for `activeRelease`, `download`, `fs`, `runNpm`, `runNode`, `releaseManifestUrl`, `stderr`, and `stdout`; tests replace only these boundaries.
- Consumes: macOS overlay updater at `<selectedRoot>/client/overlay-update.js`.

- [ ] **Step 1: Write the failing factory and same-version tests**

Add `test/update.test.js` with a real temporary active release directory and injected boundaries:

```js
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createUpdater } = require("../client/update");

function activeRelease(version = "0.1.17") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawad-update-"));
  fs.mkdirSync(path.join(root, "client"), { recursive: true });
  fs.writeFileSync(path.join(root, "client", "install.js"), "\n");
  fs.writeFileSync(path.join(root, "client", "overlay-update.js"), "\n");
  return { version, root };
}

test("현재 활성 CLI와 manifest 버전이 같으면 패키지를 설치하지 않는다", async (t) => {
  const previous = activeRelease();
  t.after(() => fs.rmSync(previous.root, { recursive: true, force: true }));
  let packageDownloads = 0;
  const updater = createUpdater({
    activeRelease: () => previous,
    readManifest: async () => ({ version: previous.version, packageUrl: "https://example.test/clawad.tgz", sha256: "a".repeat(64) }),
    downloadPackage: async () => { packageDownloads += 1; return Buffer.alloc(0); },
  });

  const result = await updater.updateCli({ manifestUrl: "https://example.test/manifest.json" });

  assert.deepStrictEqual(result, { status: "up-to-date", version: previous.version, root: previous.root });
  assert.strictEqual(packageDownloads, 0);
});
```

- [ ] **Step 2: Run the new test and verify RED**

Run: `node --test test/update.test.js`

Expected: FAIL because `client/update.js` does not export `createUpdater` and executes `main()` at require time.

- [ ] **Step 3: Add failing orchestration tests**

Extend `test/update.test.js` with these independent cases:

```js
test("macOS는 새 CLI 루트의 overlay-update.js를 실행한다", async () => {
  const calls = [];
  const updater = createUpdater({
    activeRelease: () => ({ version: "0.1.17", root: "old-root" }),
    updateCli: async () => ({ status: "updated", version: "0.1.18", root: "new-root" }),
    runNode: (script) => { calls.push(script); return { status: 0 }; },
  });
  const result = await updater.run({ platform: "darwin" });
  assert.strictEqual(calls[0], path.join("new-root", "client", "overlay-update.js"));
  assert.strictEqual(result.overlay.status, "updated");
});

test("macOS는 CLI 실패 후 기존 CLI로 오버레이 갱신을 계속한다", async () => {
  const calls = [];
  const updater = createUpdater({
    activeRelease: () => ({ version: "0.1.17", root: "old-root" }),
    updateCli: async () => { throw new Error("cli failed"); },
    runNode: (script) => { calls.push(script); return { status: 0 }; },
    stderr: () => {},
  });
  const result = await updater.run({ platform: "darwin" });
  assert.strictEqual(calls[0], path.join("old-root", "client", "overlay-update.js"));
  assert.strictEqual(result.cli.status, "failed");
});

test("Windows는 오버레이 교체 스크립트를 실행하지 않고 CLI 실패를 전달한다", async () => {
  let overlayRuns = 0;
  const updater = createUpdater({
    activeRelease: () => ({ version: "0.1.17", root: "old-root" }),
    updateCli: async () => { throw new Error("cli failed"); },
    runNode: () => { overlayRuns += 1; return { status: 0 }; },
  });
  await assert.rejects(updater.run({ platform: "win32" }), /cli failed/);
  assert.strictEqual(overlayRuns, 0);
});
```

- [ ] **Step 4: Run orchestration tests and verify RED**

Run: `node --test test/update.test.js`

Expected: FAIL on the missing factory/orchestration behavior, not on test setup.

- [ ] **Step 5: Implement the minimal update factory**

Refactor `client/update.js` so module loading has no side effects and production execution remains gated:

```js
function createUpdater(deps = {}) {
  const getActiveRelease = deps.activeRelease || activeRelease;
  const readManifestImpl = deps.readManifest || readAndValidateManifest;
  const installReleaseImpl = deps.installRelease || installAndActivateRelease;
  const runNodeImpl = deps.runNode || runNode;

  async function updateCli(options = {}) {
    if (typeof deps.updateCli === "function") return deps.updateCli(options);
    const previous = getActiveRelease();
    const manifest = await readManifestImpl(options.manifestUrl || releaseManifestUrl());
    if (manifest.version === previous.version && fs.existsSync(path.join(previous.root, "client", "install.js"))) {
      return { status: "up-to-date", version: previous.version, root: previous.root };
    }
    return installReleaseImpl(previous, manifest);
  }

  async function run(options = {}) {
    const platform = options.platform || process.platform;
    const previous = getActiveRelease();
    let cli;
    let cliError = null;
    try { cli = await updateCli(options); }
    catch (error) { cliError = error; cli = { status: "failed", message: error.message, root: previous.root }; }

    if (platform !== "darwin") {
      if (cliError) throw cliError;
      return { cli, overlay: null };
    }

    const overlayRoot = cli.status === "updated" || cli.status === "up-to-date" ? cli.root : previous.root;
    const child = runNodeImpl(path.join(overlayRoot, "client", "overlay-update.js"));
    if (!child || child.status !== 0) throw new Error("오버레이 업데이트에 실패했습니다.");
    if (cliError) (deps.stderr || console.error)(`CLI 업데이트 실패: ${cliError.message}`);
    return { cli, overlay: { status: "updated", root: overlayRoot } };
  }

  return { run, updateCli };
}

module.exports = { createUpdater };

if (require.main === module) {
  createUpdater().run({ manifestUrl: process.argv[2] })
    .then((result) => {
      const version = result.cli.version || "unknown";
      console.log(`클로애드 ${version} 업데이트 완료.`);
    })
    .catch((error) => {
      console.error(error && error.message ? error.message : "업데이트에 실패했습니다.");
      process.exitCode = 1;
    });
}
```

Inside `installAndActivateRelease(previous, manifest)`, preserve this exact order from the current implementation: download `manifest.packageUrl`; compare `sha256(packageBytes)` with `manifest.sha256`; create `releases/<version>`; write the mode-0600 temporary tarball; run `npm install --prefix <releaseDir> --ignore-scripts --no-audit --no-fund <tarball>`; validate package name `@clawad/cli` and the exact manifest version; run the new `client/install.js install`; write mode-0600 `release-state.json`; remove the temporary tarball in `finally`. On any error remove only the new release directory, run the previous `client/install.js install`, and rethrow the rollback result.

- [ ] **Step 6: Run targeted and full clawad verification**

Run: `node --test test/update.test.js test/release.test.js test/overlay-update.test.js`

Expected: PASS with zero failures.

Run: `npm.cmd run lint && npm.cmd test`

Expected: lint exit 0 and all clawad tests pass.

- [ ] **Step 7: Commit the CLI engine**

```bash
git add client/update.js test/update.test.js
git commit -m "feat: CLI와 오버레이 업데이트를 함께 조정한다 (CLAW-167)"
```

### Task 2: 오버레이 업데이트 버튼에서 검증된 CLI 업데이트 시작 (CLAW-167)

**Files:**
- Modify: `apps/client-desktop/src/updater.js`
- Modify: `apps/client-desktop/test/clawad-cli-bridge.test.js`
- Modify: `apps/client-desktop/test/updater.test.js`

**Interfaces:**
- Consumes: `resolveSiblingCommand("update.js", options) -> { node, script } | null`
- Produces: `startClawadUpdate(version) -> { status: "started" | "duplicate" | "unavailable" | "failed", message? }`
- Windows `onPrimary`: calls `startClawadUpdate(info.version)` and then `autoUpdater.downloadUpdate()` regardless of delegation result.
- macOS `onPrimary`: starts CLI update and quits only for `started` or `duplicate`; otherwise keeps the release-page fallback.

- [ ] **Step 1: Write failing bridge and updater tests**

In `clawad-cli-bridge.test.js`, replace the primary update sibling expectation with:

```js
const command = resolveSiblingCommand("update.js", deps(validPointer()));
assert.deepStrictEqual(command, { node: NODE, script: path.join(CLIENT, "update.js") });
```

In `updater.test.js`, rename the CLAW-160 update delegation suite and assert:

```js
const first = updater.startClawadUpdate("0.1.9");
const second = updater.startClawadUpdate("0.1.9");
assert.strictEqual(first.status, "started");
assert.strictEqual(second.status, "duplicate");
assert.deepStrictEqual(spawned[0].args, [path.join(staged.root, "client", "update.js")]);
```

Add a Windows `update-available` test whose primary action resolves immediately and assert both `spawned.length === 1` and `downloads === 1`. Add a start-failure case that still asserts `downloads === 1`.

- [ ] **Step 2: Run the tests and verify RED**

Run: `node --test test/clawad-cli-bridge.test.js test/updater.test.js`

Expected: FAIL because the updater still resolves `overlay-update.js`, exports `startOverlayUpdate`, and does not delegate on Windows.

- [ ] **Step 3: Implement one-shot CLI delegation**

In `updater.js`:

```js
const CLI_UPDATE_SCRIPT = "update.js";

function initUpdater(ctx, deps = {}) {
  const delegatedCliVersions = new Set();

  function startClawadUpdate(version = "") {
    if (version && delegatedCliVersions.has(version)) return { status: "duplicate" };
    const command = resolveSiblingCommand(CLI_UPDATE_SCRIPT, {
      dataDir: deps.clawadDataDir,
      env: deps.env || process.env,
    });
    if (!command) return { status: "unavailable" };
    try {
      const child = (deps.spawnImpl || require("child_process").spawn)(command.node, [command.script], {
        stdio: "ignore", windowsHide: true, detached: true,
      });
      if (version) delegatedCliVersions.add(version);
      child.on("error", (err) => log(`clawad update failed to start: ${err.message}`));
      child.on("exit", (code) => log(`clawad update exited: ${code}`));
      child.unref();
      return { status: "started" };
    } catch (error) {
      return { status: "failed", message: getErrorMessage(error) };
    }
  }
}
```

Call this function at the start of the Windows primary branch before `downloadUpdate()`. In the macOS primary branch, replace `startOverlayUpdate()` with `startClawadUpdate(info.version)`; quit for `started`/`duplicate` and preserve the release-page fallback for `unavailable`/`failed`.

- [ ] **Step 4: Run targeted tests and verify GREEN**

Run: `node --test test/clawad-cli-bridge.test.js test/updater.test.js`

Expected: PASS with the new Windows, macOS, duplicate, missing-pointer, and spawn-failure cases.

- [ ] **Step 5: Commit the overlay delegation**

```bash
git add apps/client-desktop/src/updater.js apps/client-desktop/test/clawad-cli-bridge.test.js apps/client-desktop/test/updater.test.js
git commit -m "feat: 오버레이 업데이트에서 CLI도 함께 갱신한다 (CLAW-167)"
```

### Task 3: 광고·안내 상태 칩과 밑줄형 안내 끄기 (CLAW-168)

**Files:**
- Create: `apps/client-desktop/test/clawad-ad-markup.test.js`
- Modify: `apps/client-desktop/src/clawad-ad.html`
- Modify: `apps/client-desktop/test/clawad-ad-renderer.test.js`

**Interfaces:**
- Keeps literal HTML labels `[광고]` and `[안내]`.
- Keeps `#notice-dismiss` as a `<button type="button">` and the existing IPC click behavior.
- Adds no telemetry or click payload.

- [ ] **Step 1: Write failing markup-contract tests**

Create `clawad-ad-markup.test.js` that reads the HTML as UTF-8 and asserts exact tokens:

```js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "..", "src", "clawad-ad.html"), "utf8").replace(/^\uFEFF/, "");

test("광고와 안내는 HUD 상태 칩 색상으로 구분된다", () => {
  assert.match(html, /#label\s*\{[^}]*background:\s*rgba\(245, 158, 11, 0\.15\)[^}]*color:\s*#b45309/s);
  assert.match(html, /#notice-label\s*\{[^}]*background:\s*rgba\(22, 163, 74, 0\.13\)[^}]*color:\s*#16a34a/s);
  assert.match(html, />\[광고\]</);
  assert.match(html, />\[안내\]</);
});

test("안내 끄기는 배지 대신 밑줄 버튼이다", () => {
  assert.match(html, /#notice-dismiss\s*\{[^}]*background:\s*transparent[^}]*text-decoration:\s*underline/s);
  assert.doesNotMatch(html, /#notice-dismiss\s*\{[^}]*border-radius:/s);
  assert.match(html, /#notice-dismiss:focus-visible/);
});
```

- [ ] **Step 2: Run markup and renderer tests and verify RED**

Run: `node --test test/clawad-ad-markup.test.js test/clawad-ad-renderer.test.js`

Expected: markup tests FAIL because all three elements still use the gray badge style.

- [ ] **Step 3: Apply the state-chip visual hierarchy**

In `clawad-ad.html`, give the shared labels the HUD state-chip geometry and separate colors:

```css
#label,
#notice-label {
  flex: 0 0 auto;
  padding: 2px 5px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
}
#label { background: rgba(245, 158, 11, 0.15); color: #b45309; }
#notice-label { background: rgba(22, 163, 74, 0.13); color: #16a34a; }

#notice-dismiss {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text-muted);
  font: inherit;
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}
#notice-dismiss:hover,
#notice-dismiss:focus-visible { color: var(--text); text-decoration-thickness: 2px; }
```

Add the exact dark-mode tokens from the design spec. Do not change the renderer click handler except to retain its existing `stopPropagation()` behavior.

```css
@media (prefers-color-scheme: dark) {
  #label { background: rgba(245, 158, 11, 0.20); color: #fbbf24; }
  #notice-label { background: rgba(22, 163, 74, 0.20); color: #4ade80; }
}
```

- [ ] **Step 4: Run tests and verify GREEN**

Run: `node --test test/clawad-ad-markup.test.js test/clawad-ad-renderer.test.js`

Expected: PASS; existing renderer test still proves the dismiss signal fires only for dismissible notices.

- [ ] **Step 5: Commit the visual hierarchy fix**

```bash
git add apps/client-desktop/src/clawad-ad.html apps/client-desktop/test/clawad-ad-markup.test.js apps/client-desktop/test/clawad-ad-renderer.test.js
git commit -m "fix: 광고와 안내 표기의 시각적 위계를 분리한다 (CLAW-168)"
```

### Task 4: 광고 본문과 metadata를 두 행에 배치 (CLAW-169)

**Files:**
- Modify: `apps/client-desktop/src/clawad-ad.html`
- Modify: `apps/client-desktop/src/clawad-ad-width.js`
- Modify: `apps/client-desktop/test/clawad-ad-markup.test.js`
- Modify: `apps/client-desktop/test/clawad-ad-renderer.test.js`
- Modify: `apps/client-desktop/test/clawad-ad-width.test.js`

**Interfaces:**
- Produces DOM IDs: `strip`, `label`, `notice-label`, `text`, `notice-dismiss`, `meta`, `brand`, `reward`, `open`.
- `stripHeight(kind)` returns the same two-row height for ad, notice, login, and unknown legacy payloads.
- Metadata flex order remains `brand`, `reward`, `open`; advertiser shrinks before reward.

- [ ] **Step 1: Write failing two-row layout tests**

Add these assertions to `clawad-ad-markup.test.js`:

```js
test("광고판은 3열 2행 Grid에서 본문과 metadata가 둘째 행을 공유한다", () => {
  assert.match(html, /#strip\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\) auto[^}]*grid-template-rows:\s*repeat\(2, 17px\)/s);
  assert.match(html, /#text\s*\{[^}]*grid-column:\s*2[^}]*grid-row:\s*1\s*\/\s*span 2/s);
  assert.match(html, /#meta\s*\{[^}]*grid-column:\s*3[^}]*grid-row:\s*2/s);
  assert.match(html, /#notice-dismiss\s*\{[^}]*grid-column:\s*2[^}]*grid-row:\s*2/s);
  assert.match(html, /<div id="meta">\s*<span id="brand"><\/span>\s*<span id="reward"><\/span>/s);
});
```

Change the height test to:

```js
test("광고·안내·로그인은 모두 같은 두 행 높이를 쓴다", () => {
  for (const kind of ["ad", "notice", "login", undefined]) {
    assert.strictEqual(stripHeight(kind), NOTICE_STRIP_HEIGHT);
  }
  assert.strictEqual(AD_STRIP_HEIGHT, NOTICE_STRIP_HEIGHT);
});
```

- [ ] **Step 2: Run layout tests and verify RED**

Run: `node --test test/clawad-ad-markup.test.js test/clawad-ad-width.test.js test/clawad-ad-renderer.test.js`

Expected: FAIL because the panel still uses nested flex rows and ads add `TEXT_LINE_HEIGHT` to the window height.

- [ ] **Step 3: Replace row wrappers with the two-row Grid**

Change the markup to:

```html
<div id="strip">
  <span id="label">[광고]</span>
  <span id="notice-label">[안내]</span>
  <span id="text"></span>
  <button id="notice-dismiss" type="button" hidden></button>
  <div id="meta">
    <span id="brand"></span>
    <span id="reward"></span>
    <span id="open" aria-hidden="true">↗</span>
  </div>
</div>
```

Replace the strip flex rules with:

```css
#strip {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  grid-template-rows: repeat(2, 17px);
  column-gap: 8px;
  row-gap: 2px;
  align-items: start;
}
#label, #notice-label { grid-column: 1; grid-row: 1; align-self: start; }
#text { grid-column: 2; grid-row: 1 / span 2; min-width: 0; }
#meta {
  grid-column: 3;
  grid-row: 2;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0;
  min-width: 0;
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.2;
}
#notice-dismiss { grid-column: 2; grid-row: 2; justify-self: start; align-self: center; }
```

Keep `#strip.notice #text { -webkit-line-clamp: 1; }`, existing brand shrink rules, reward no-wrap, linked cursor, and fixed literal labels.

- [ ] **Step 4: Collapse ad height to the common two-row height**

In `clawad-ad-width.js` retain the exported constants for compatibility but define:

```js
const NOTICE_STRIP_HEIGHT = 55;
const TEXT_LINE_HEIGHT = 17;
const AD_STRIP_HEIGHT = NOTICE_STRIP_HEIGHT;

function stripHeight() {
  return NOTICE_STRIP_HEIGHT;
}
```

Update comments so they describe the shared second row rather than the removed third row.

- [ ] **Step 5: Update the renderer DOM harness and run GREEN verification**

Add `meta` to the renderer test IDs/harness without changing reward interpolation assertions.

Run: `node --test test/clawad-ad-markup.test.js test/clawad-ad-width.test.js test/clawad-ad-renderer.test.js`

Expected: PASS with zero failures.

- [ ] **Step 6: Commit the two-row layout fix**

```bash
git add apps/client-desktop/src/clawad-ad.html apps/client-desktop/src/clawad-ad-width.js apps/client-desktop/test/clawad-ad-markup.test.js apps/client-desktop/test/clawad-ad-renderer.test.js apps/client-desktop/test/clawad-ad-width.test.js
git commit -m "fix: 광고 본문과 적립 정보를 두 행에 배치한다 (CLAW-169)"
```

### Task 5: 계약 문서, 사용자 문구, 릴리스 버전 준비

**Files:**
- Modify: `docs/design/overlay-contract.md`
- Modify: `docs/operations/client-distribution.md`
- Modify: `README.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `apps/client-desktop/src/i18n.js`
- Modify: `apps/client-desktop/package.json`
- Create: `apps/client-desktop/docs/releases/release-v0.1.9.md`
- Modify: `apps/client-desktop/.gitignore` only if the release note is ignored without an existing exception.

**Interfaces:**
- Documents the verified sibling command `update.js` without exposing private implementation.
- CLI package version becomes `0.1.18`; overlay package version becomes `0.1.9`.
- Five update prompts tell users that the app and CLI update together.

- [ ] **Step 1: Update the cross-repository contract**

Document these exact rules in `docs/design/overlay-contract.md`:

```markdown
- 오버레이 업데이트를 사용자가 승인하면 오버레이는 검증된 `overlay-trigger.json` 포인터의 형제 `update.js`를 실행할 수 있다.
- `script` basename이 정확히 `overlay-events.js`이고 Node 및 유도된 스크립트가 모두 존재할 때만 실행한다.
- PATH 검색과 shell 문자열 실행은 금지한다.
- 위임 실패는 오버레이 자체 업데이트를 막지 않는다.
```

- [ ] **Step 2: Update all five user-facing update messages**

In `i18n.js`, change the equivalent of `updateAvailableMsg` and `updateAvailableMacMsg` in English, Simplified Chinese, Traditional Chinese, Korean, and Japanese so each says the Claw-Ad app and ClawAd CLI are updated together. Preserve placeholders and existing action IDs.

Use these exact messages for both keys in each language:

```text
en: v{version} is available. Update Claw-Ad and the ClawAd CLI now?
zh-CN: v{version} 已发布。现在同时更新 Claw-Ad 和 ClawAd CLI 吗？
zh-TW: v{version} 已發布。現在同時更新 Claw-Ad 和 ClawAd CLI 嗎？
ko: v{version}이(가) 출시되었습니다. Claw-Ad 앱과 ClawAd CLI를 함께 업데이트할까요?
ja: v{version} が公開されました。Claw-Ad と ClawAd CLI を一緒に更新しますか？
```

- [ ] **Step 3: Bump CLI version and distribution examples**

Run: `npm.cmd version 0.1.18 --no-git-tag-version`

Then change version-pinned examples in `README.md` and `docs/operations/client-distribution.md` from `v0.1.17` to `v0.1.18`.

- [ ] **Step 4: Bump overlay version and add release notes**

From `apps/client-desktop`, run: `npm.cmd version 0.1.9 --no-git-tag-version`

Create `docs/releases/release-v0.1.9.md` with Korean sections covering:

```markdown
# Claw-Ad Overlay v0.1.9

## 변경 사항
- 오버레이 업데이트 승인 한 번으로 ClawAd CLI 업데이트도 함께 시작합니다. (CLAW-167)
- `[광고]`와 `[안내]`를 주황·초록 상태 칩으로 구분하고 `안내 끄기`를 밑줄 동작으로 바꿨습니다. (CLAW-168)
- 두 줄 광고 본문과 광고주·예상 적립을 같은 둘째 행에 배치해 광고판을 두 행 높이로 정리했습니다. (CLAW-169)

## 검증
- Windows x64/ARM64 및 macOS x64/ARM64 manifest 생성
- CLI 위임, 광고판 renderer·높이·markup 단위 테스트
```

If ignored, add the narrow exception `!docs/releases/release-v0.1.9.md` to `apps/client-desktop/.gitignore`.

- [ ] **Step 5: Run version and release-manifest tests**

In clawad:

Run: `npm.cmd run lint && npm.cmd test`

In `clawad-overlay/apps/client-desktop`:

Run: `node --test test/build-overlay-manifest.test.js test/package-build-config.test.js test/clawad-cli-bridge.test.js test/updater.test.js test/clawad-ad-markup.test.js test/clawad-ad-renderer.test.js test/clawad-ad-width.test.js`

Expected: targeted tests pass; version/tag assumptions point to 0.1.18 and 0.1.9 respectively.

- [ ] **Step 6: Commit release prep in each repository**

In clawad:

```bash
git add package.json package-lock.json README.md docs/operations/client-distribution.md docs/design/overlay-contract.md
git commit -m "chore: CLI 버전 0.1.18과 통합 업데이트 계약 (CLAW-167)"
```

In clawad-overlay:

```bash
git add apps/client-desktop/package.json apps/client-desktop/package-lock.json apps/client-desktop/src/i18n.js apps/client-desktop/docs/releases/release-v0.1.9.md apps/client-desktop/.gitignore
git commit -m "chore: 오버레이 버전 0.1.9와 릴리스 노트 (CLAW-167, CLAW-168, CLAW-169)"
```

### Task 6: 최종 검증, PR 통합, main 릴리스

**Files:**
- Verify only; no unplanned source edits.

**Interfaces:**
- Feature PRs target `develop` in both repositories.
- Release PRs target `main` from `develop` in both repositories.
- Tags point exactly to the merged `main` SHA.

- [ ] **Step 1: Run fresh full clawad verification**

Run: `npm.cmd run lint`

Expected: exit 0.

Run: `npm.cmd test`

Expected: all tests pass with zero failures.

- [ ] **Step 2: Run fresh overlay verification**

From `apps/client-desktop`, run the changed targeted test list from Task 5 and syntax-check every modified JavaScript file with `node --check`.

Run the full suite: `npm.cmd test`

Expected: no new failures beyond the documented baseline; compare exact pass/fail/skipped counts with the pre-change baseline rather than claiming zero failures.

- [ ] **Step 3: Run repository hygiene checks**

In each repository:

```bash
git diff --check
git status --short --branch
git diff origin/develop...HEAD --stat
```

Expected: only CLAW-167·168·169 files are included; clawad user-owned untracked files remain untracked.

- [ ] **Step 4: Push and create feature PRs**

Push `feat/claw-167-unified-update` in each repository and create ready PRs into `develop`, cross-linking both PRs and Jira CLAW-167·168·169. Merge only after required checks complete.

- [ ] **Step 5: Create and merge develop-to-main PRs**

Create `develop` → `main` PRs for both repositories. Confirm the exact release versions in the diff, merge, and record both `main` SHAs.

- [ ] **Step 6: Publish overlay v0.1.9**

Tag the overlay `main` SHA as `v0.1.9`, push the tag, monitor `.github/workflows/release.yml`, and verify the public release contains Windows x64/ARM64, macOS x64/ARM64, update metadata, asar artifacts, and `overlay-manifest.json` with version-pinned URLs.

- [ ] **Step 7: Publish CLI v0.1.18 GitHub release**

Build with production origins and the latest overlay manifest:

```powershell
$env:CLAWAD_API_ORIGIN='https://api.clawad.whatsup.house'
$env:CLAWAD_WEB_ORIGIN='https://clawad.whatsup.house'
$env:CLAWAD_RELEASE_MANIFEST_URL='https://github.com/TJ-media/clawad/releases/latest/download/manifest.json'
$env:CLAWAD_RELEASE_PACKAGE_URL='https://github.com/TJ-media/clawad/releases/download/v0.1.18/clawad-cli.tgz'
$env:CLAWAD_RELEASE_OVERLAY_MANIFEST_URL='https://github.com/TJ-media/clawad-overlay/releases/latest/download/overlay-manifest.json'
npm.cmd run client:release
```

Create tag `v0.1.18` at the clawad `main` SHA and publish `dist/client-release/clawad-cli.tgz` plus `manifest.json`. Run:

```powershell
npm.cmd run client:release:verify -- https://github.com/TJ-media/clawad/releases/latest/download/manifest.json 0.1.18
```

Expected: archive SHA, package identity, production origins, version-pinned package URL, and latest overlay manifest URL all verify.

- [ ] **Step 8: Publish npm package when authenticated**

Run: `npm.cmd whoami`

If authenticated, publish and verify:

```powershell
npm.cmd publish .\dist\client-release\clawad-cli.tgz --access public
npm.cmd view @clawad/cli@0.1.18 version --json
```

Expected: registry returns `"0.1.18"`. If `whoami` returns E401, do not invent credentials or modify repository secrets; report npm publication as the only blocker while keeping the verified GitHub updater release intact.

- [ ] **Step 9: Transition Jira issues after evidence is collected**

Attach the two feature PRs, two release PRs, workflow URLs, test counts, and manifest verification results to CLAW-167, CLAW-168, and CLAW-169. Transition each issue to 완료 only after both repositories are released.
