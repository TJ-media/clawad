# Google·Kakao·Naver OAuth 운영 공개 런북

3개 지원 OS와 Google·Kakao·Naver의 실제 계정 검증은 [알파 E2E Go/No-Go 런북](./alpha-e2e-runbook.md)을 따른다.

운영 앱은 개발 앱과 분리한다. 앱 키와 시크릿은 비밀 관리자에만 저장하고 저장소, 이미지, CI 아티팩트, URL, 로그에 넣지 않는다. 클로애드는 Google·Kakao에서 `openid`만 요청하고, Naver에서는 이용자 식별자만 조회한다.

아래 `{API_ORIGIN}`은 `SOCIAL_CALLBACK_BASE_URL`과 같은 경로 없는 HTTPS origin이다.

| 공급자 | 운영 callback URI |
| --- | --- |
| Google | `{API_ORIGIN}/v1/auth/social/google/callback` |
| Kakao | `{API_ORIGIN}/v1/auth/social/kakao/callback` |
| Naver | `{API_ORIGIN}/v1/auth/social/naver/callback` |

## 공급자 콘솔 공개

### Google

1. 개발 프로젝트와 분리된 운영 Google Cloud 프로젝트에서 OAuth 웹 애플리케이션 client를 만든다.
2. Branding의 홈페이지·개인정보처리방침·서비스 약관을 소유권이 확인된 공개 도메인으로 등록한다.
3. Audience를 External로 구성하고 운영 공개 상태로 전환한다. 브랜드 검증 요청이 표시되면 완료한다.
4. 위 Google callback을 Authorized redirect URI에 정확히 등록한다. 와일드카드나 HTTP 운영 URI를 등록하지 않는다.
5. Data Access에는 현재 코드가 요청하는 `openid` 외 scope를 추가하지 않는다.

참고: [Google OAuth production readiness](https://developers.google.com/identity/protocols/oauth2/production-readiness/overview), [OAuth 2.0 policies](https://developers.google.com/identity/protocols/oauth2/policies)

### Kakao

1. 운영 Kakao Developers 앱의 REST API 키를 client ID로 사용한다.
2. Kakao Login 사용 설정과 OpenID Connect를 모두 ON으로 설정한다.
3. REST API 키 설정에 위 Kakao callback을 등록한다.
4. Kakao Login용 Client secret을 발급·활성화하고 비밀 관리자에 저장한다. 테스트 앱 키를 운영에 사용하지 않는다.
5. 불필요한 개인정보 동의항목을 활성화하지 않는다.

참고: [Kakao Login 설정](https://developers.kakao.com/docs/ko/kakaologin/prerequisite), [Kakao 앱 Client secret](https://developers.kakao.com/docs/ko/app-setting/app)

### Naver

1. 운영 Naver Developers 애플리케이션에서 네이버 로그인을 사용 API로 선택한다.
2. 서비스 URL과 위 Naver callback을 등록하고, 제공 정보는 로그인 식별에 필요한 최소 항목만 선택한다.
3. 개발자 계정이 아닌 일반 계정 사용을 위해 네이버 로그인 검수를 신청하고 승인 상태를 확인한다.
4. 발급된 운영 Client ID/Secret을 비밀 관리자에 저장한다.

참고: [Naver Login 개발 가이드](https://developers.naver.com/docs/login/devguide/devguide.md)

## 배포와 공개 검증

비밀 관리자에서 다음 값을 주입한다. 세 공급자를 공개할 때 각 `ENABLED`는 `true`여야 한다.

```text
SOCIAL_GOOGLE_ENABLED=true
SOCIAL_GOOGLE_CLIENT_ID=...
SOCIAL_GOOGLE_CLIENT_SECRET=...
SOCIAL_KAKAO_ENABLED=true
SOCIAL_KAKAO_CLIENT_ID=...
SOCIAL_KAKAO_CLIENT_SECRET=...
SOCIAL_NAVER_ENABLED=true
SOCIAL_NAVER_CLIENT_ID=...
SOCIAL_NAVER_CLIENT_SECRET=...
SOCIAL_CALLBACK_BASE_URL=https://api.example.com
SOCIAL_RETURN_ALLOWLIST=https://app.example.com
PUBLIC_WEB_ORIGIN=https://app.example.com
PUBLIC_RELEASE_STAGE=alpha
SOCIAL_METRICS_RETENTION_DAYS=30
```

배포 후 `npm run infra:prod:oauth-check -- https://api.example.com https://app.example.com/auth/callback`으로 세 authorization URL의 공급자 host, callback, 최소 scope와 URL 내 시크릿 부재를 확인한다. 이어 앱 멤버·테스트 사용자로 등록되지 않은 외부 계정으로 각 공급자에서 다음을 수동 검증한다.

- 최초 로그인과 필수 약관 동의 후 가입
- 로그아웃 후 동일 계정 재로그인
- 로그인 상태에서 다른 공급자 연결과 연결 해제
- 등록하지 않은 redirect URI 및 `SOCIAL_RETURN_ALLOWLIST` 밖 return target 거절

운영 성공·실패는 SUPERADMIN JWT로 `GET /admin/v1/auth/social/metrics`에서 확인한다. Redis에는 공급자, 성공·취소 횟수와 안전한 내부 오류 코드별 일일 합계만 저장하며 토큰, authorization code, subject, 이메일은 저장하지 않는다. 합계는 `SOCIAL_METRICS_RETENTION_DAYS`가 지난 뒤 자동 삭제한다(운영 기본 30일, 최대 90일).

## 시크릿 교체

1. 공급자 콘솔에서 새 secret을 생성할 수 있으면 기존 값을 유지한 채 새 값을 발급한다.
2. 비밀 관리자의 해당 `CLIENT_SECRET`을 새 값으로 갱신하고 API를 재배포한다.
3. 외부 계정 로그인과 운영 메트릭을 확인한 뒤 기존 secret을 폐기한다.
4. 공급자가 동시 secret을 지원하지 않으면 점검 창을 공지하고, 재발급 직후 비밀 관리자 갱신·재배포·외부 로그인을 연속 수행한다.

secret 원문이나 이전 값을 작업 티켓과 배포 로그에 남기지 않는다.

## 공급자 장애와 비활성화

특정 공급자의 실패율이 증가하면 해당 `SOCIAL_{PROVIDER}_ENABLED=false`로 바꾸고 API를 재배포한다. 해당 공급자의 신규 로그인·연결 시작은 `PROVIDER_NOT_ENABLED`로 닫히며 다른 공급자와 기존 클로애드 세션은 유지된다. 복구 후 callback·OIDC 설정과 외부 계정 로그인을 확인하고 다시 `true`로 배포한다.

장애 기록에는 시간, 공급자, 안전한 오류 코드, 영향 범위와 조치만 남기고 공급자 응답 본문·토큰·subject는 남기지 않는다.
