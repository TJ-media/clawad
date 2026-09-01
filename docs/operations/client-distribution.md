# 사용자용 CLI 배포·업데이트

CLAW-62의 배포 산출물은 `client/`, `policy/`와 실행에 필요한 메타데이터만 포함하는 버전 고정 npm tarball이다. 서버 코드, 운영 `.env`, OAuth·관리자 비밀정보는 포함하지 않는다.

## 릴리스 생성

운영 API와 GitHub Release URL을 명시해 빌드한다. 세 값은 모두 자격증명 없는 HTTPS여야 하며 API 값은 경로 없는 origin이어야 한다.

```bash
CLAWAD_RELEASE_API_ORIGIN=https://api.clawad.whatsup.house \
CLAWAD_RELEASE_WEB_ORIGIN=https://clawad.whatsup.house \
CLAWAD_RELEASE_MANIFEST_URL=https://github.com/TJ-media/clawad/releases/latest/download/manifest.json \
CLAWAD_RELEASE_PACKAGE_URL=https://github.com/TJ-media/clawad/releases/download/v0.2.12/clawad-cli.tgz \
CLAWAD_RELEASE_OVERLAY_MANIFEST_URL=https://github.com/TJ-media/clawad-overlay/releases/latest/download/overlay-manifest.json \
npm run client:release
```

**`CLAWAD_RELEASE_OVERLAY_MANIFEST_URL`을 빠뜨리지 않는다.** 이 값이 없으면 배포본이 오버레이 설치
단계를 건너뛰고, CLAW-134 이후 광고 창구가 오버레이뿐이라 **설치는 "성공"으로 끝나면서 광고도 포인트
적립도 발생하지 않는다.** 빌드는 경고만 내고 진행하므로(오버레이 없이 CLI만 검증하는 용도가 있다),
사용자 배포용 빌드에서는 반드시 지정한다. 게시 후 `client:release:verify`가 이 값을 검사한다.

빌드는 tarball을 `CLAWAD_RELEASE_PACKAGE_URL`의 파일명(`clawad-cli.tgz`)으로 만들어 둔다. **이 파일명을 바꿔 업로드하면 manifest의 packageUrl과 어긋나 모든 `update`가 실패한다.** manifest의 `packageUrl`은 `latest`가 아니라 버전 고정 태그 경로를 가리켜야 한다.

## 릴리스 게시

**릴리스는 `main`에서 자른다.** 기능 브랜치는 `develop`으로 모이고, 운영 배포 시점에 `develop` → `main` PR을 머지한 뒤 그 `main`에서 태그를 만든다 (`.claude/CLAUDE.md` §6). 태그를 `develop`에 달지 않는다 — 배포된 것과 태그가 가리키는 것이 어긋난다.

태그와 `package.json` 버전이 같아야 한다. `dist/client-release/`의 tarball과 `manifest.json`을 같은 Release에 올린다.

**두 저장소를 같은 번호로 함께 자른다** (CLAW-214, 0.2.0부터). clawad와 clawad-overlay는 사용자에게 하나의 "클로애드 버전"으로 보여야 한다 — 번호가 어긋나면 오버레이 갱신 화면이 말하는 버전과 `clawad status`가 말하는 버전이 달라져 사용자가 자기 버전을 특정할 수 없다. 한쪽만 바뀐 릴리스에서도 양쪽 태그를 자른다.

한쪽만 바뀌었는데 함께 자르는 비용은 낮다. 기존 사용자의 오버레이 갱신은 `app.asar`(7.2MB)와 asar 밖 트리 묶음(`app-<버전>-<arch>.unpacked.tar.gz`, 0.6MB)만 받는 경로이고(CLAW-161·283), Electron·네이티브가 그대로면 `runtimeId`가 같아 그 경로를 탄다. 전체 번들(129~137MB)은 첫 설치와 `runtimeId`가 바뀐 릴리스에만 해당한다. **오버레이를 다시 빌드할 때 Electron을 함께 올리지 않으면 `runtimeId`가 유지된다** — 버전만 맞추는 릴리스에서 그걸 확인한다.

**`app.asar`만 갈면 `asarUnpack` 대상은 옛것으로 남는다** (CLAW-283). 번들 테마·훅·에이전트·확장은 `app.asar.unpacked/`에 있어서 asar 안에 없다. 0.2.12가 그렇게 나가 마스코트 흰 테두리 수정이 macOS 경량 경로 사용자에게 닿지 않았다. 그래서 매니페스트의 `codeUpdate` 항목은 `unpacked` 블록을 반드시 갖고, 없으면 CLI가 경량 경로를 포기하고 전체 교체로 내려간다. `runtimeId`는 87MB 네이티브 트리(`app.asar.unpacked/node_modules`)만 지키며, 그 트리는 묶음에 담지 않는다 — 반쪽으로 덮으면 앱이 켜지지 않는다.

`packages/clawad-alias`의 `@clawad/cli` 의존 범위도 함께 본다. minor가 올라가면 범위를 갱신하고 별칭 버전도 올린다 — 하지 않으면 `npx clawad`가 조용히 옛 클라이언트에 붙는다. `test/clawad-alias.test.js`가 이 대조를 강제한다.

```bash
git tag v0.1.0 && git push origin v0.1.0
gh release create v0.1.0 \
  dist/client-release/clawad-cli.tgz \
  dist/client-release/manifest.json \
  --title "클로애드 클라이언트 v0.1.0" --notes-file <릴리스 노트 파일>
```

게시 후 반드시 원격 검증을 통과해야 한다. 이 명령은 게시된 manifest를 내려받아 검증하고, tarball SHA-256을 대조한 뒤, `update`와 같은 방식으로 실제 설치해 패키지 이름·버전과 배포물 구성(서버 코드 미포함)을 확인한다.

```bash
npm run client:release:verify
# 특정 manifest·버전을 지정할 때
npm run client:release:verify -- https://github.com/TJ-media/clawad/releases/latest/download/manifest.json 0.1.0
```

검증이 실패하면 자산을 교체하지 말고 새 버전을 발행한다. **게시된 tarball URL의 내용은 변경하지 않는다** — 버전 고정 URL이 곧 무결성 계약이다.

## npm 레지스트리 게시

GitHub Release 검증까지 통과한 **같은 tarball**을 npm 레지스트리에도 올린다(CLAW-145). 두 채널은 역할이 다르다 — 레지스트리는 첫 설치·전역 명령이 쓰고, GitHub Release는 `clawad update`가 SHA-256 대조에 쓴다. 어느 쪽도 생략하지 않는다.

**이 단계는 손으로 하지 않는다.** Release를 공개하면 `.github/workflows/npm-publish.yml`이 그 Release의 자산을 내려받아 게시한다(CLAW-209). 워크플로는 tarball을 다시 빌드하지 않고, 게시 전에 네 가지를 대조한다 — tarball SHA-256과 manifest, manifest 버전과 태그, tarball 안 `package.json` 버전과 태그, 패키지 이름. 하나라도 어긋나면 게시하지 않는다. 이미 올라간 버전이면 건너뛴다.

이미 잘라 둔 릴리스를 소급 게시하려면 Actions에서 `npm 게시` 워크플로를 태그를 지정해 실행한다.

```bash
gh workflow run "npm 게시" -f tag=v0.2.12
```

- 저장소 시크릿 `NPM_TOKEN`이 필요하다. 게시 권한이 있는 Granular Access Token(또는 Automation 토큰)을 쓴다 — 웹 로그인 세션은 게시할 때마다 2FA 코드를 요구해 워크플로에서 쓸 수 없다.
- 토큰이 비어 있으면 워크플로가 실패한다. 조용히 넘기면 게시가 다시 사람 기억에 의존하게 된다.
- 버전이 더 높으면 `latest` 태그는 자동으로 옮겨간다. 같은 버전 재게시는 거부되므로 덮어쓸 수 없다.

수동으로 올려야 하는 상황이라면 `--access public`을 빠뜨리지 않는다(스코프 패키지가 private으로 시도돼 402로 거부된다). 경로에는 `./`를 붙인다 — 없으면 npm이 `dist/clawad-cli.tgz`를 GitHub 저장소 축약형으로 오해해 ssh 접속을 시도하다 실패한다.

게시를 건너뛴 버전이 있으면 기존 사용자는 `clawad update`로 정상 갱신되지만 **새 설치자만 레지스트리의 옛 버전에서 시작한다.** 실제로 0.1.21·0.1.22가 그렇게 빠졌고, 신규 설치자는 Codex 훅이 없는 0.1.20을 받았다. 설치 경로에 들어간 마이그레이션도 실행되지 않는다.

```bash
npm view @clawad/cli version
```

## 사용자 설치

Node.js 24 이상과 Claude Code를 먼저 설치한다. 저장소 clone은 필요하지 않다. 사용자 안내에는 항상 레지스트리 스펙 `@clawad/cli@latest`를 쓴다. 버전 고정 스펙은 특정 버전 재현이 필요할 때만 예외적으로 안내한다 — 안내를 놓친 테스터가 구버전에 묶이는 것을 막기 위해서다.

**tarball URL을 사용자 안내에 쓰지 않는다** (CLAW-145). URL 설치는 npm `allow-remote` 설정을 끈 환경에서 `EALLOWREMOTE`로 거부되고, 실제 파일이 오는 `release-assets.githubusercontent.com`이 `github.com`과 별개 도메인이라 사내 방화벽에서 조용히 끊긴다. 레지스트리 스펙은 버전 범위로 해석되므로 `allow-remote` 검사 대상 자체가 아니다. 레지스트리까지 막힌 환경에서는 GitHub Release의 tarball을 내려받아 로컬 파일 경로로 실행하는 경로를 안내한다. 관리형 Windows에서는 로그온 트리거 예약 작업 등록에 관리자 권한이 필요할 수 있으며, 실패해도 주기 sync는 등록되고 설치는 계속된다.

### macOS·Linux

```bash
npx --yes @clawad/cli@latest setup
```

### Windows PowerShell

```powershell
npx.cmd --yes @clawad/cli@latest setup
```

`npx --yes clawad ...`처럼 버전 태그가 없는 별칭은 과거에 만든 `_npx` 실행 트리와 그
`package-lock.json`을 재사용할 수 있다. 레지스트리에 새 버전이 게시돼도 CLI만 구버전으로 남을 수
있으므로 사용자 설치·1회성 관리 안내는 반드시 `@clawad/cli@latest`를 쓴다. 설치 출력이 현재
버전이 npm 최신보다 오래됐다고 경고하면 아래처럼 npx 캐시를 비우고 다시 설치한다. 레지스트리
조회가 오프라인·사내 프록시 때문에 실패해도 설치 자체는 계속된다.

```bash
npm cache rm --force _npx
npx --yes @clawad/cli@latest setup
```

공급자 선택과 약관 동의는 웹 로그인 페이지가 처리한다(CLAW-100). CLI는 `webOrigin`에 `cli_return`(loopback 복귀 주소)을 붙여 브라우저를 열고, 동의 후 돌아온 1회성 handoff code만 세션으로 교환한다. 내부 토큰은 브라우저 주소를 거치지 않는다. `setup`은 Node 버전, 런타임 파일 읽기 권한, Claude 설정 쓰기 권한을 진단하고 활동 감지 훅·자동 sync를 설치한 뒤 소셜 로그인을 시작한다. **statusLine 슬롯은 점유하지 않는다** (CLAW-134) — 0.1.11 이하가 점유한 슬롯은 설치 시 백업에서 원상복구하고 백업을 소비한다.

## 관리와 업데이트

`setup`은 배포 패키지의 `bin`(`clawad`)을 전역으로도 설치한다(CLAW-103). 상시 관리 명령은 짧은 형태를 1순위로 안내한다.

```bash
clawad login
clawad status
clawad pause
clawad resume
clawad update
clawad uninstall
```

전역 설치는 **선택 단계**다. 관리형 환경에서 권한이 없어 실패해도 설치는 계속되며, 이때는 안내가 아래 `npx` 형태로 자동으로 되돌아간다. 설치 없이 1회성으로 실행할 때도 같은 형태를 쓴다.

```bash
npx --yes @clawad/cli@latest status
npx --yes @clawad/cli@latest update
```

전역 설치에는 `distribution.json`의 버전 고정 `packageSpec`(`@clawad/cli@{version}`)을 쓴다. 버전을 고정해 무결성 계약을 유지하되 npm이 실행하는 설치 스펙은 레지스트리 경로여야 한다 — tarball URL로 `npm install -g`를 하면 `allow-remote`를 끈 관리형 PC에서 전역 설치 단계가 통째로 실패한다(CLAW-145). 전역 바이너리는 설치 시점 버전에 고정되므로, `clawad update`로 올라가는 `~/.clawad/releases/{version}` 런타임과 버전이 어긋날 수 있다. 훅과 수거가 실제로 실행하는 것은 런타임이며, 전역 바이너리까지 갱신하려면 `setup`을 다시 실행한다. `uninstall`은 전역 명령도 함께 제거한다(rules §7 원상복구).

최초 setup은 npm 임시 캐시가 정리돼도 동작하도록 검증된 런타임을 `~/.clawad/releases/{version}`에 고정한다. 업데이트는 배포 패키지에 고정된 HTTPS manifest를 읽고 tarball의 SHA-256을 검증한다. 새 버전은 기존 버전과 다른 디렉터리에 설치되며, 활동 감지 훅 health check와 자동 sync 등록이 모두 성공한 뒤 활성화된다. 실패하면 새 디렉터리를 제거하고 이전 버전 설정과 스케줄러를 다시 설치한다.

배포물의 `distribution.json`은 `apiOrigin`(운영 API), `webOrigin`(로그인 페이지), `releaseManifestUrl`(업데이트 manifest), `packageUrl`(`update`가 SHA-256을 대조할 버전 고정 tarball), `packageSpec`(설치·안내에 쓰는 레지스트리 스펙) 다섯 값을 담는다. **두 값은 역할이 다르다** — `packageUrl`은 무결성 계약이라 URL을 유지하고, npm에 넘기는 설치 스펙만 `packageSpec`으로 분리했다(CLAW-145). 저장소 없이 설치한 사용자에게는 `npm run clawad:*` 스크립트가 존재하지 않으므로, 클라이언트는 전역 `clawad` 명령이 있으면 그것을, 없으면 이 `packageSpec`으로 실행 가능한 `npx` 명령을 안내한다. `packageSpec`이 없는 옛 배포물에서는 `packageUrl`로 되돌린다. 전역 명령 설치 여부는 `~/.clawad/cli-binary.json`에 기록하며, `userCommand()`는 프로세스 실행 없이 이 파일만 읽어 판단한다. 다섯 값 모두 공개 정보이며 비밀값을 담지 않는다.

운영 릴리스에서는 `CLAWAD_SERVER`를 사용자 설치 명령에 전달하지 않는다. 로컬 개발·격리 테스트에서만 환경변수 override를 사용한다.
