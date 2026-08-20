# 클로애드 설계 문서 (docs/)

클로애드 설계·정책·운영 문서 디렉토리. P0(CLAW-9) 정책·설계에서 시작해, 현재 P1(CLAW-10) 알파 운영 단계의 설계·운영·법무 공개본 문서까지 포함한다.

> **정책값 단일 원본**: 리워드 단가·상한·간격·기기·토큰 정책은 [`../policy/reward-policy.default.json`](../policy/reward-policy.default.json)에서 관리한다(코드 하드코딩 금지, 검증기 `../policy/policy.js`). 서버 권위 검증·기기제한·동시노출·캠페인유형 참조 구현은 `../apps/api/src/events`에 있다(공용 검증 모듈은 `../server/lib/`).

| 문서 | 이슈 | 성격 | 상태 |
|---|---|---|---|
| [product/revenue-reward-policy.md](product/revenue-reward-policy.md) | CLAW-12 | 정책(확정) | 초안 확정 |
| [legal/tax-income-inquiry.md](legal/tax-income-inquiry.md) | CLAW-13 | 세무 질의·검토 | 세무사 서면 답변 대기 |
| [legal/efaa-review.md](legal/efaa-review.md) | CLAW-14 | 전금법 검토 | 법률 검토 대기 |
| [legal/privacy-design.md](legal/privacy-design.md) | CLAW-15 | 개인정보 설계·방침 초안 | 법률 검토 대기 |
| [legal/terms-of-service.md](legal/terms-of-service.md) | CLAW-16 | 이용약관 초안 | 법률 검토 대기 |
| [design/ledgers.md](design/ledgers.md) | CLAW-17 | 4원장 데이터 설계 | 확정 |
| [design/impression-verification.md](design/impression-verification.md) | CLAW-18 | serveToken 노출 검증 | 확정 |
| [design/policy-snapshots.md](design/policy-snapshots.md) | CLAW-44 | 결정 시점 정책 스냅샷·감사 추적 | 확정 |
| [design/overlay-contract.md](design/overlay-contract.md) | CLAW-90 | 오버레이↔CLI 로컬 파일 협약 | 확정 |
| [product/invalid-traffic-policy.md](product/invalid-traffic-policy.md) | CLAW-19 | 무효 트래픽·회수·이의제기 | 확정 |
| [product/ad-review-policy.md](product/ad-review-policy.md) | CLAW-20 | 광고 심사·금지 업종 | 확정 |
| [product/alpha-reward-benchmark.md](product/alpha-reward-benchmark.md) | — | 알파 리워드 벤치마크·예산 분석 | 참고 |
| [product/fulfillment-vendor-research.md](product/fulfillment-vendor-research.md) | CLAW-26 | 쿠폰 지급대행사 리서치 | 준비(연동은 CLAW-13·14 후) |
| [design/user-shop-ui.md](design/user-shop-ui.md) | CLAW-36 | 사용자 리워드 샵 웹 설계 | 설계 |
| [security/secrets-and-backup.md](security/secrets-and-backup.md) | CLAW-27 | 시크릿 관리·백업/복구 | 운영 절차 |

## 운영·법무 공개본·기타

- **운영 런북**: [`operations/`](operations/) — 배포(`production-deployment.md`), 장애 대응(`incident-response.md`), 백업·복제(`backup-replication.md`), OAuth 운영(`oauth-production.md`), 알파 E2E·리허설·용량(`alpha-*.md`), 클라이언트 배포(`client-distribution.md`).
- **법무 공개본**: [`legal/public/`](legal/public/) — 실제 게시되는 처리방침(privacy v1~v3, 현행 v3)·이용약관(terms v1~v2, 현행 v2)·제거 안내. 서버 `legal-documents` 모듈이 단조 활성화로 서빙한다.
- **제품 가이드**: [`product/mascot-theme-guide.md`](product/mascot-theme-guide.md), [`product/theme-authoring-guide.md`](product/theme-authoring-guide.md), [`product/alpha-tester-reward-guide.md`](product/alpha-tester-reward-guide.md), [`product/revenue-reward-policy.md`](product/revenue-reward-policy.md).
- **설계 보강**: [`superpowers/`](superpowers/) — 통합 CLI·오버레이 업데이트 계획·스펙.

> **면책**: `legal/` 문서는 실무 초안이며 변호사·세무사의 개별 검토 없이 실제 서비스에 적용하지 않는다. 법률·세무 판단은 반드시 전문가 서면 확인을 거친다.
