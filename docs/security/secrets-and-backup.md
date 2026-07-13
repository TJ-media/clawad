# 시크릿 관리·백업·복구 정책 (CLAW-27)

> 상태: 알파 운영 기준. 관리자 권한·감사로그는 코드로 강제되고(아래 §1), 시크릿·백업은 운영 절차로 강제한다.

## 1. 관리자 권한·감사로그 (코드로 강제)

- 관리자 계정은 사용자 계정(`users`)과 **분리된 테이블**(`admin_users`)이다. 역할: `SUPERADMIN` / `REVIEWER`(심사·전이) / `SETTLER`(정산).
- 정적 관리 토큰(구 `ADMIN_API_TOKEN`)은 **폐기**했다. 관리자는 이메일·비밀번호로 로그인해 역할 클레임을 담은 단기 JWT를 받는다(`ADMIN_JWT_SECRET` 서명, 기본 30분).
- 역할 매핑: 광고주·캠페인·소재 생성·킬스위치·관리자 생성 = SUPERADMIN / 캠페인 전이·소재 심사 = REVIEWER / 예산·리워드 정산 = SETTLER / 조회 = 인증된 모든 관리자.
- **모든 변경 조작(POST/PUT/PATCH/DELETE)은 실행 전에 `audit_logs`에 기록**한다. 기록에 실패하면 조작을 차단한다(이슈 예외 조항). `audit_logs`는 append-only(DB 트리거)이며 비밀값·PII(비밀번호·토큰·이메일)를 마스킹한다.
- 접속 IP를 `admin_users`·`audit_logs`에 저장하지 않는다(privacy-design.md §6.6).

## 2. 시크릿 관리

다음 비밀값은 **코드·레포에 반입하지 않는다.** 로컬은 `.env`(gitignore), 운영은 시크릿 매니저로 주입한다.

| 시크릿 | 용도 | 비고 |
|---|---|---|
| `AUTH_JWT_SECRET` | 사용자 인증 토큰 서명 | 32B+ |
| `SERVE_TOKEN_SECRET` | serveToken 서명 (CLAW-18) | 32B+, 인증 키와 분리 |
| `ADMIN_JWT_SECRET` | 관리자 토큰 서명 | 32B+, 위 둘과 분리 |
| `DB_PASSWORD` | PostgreSQL 자격증명 | |
| `SOCIAL_{GOOGLE,KAKAO,NAVER}_CLIENT_ID/SECRET` | 소셜 로그인 (CLAW-37) | 공급자 콘솔 발급값. 둘 다 설정된 공급자만 활성 |
| 지급대행사 API 키 | 쿠폰 발송 (CLAW-26) | 미구현. 도입 시 시크릿 매니저 |

원칙:
- 코드에 공개 fallback 기본값을 두지 않는다. 시크릿이 없거나 32바이트 미만이면 기동·서명을 실패시킨다(현재 구현).
- 세 서명 키(`AUTH`/`SERVE_TOKEN`/`ADMIN`)는 **서로 다른 값**을 쓴다. 한 키 유출이 다른 도메인으로 번지지 않게 한다.
- `.env`·`.env.local`은 `.gitignore` 대상이다. `.env.example`에는 값 없이 키 이름과 생성법만 둔다.
- 로그에 비밀값·토큰 원문·이메일·쿠폰 수신정보를 남기지 않는다(privacy-design.md §6.5).

### 키 로테이션 (절차)
- 서명 키 교체 시 무중단을 위해 (필요하면) 이중 검증 기간을 둔다. 알파에서는 짧은 점검 창에서 교체 후 기존 토큰 만료를 기다린다.
- 부트스트랩 SUPERADMIN 비밀번호(`ADMIN_BOOTSTRAP_PASSWORD`)는 최초 1회용이다. 운영 배포 후 즉시 실제 관리자를 만들고 부트스트랩 계정을 비활성화한다.

## 3. 서버 킬스위치 (구현됨)

- 특정 머신/회원/캠페인을 수집·서빙에서 즉시 차단한다(`kill_switches`, CLAW-6). SUPERADMIN만 켜고 끈다.
- 노출 검증 파이프라인이 시작 전에 대상을 조회해 `KILLED`로 거절한다.

## 4. 백업·복구 정책 (운영 절차)

원장 무결성이 서비스의 핵심이므로 원장 테이블을 우선 보호한다.

**대상 (append-only 원장):**
- `billing_ledger`(광고주 과금), `reward_ledger`(사용자 리워드), `impression_events`(광고 이벤트), `audit_logs`(감사)
- 상태 테이블: `users`·`admin_users`·`campaigns`·`machines`·`consents` 등

**정책:**
- **일일 전체 백업** + 시점 복구(PITR)를 위한 WAL 아카이빙. 원장은 append-only이므로 스냅샷 간 손실 위험이 낮다.
- 백업은 DB와 **분리된 스토리지**에 보관하고 전송·저장을 암호화한다.
- 보유기간은 세법·전자상거래법상 지급·세무 기록 보관 요건을 따른다(privacy-design.md §4, 정확한 연수는 CLAW-13 결론 반영).
- **복구 리허설**을 정기적으로 수행한다: 백업에서 별도 인스턴스로 복원 → 원장 합산 잔액이 사고 이전과 일치하는지 검증(광고주 가용 예산·사용자 확정 리워드).
- 복구 후에는 `audit_logs`로 마지막 정상 시점 이후의 조작을 재검토한다.

**미확정 (운영 확정 필요):**
- 정확한 백업 주기·보유 연수·PITR 윈도, 리허설 주기 → 인프라 구성 확정 시 기입.

## 5. 소셜 로그인 운영 선행조건 (CLAW-37)

공개 사용자 로그인은 Google·Kakao·Naver 전용이다. 코드 배포와 별개로 아래 앱 등록·검수가 선행돼야 실제 로그인이 동작한다.

**공급자 앱 등록 (client id/secret 발급):**
- [ ] **Google Cloud Console** — OAuth 동의 화면 구성(scope는 `openid`만), "웹 애플리케이션" OAuth 2.0 클라이언트 생성. 승인된 리디렉션 URI에 `{SOCIAL_CALLBACK_BASE_URL}/v1/auth/social/google/callback`(개발·운영 각각) 등록.
- [ ] **Kakao Developers** — 앱 생성, REST API 키(=client id) 확보, **카카오 로그인 + OpenID Connect 활성화**, Client Secret 활성화(권장), Redirect URI 등록, 동의항목 `openid`만.
- [ ] **Naver Developers** — 애플리케이션 등록, Client ID/Secret 발급, Callback URL 등록. Naver는 표준 OIDC id_token이 아니라 OAuth2 + userinfo(`/v1/nid/me`, subject=`response.id`)를 쓴다. **공개 서비스 전 네이버 로그인 검수 신청 필수**(개발 중엔 등록 개발자 계정만 로그인 가능).

**시크릿·설정 주입:**
- [ ] `SOCIAL_{GOOGLE,KAKAO,NAVER}_CLIENT_ID/SECRET`를 시크릿 매니저로 주입(레포 커밋 금지). 둘 다 설정된 공급자만 활성화된다.
- [ ] `SOCIAL_CALLBACK_BASE_URL`을 공급자 콘솔에 등록한 값과 정확히 일치시킨다. 운영은 HTTPS.
- [ ] `SOCIAL_RETURN_ALLOWLIST`에 user-web origin을 넣는다. CLI loopback(`127.0.0.1`)은 별도로 항상 허용된다. 임의 외부 URL redirect는 거절된다.

**legacy identity cutover (DB):**
- [ ] cutover 전 환경별 EMAIL/GITHUB identity 수를 집계한다. 신규 migration은 KAKAO·NAVER enum과 `UNIQUE(userId, provider)` 인덱스만 추가하며 기존 EMAIL/GITHUB 행을 삭제·병합하지 않는다.
- [ ] `UNIQUE(userId, provider)`는 한 사용자에 동일 provider identity가 둘 이상이면 실패한다 — 마이그레이션 전 중복 행이 없는지 확인한다.
- [ ] enum/컬럼 제거는 legacy 행이 없음을 확인한 뒤 **별도 후속 migration**에서만 검토한다.

**보안 불변식(코드로 강제, 확인용):**
- [ ] 공급자 code/token·client secret·내부 JWT/refresh 토큰·이메일·subject를 URL·응답 오류·로그에 남기지 않는다.
- [ ] 콜백 결과는 Redis 짧은 TTL·1회성 handoff code로만 전달(재사용·만료는 거절). 내부 토큰을 redirect URL에 넣지 않는다.

## 6. 후속

- 운영자 콘솔 UI는 CLAW-25.
- 지급대행사 API 키 관리는 CLAW-26(세무·전자금융 결론 후).
