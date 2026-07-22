'use strict';

// 운영 DB 하우스 캠페인 → 유료(PAID) 전환과 예산 충전 (CLAW-101).
// production-seed-house-campaigns.js와 같은 방식으로 postgres 컨테이너에 직접 SQL을 실행한다.
//
// 알파 인벤토리를 실제 리워드가 붙는 유료 광고로 바꾼다. HOUSE는 광고주 매출도 미지급 리워드
// 부채도 만들지 않아 사용자가 적립을 체감할 수 없었다(CLAW-101 진단).
//
// 전환 후 발생하는 것:
// - 광고주 과금: billing_ledger에 DEPOSIT(+)을 넣고 노출마다 CAPTURE(-)가 쌓인다.
// - 사용자 리워드: eligibility(PAID) → rewardEligible=true (server/lib/campaign.js).
//
// 재실행 안전: 예산 입금은 idempotencyKey로 중복을 막고, 캠페인 전환은 이미 PAID면 건너뛴다.
// 소재(creatives)는 건드리지 않는다 — 문구 변경은 house 시드 스크립트가 담당한다.

const { runCompose } = require('./lib/production-compose');

/** 노출 단가(원). 정책의 defaultCpmKrw(1,000회당)에서 유도한다 — 코드에 CPM을 고정하지 않는다. */
const PRICE_PER_IMPRESSION_KRW = Math.round(
  require('../policy/policy').loadPolicy().advertiser.defaultCpmKrw / 1000,
);

/**
 * 광고주별 충전액(원). 광고주 예산을 소속 캠페인에 균등 배분한다 —
 * billing_ledger는 캠페인 단위 원장이라 광고주 단위 잔액이라는 개념이 없다.
 */
const ADVERTISER_BUDGET_KRW = {
  '클로애드': 300000,
  '와썹하우스': 1000000,
};

/** 전환 대상. house 시드가 등록한 캠페인 이름과 정확히 같아야 한다. */
const CAMPAIGNS = [
  { advertiser: '클로애드', campaign: '클로애드 만족도 조사' },
  { advertiser: '와썹하우스', campaign: '와썹하우스 퇴근게더링' },
  { advertiser: '와썹하우스', campaign: '와썹하우스 우연한식탁' },
];

/** 이 시드가 넣은 입금을 식별하는 접두사. 재실행 시 중복 입금을 막는다. */
const DEPOSIT_KEY_PREFIX = 'seed:paid-budget:v1';

function validate() {
  if (!Number.isInteger(PRICE_PER_IMPRESSION_KRW) || PRICE_PER_IMPRESSION_KRW <= 0) {
    throw new Error(`노출 단가가 양의 정수가 아닙니다: ${PRICE_PER_IMPRESSION_KRW}`);
  }
  for (const [advertiser, budget] of Object.entries(ADVERTISER_BUDGET_KRW)) {
    if (!Number.isInteger(budget) || budget <= 0) {
      throw new Error(`${advertiser} 충전액이 양의 정수가 아닙니다: ${budget}`);
    }
    const count = CAMPAIGNS.filter((c) => c.advertiser === advertiser).length;
    if (!count) throw new Error(`${advertiser}에 전환할 캠페인이 없습니다.`);
    if (budget % count !== 0) {
      throw new Error(`${advertiser} 충전액 ${budget}원을 캠페인 ${count}개로 나누어떨어지게 지정하세요.`);
    }
  }
  for (const { advertiser } of CAMPAIGNS) {
    if (!(advertiser in ADVERTISER_BUDGET_KRW)) throw new Error(`${advertiser}의 충전액이 없습니다.`);
  }
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function budgetFor(advertiser) {
  const count = CAMPAIGNS.filter((c) => c.advertiser === advertiser).length;
  return ADVERTISER_BUDGET_KRW[advertiser] / count;
}

function buildSql() {
  // 캠페인 전환: PAID는 pricePerImpressionKrw > 0이어야 한다(CK_campaigns_non_paid_zero_price는
  // 비유료만 0을 강제하므로, 유료 단가는 여기서 명시적으로 넣는다).
  // rewardPolicyId는 유지한다 — PAID는 rewardPolicyId 없이도 적립되지만 정산 추적용으로 남긴다.
  const conversions = CAMPAIGNS.map(({ campaign }) => `
    UPDATE campaigns SET type = 'PAID', "pricePerImpressionKrw" = ${PRICE_PER_IMPRESSION_KRW}
    WHERE name = ${sqlString(campaign)} AND type <> 'PAID';`).join('\n');

  // 예산 입금: append-only 원장에 DEPOSIT(+)을 넣는다. idempotencyKey UNIQUE가 재실행 중복을 막는다.
  // 잔액은 항상 SUM(amountKrw)으로 계산하므로 balance 필드를 만들지 않는다.
  const deposits = CAMPAIGNS.map(({ advertiser, campaign }) => {
    const key = `${DEPOSIT_KEY_PREFIX}:${campaign}`;
    return `
    INSERT INTO billing_ledger ("advertiserId", "campaignId", "entryType", "amountKrw", "idempotencyKey", reason, "unitPriceKrw")
    SELECT c."advertiserId", c.id, 'DEPOSIT', ${budgetFor(advertiser)}, ${sqlString(key)},
           'ALPHA_BUDGET_SEED', ${PRICE_PER_IMPRESSION_KRW}
    FROM campaigns c
    WHERE c.name = ${sqlString(campaign)}
      AND NOT EXISTS (SELECT 1 FROM billing_ledger WHERE "idempotencyKey" = ${sqlString(key)});`;
  }).join('\n');

  const total = Object.values(ADVERTISER_BUDGET_KRW).reduce((sum, v) => sum + v, 0);
  const auditNote = `유료 전환·예산 충전 ${CAMPAIGNS.length}건 총 ${total}원 (scripts/production-seed-paid-campaigns.js)`;
  const auditInsert = `
    INSERT INTO audit_logs ("actorAdminId", "actorRole", action, "targetId", params)
    VALUES (NULL, 'SYSTEM', 'PAID_CAMPAIGN_SEED', 'campaigns', ${sqlString(auditNote)});`;

  const summary = `
    SELECT a.name AS advertiser, c.name AS campaign, c.type, c.status,
           c."pricePerImpressionKrw" AS unit_price_krw,
           COALESCE(SUM(b."amountKrw"), 0) AS budget_krw,
           CASE WHEN c."pricePerImpressionKrw" > 0
                THEN COALESCE(SUM(b."amountKrw"), 0) / c."pricePerImpressionKrw" END AS impressions_left
    FROM campaigns c
    JOIN advertisers a ON a.id = c."advertiserId"
    LEFT JOIN billing_ledger b ON b."campaignId" = c.id
    GROUP BY a.name, c.name, c.type, c.status, c."pricePerImpressionKrw"
    ORDER BY a.name, c.name;`;

  // psql -c는 문자열 전체를 한 트랜잭션으로 보낸다. 별도 BEGIN/COMMIT을 넣지 않는다.
  return [conversions, deposits, auditInsert, summary].join('\n');
}

function main() {
  validate();
  if (process.argv.includes('--dry-run')) {
    console.log(buildSql());
    return;
  }
  const output = runCompose(
    ['exec', '-T', 'postgres', 'sh', '-c', 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c "$1"', '--', buildSql()],
    { capture: true, failureMessage: '유료 전환·예산 충전에 실패했습니다.' },
  );
  console.log(output);
}

if (require.main === module) main();

module.exports = { ADVERTISER_BUDGET_KRW, CAMPAIGNS, PRICE_PER_IMPRESSION_KRW, budgetFor, buildSql, validate };
