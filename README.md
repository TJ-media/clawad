# 클로애드 (ClawAd)

<p align="center">
  <img src="apps/user-web/logo.png" alt="클로애드 로고" width="140" />
</p>

클로애드는 개발자 대상 광고를 Claude Code 상태줄에 제공하고, 서버가 검증한 광고 노출에 따라 **비현금성 리워드**를 지급하는 광고 매체 플랫폼입니다.

> **현재 상태:** 클로애드는 알파 테스트 단계입니다. 현재 제품 런타임은 Claude Code의 `statusLine` 훅을 지원하며, Codex·VS Code·Cursor용 광고 어댑터는 아직 제공하지 않습니다.

## 핵심 원칙

- 광고에는 항상 `[광고]`를 표시합니다.
- 같은 광고가 5초 이상 연속 표시된 경우에만 노출 사실을 기록합니다.
- 상태줄 핫패스는 네트워크를 호출하지 않고 로컬 광고 캐시만 읽습니다.
- 클라이언트는 금액·리워드·유효 노출 여부를 결정하지 않습니다. 서버가 서명된 토큰과 정책을 검증해 승인분만 반영합니다.
- 리워드는 지정 상품 교환에 사용하는 비구매형·비양도형 포인트이며 충전·양도·현금 환급을 지원하지 않습니다.
- 프롬프트, Claude 응답, 소스코드, 파일명·경로, Git 저장소명, 터미널 명령어, 환경변수, 클립보드는 수집하지 않습니다.

정책과 개인정보 처리에 관한 자세한 내용은 [프로젝트 문서](docs/README.md)와 [검토 중인 법률 문서 공개 후보](docs/legal/public/README.md)를 참고하세요.

## 동작 방식

1. `client/sync.js`가 사용자 기기를 등록하고 서버에서 서명된 `serveToken`과 광고를 미리 받아 로컬 캐시에 저장합니다.
2. `client/statusline.js`는 네트워크 없이 캐시를 읽어 `[광고]`가 포함된 한 줄을 출력합니다.
3. 동일한 광고가 5초 이상 연속 표시되면 클라이언트는 노출 토큰, 순번, 가명 기기 식별자, 시작·종료 시각, 사용자 식별자, 클라이언트 버전 등 사실만 append-only 원장에 기록합니다.
4. `client/sync.js`가 미전송 기록을 업로드합니다. 서버에 연결할 수 없으면 로컬에 보관하고 다음 주기에 재시도합니다.
5. 서버가 토큰 서명·만료·동시 노출·계정 상한을 검증하고 서버 정책값으로 리워드와 과금을 계산합니다.

서버 멱등 키는 토큰 검증 후 `SHA-256(tokenJti:machineId:sequence)`로 생성됩니다. 클라이언트는 HMAC이나 서비스 비밀 키를 보유하지 않습니다.

## 설치

설치와 실행은 **TJ-media의 별도 서면 허가를 받은 사용자에게만 허용**됩니다. GitHub 저장소가 공개되어 있다는 사실은 설치·실행·수정·재배포 권한을 의미하지 않습니다.

### 준비물

- Node.js 24 이상
- 설치되어 있는 Claude Code
- Windows, macOS 또는 Linux
- TJ-media가 안내한 버전 고정 설치 패키지 URL

### 알파 테스트 사용자

안내받은 `<설치 패키지 URL>`을 실제 HTTPS `.tgz` 주소로 바꿔 실행합니다. 저장소를 clone할 필요는 없습니다.

macOS·Linux:

```bash
npx --yes <설치 패키지 URL> setup
```

Windows PowerShell:

```powershell
npx.cmd --yes <설치 패키지 URL> setup
```

설치 과정은 기존 Claude Code `statusLine` 설정을 먼저 백업하고, 클로애드 상태줄과 사용자 범위 자동 동기화를 등록한 다음 소셜 로그인을 시작합니다. 제거하면 설치 전 상태줄 설정을 복원합니다.

관리 명령도 설치에 사용한 동일한 버전 고정 패키지 URL을 사용합니다.

```bash
npx --yes <설치 패키지 URL> status
npx --yes <설치 패키지 URL> pause
npx --yes <설치 패키지 URL> resume
npx --yes <설치 패키지 URL> update
npx --yes <설치 패키지 URL> uninstall
```

체크섬 검증과 업데이트·롤백 계약은 [CLI 배포·업데이트 문서](docs/operations/client-distribution.md)에 설명되어 있습니다.

### 허가받은 개발자

저장소에서 직접 검증하거나 개발하려면 TJ-media의 별도 서면 허가가 필요합니다.

```bash
npm ci
npm run lint
npm test
```

주요 개발 명령:

```bash
npm run typecheck  # 루트 JavaScript와 apps/api TypeScript 검사
npm run server     # 무의존성 참조 PoC 서버, 기본 http://localhost:8787
npm run infra:up   # PostgreSQL·Redis 개발 환경
npm run api:start  # NestJS API 서버
npm run api:e2e    # PostgreSQL·Redis 기반 API e2e
```

## 프로젝트 구조

```text
clawad/
├── client/            # Claude Code 상태줄, 동기화, 로그인, 설치·복구
├── apps/api/          # NestJS 운영 API
├── apps/user-web/     # 사용자 리워드 샵과 설치 안내
├── apps/admin-web/    # 운영자 콘솔
├── policy/            # 리워드 정책 단일 원본과 검증기
├── server/            # node:http 기반 참조 PoC
├── docs/              # 제품·보안·개인정보·운영 문서
├── test/              # node:test 스모크·회귀 테스트
└── data/              # 로컬 런타임 데이터, Git 제외
```

JavaScript·Node.js 24+·CommonJS를 사용합니다. 클라이언트 런타임은 Node.js 내장 모듈만 사용합니다.

## 현재 범위

- Claude Code `statusLine` 광고 표시와 오프라인 캐시
- Google·Kakao·Naver 소셜 로그인과 계정 연결
- 서버 권위 노출 검증, 중복 방지, 계정 단위 기기·동시 노출 정책
- 광고주·캠페인·소재·예산 운영 기능
- 예상 적립, 검증 중, 확정 리워드, 모바일 쿠폰 교환 흐름
- 운영 배포, 관측, 백업·복구와 롤백 도구

향후 확장 후보에는 VS Code 익스텐션과 Codex·Cursor 어댑터가 포함되지만 현재 지원 기능은 아닙니다.

## 라이선스

이 저장소는 공개되어 있지만 **오픈소스가 아닙니다**.

[ClawAd Source Viewing License 1.0](LICENSE)은 다음 범위만 허용합니다.

- 소스 열람, 정적 보안 검토와 평가에 필요한 복제
- 같은 목적의 수정하지 않은 GitHub 포크

별도 서면 허가 없이는 실행·빌드·설치·수정·파생물 작성·재배포·상업 이용·호스팅·경쟁 서비스 제공이 금지됩니다. 구체적인 권리와 제한은 영문 라이선스 기준본을 따릅니다.

Copyright © 2026 TJ-media. All rights reserved.

## 독립 서비스·클린룸 고지

클로애드는 Anthropic 또는 Claude와 제휴·후원 관계가 없는 독립 서비스입니다.

이 프로젝트는 경쟁사의 비공개 자료나 원본 코드를 열람·인용·복제하지 않고, 공개된 제품 수준의 설명과 독자적으로 정의한 요구사항만을 바탕으로 클린룸 방식으로 구현합니다. 경쟁사에서 파생한 명칭을 코드·API·UI·마케팅에 사용하지 않습니다.
