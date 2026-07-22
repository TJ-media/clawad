# 사용자용 CLI 배포·업데이트

CLAW-62의 배포 산출물은 `client/`, `policy/`와 실행에 필요한 메타데이터만 포함하는 버전 고정 npm tarball이다. 서버 코드, 운영 `.env`, OAuth·관리자 비밀정보는 포함하지 않는다.

## 릴리스 생성

운영 API와 GitHub Release URL을 명시해 빌드한다. 세 값은 모두 자격증명 없는 HTTPS여야 하며 API 값은 경로 없는 origin이어야 한다.

```bash
CLAWAD_RELEASE_API_ORIGIN=https://api.clawad.whatsup.house \
CLAWAD_RELEASE_MANIFEST_URL=https://github.com/TJ-media/clawad/releases/latest/download/manifest.json \
CLAWAD_RELEASE_PACKAGE_URL=https://github.com/TJ-media/clawad/releases/download/v0.1.1/clawad-cli.tgz \
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
npx --yes https://github.com/TJ-media/clawad/releases/latest/download/clawad-cli.tgz setup google --accept-terms --accept-privacy
```

### Windows PowerShell

```powershell
npx.cmd --yes https://github.com/TJ-media/clawad/releases/latest/download/clawad-cli.tgz setup google --accept-terms --accept-privacy
```

`setup`에 넘긴 인자는 그대로 `login`으로 전달된다. 공급자와 동의 옵션을 함께 주면 설치와 로그인이 한 번에 끝나고, 생략하면 문서를 안내한 뒤 동의가 필요하다는 메시지와 함께 중단된다. `setup`은 Node 버전, 런타임 파일 읽기 권한, Claude 설정 쓰기 권한을 진단하고 statusLine·자동 sync를 설치한 뒤 소셜 로그인을 시작한다. 기존 statusLine과 훅은 로컬 데이터 디렉터리(`~/.clawad`)에 백업한다.

## 관리와 업데이트

관리 명령도 설치에 사용한 동일한 URL을 사용한다.

```bash
npx --yes https://github.com/TJ-media/clawad/releases/latest/download/clawad-cli.tgz login
npx --yes https://github.com/TJ-media/clawad/releases/latest/download/clawad-cli.tgz status
npx --yes https://github.com/TJ-media/clawad/releases/latest/download/clawad-cli.tgz pause
npx --yes https://github.com/TJ-media/clawad/releases/latest/download/clawad-cli.tgz resume
npx --yes https://github.com/TJ-media/clawad/releases/latest/download/clawad-cli.tgz update
npx --yes https://github.com/TJ-media/clawad/releases/latest/download/clawad-cli.tgz uninstall
```

최초 setup은 npm 임시 캐시가 정리돼도 동작하도록 검증된 런타임을 `~/.clawad/releases/{version}`에 고정한다. 업데이트는 배포 패키지에 고정된 HTTPS manifest를 읽고 tarball의 SHA-256을 검증한다. 새 버전은 기존 버전과 다른 디렉터리에 설치되며, statusLine health check와 자동 sync 등록이 모두 성공한 뒤 활성화된다. 실패하면 새 디렉터리를 제거하고 이전 버전 설정과 스케줄러를 다시 설치한다. 재설치는 최초 백업을 덮어쓰지 않으며 제거 시 설치 전 statusLine을 복원한다.

배포물의 `distribution.json`은 `apiOrigin`(운영 API), `releaseManifestUrl`(업데이트 manifest), `packageUrl`(설치에 사용한 버전 고정 tarball) 세 값을 담는다. 저장소 없이 설치한 사용자에게는 `npm run clawad:*` 스크립트가 존재하지 않으므로, 클라이언트는 이 `packageUrl`로 실행 가능한 `npx` 명령을 안내한다. 세 값 모두 공개 정보이며 비밀값을 담지 않는다.

운영 릴리스에서는 `CLAWAD_SERVER`를 사용자 설치 명령에 전달하지 않는다. 로컬 개발·격리 테스트에서만 환경변수 override를 사용한다.
