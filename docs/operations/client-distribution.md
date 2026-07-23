# 사용자용 CLI 배포·업데이트

CLAW-62의 배포 산출물은 `client/`, `policy/`와 실행에 필요한 메타데이터만 포함하는 버전 고정 npm tarball이다. 서버 코드, 운영 `.env`, OAuth·관리자 비밀정보는 포함하지 않는다.

## 릴리스 생성

운영 API와 GitHub Release URL을 명시해 빌드한다. 세 값은 모두 자격증명 없는 HTTPS여야 하며 API 값은 경로 없는 origin이어야 한다.

```bash
CLAWAD_RELEASE_API_ORIGIN=https://api.clawad.whatsup.house \
CLAWAD_RELEASE_WEB_ORIGIN=https://clawad.whatsup.house \
CLAWAD_RELEASE_MANIFEST_URL=https://github.com/TJ-media/clawad/releases/latest/download/manifest.json \
CLAWAD_RELEASE_PACKAGE_URL=https://github.com/TJ-media/clawad/releases/download/v0.1.5/clawad-cli.tgz \
npm run client:release
```

빌드는 tarball을 `CLAWAD_RELEASE_PACKAGE_URL`의 파일명(`clawad-cli.tgz`)으로 만들어 둔다. **이 파일명을 바꿔 업로드하면 manifest의 packageUrl과 어긋나 모든 `update`가 실패한다.** manifest의 `packageUrl`은 `latest`가 아니라 버전 고정 태그 경로를 가리켜야 한다.

## 릴리스 게시

태그와 `package.json` 버전이 같아야 한다. `dist/client-release/`의 tarball과 `manifest.json`을 같은 Release에 올린다.

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

## 사용자 설치

Node.js 24 이상과 Claude Code를 먼저 설치한다. 저장소 clone은 필요하지 않다. 사용자 안내에는 항상 최신 릴리스를 가리키는 `releases/latest/download` URL을 쓴다. 버전 고정 URL은 특정 버전 재현이 필요할 때만 예외적으로 안내한다 — 안내를 놓친 테스터가 구버전에 묶이는 것을 막기 위해서다. 관리형 Windows에서는 로그온 트리거 예약 작업 등록에 관리자 권한이 필요할 수 있으며, 실패해도 주기 sync는 등록되고 설치는 계속된다.

### macOS·Linux

```bash
npx --yes https://github.com/TJ-media/clawad/releases/latest/download/clawad-cli.tgz setup
```

### Windows PowerShell

```powershell
npx.cmd --yes https://github.com/TJ-media/clawad/releases/latest/download/clawad-cli.tgz setup
```

공급자 선택과 약관 동의는 웹 로그인 페이지가 처리한다(CLAW-100). CLI는 `webOrigin`에 `cli_return`(loopback 복귀 주소)을 붙여 브라우저를 열고, 동의 후 돌아온 1회성 handoff code만 세션으로 교환한다. 내부 토큰은 브라우저 주소를 거치지 않는다. `setup`은 Node 버전, 런타임 파일 읽기 권한, Claude 설정 쓰기 권한을 진단하고 statusLine·자동 sync를 설치한 뒤 소셜 로그인을 시작한다. 기존 statusLine과 훅은 로컬 데이터 디렉터리(`~/.clawad`)에 백업한다.

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
npx --yes https://github.com/TJ-media/clawad/releases/latest/download/clawad-cli.tgz status
npx --yes https://github.com/TJ-media/clawad/releases/latest/download/clawad-cli.tgz update
```

전역 설치에는 `distribution.json`의 버전 고정 `packageUrl`을 쓴다(무결성 계약 유지). 전역 바이너리는 설치 시점 버전에 고정되므로, `clawad update`로 올라가는 `~/.clawad/releases/{version}` 런타임과 버전이 어긋날 수 있다. 상태줄이 실제로 실행하는 것은 런타임이며, 전역 바이너리까지 갱신하려면 `setup`을 다시 실행한다. `uninstall`은 전역 명령도 함께 제거한다(rules §7 원상복구).

최초 setup은 npm 임시 캐시가 정리돼도 동작하도록 검증된 런타임을 `~/.clawad/releases/{version}`에 고정한다. 업데이트는 배포 패키지에 고정된 HTTPS manifest를 읽고 tarball의 SHA-256을 검증한다. 새 버전은 기존 버전과 다른 디렉터리에 설치되며, statusLine health check와 자동 sync 등록이 모두 성공한 뒤 활성화된다. 실패하면 새 디렉터리를 제거하고 이전 버전 설정과 스케줄러를 다시 설치한다. 재설치는 최초 백업을 덮어쓰지 않으며 제거 시 설치 전 statusLine을 복원한다.

배포물의 `distribution.json`은 `apiOrigin`(운영 API), `webOrigin`(로그인 페이지), `releaseManifestUrl`(업데이트 manifest), `packageUrl`(설치에 사용한 버전 고정 tarball) 네 값을 담는다. 저장소 없이 설치한 사용자에게는 `npm run clawad:*` 스크립트가 존재하지 않으므로, 클라이언트는 전역 `clawad` 명령이 있으면 그것을, 없으면 이 `packageUrl`로 실행 가능한 `npx` 명령을 안내한다. 전역 명령 설치 여부는 `~/.clawad/cli-binary.json`에 기록하며, 핫패스(statusline)의 `commandHint()`는 프로세스 실행 없이 이 파일만 읽어 판단한다. 네 값 모두 공개 정보이며 비밀값을 담지 않는다.

운영 릴리스에서는 `CLAWAD_SERVER`를 사용자 설치 명령에 전달하지 않는다. 로컬 개발·격리 테스트에서만 환경변수 override를 사용한다.
