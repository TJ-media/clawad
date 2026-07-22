'use strict';

// 운영 DB 하우스 캠페인 등록. production-seed-catalog.js와 같은 방식으로 postgres 컨테이너에
// 직접 SQL을 실행한다 — 등록만을 위해 부트스트랩 SUPERADMIN 계정을 새로 만들 필요가 없다.
// 광고주-캠페인은 이름이 같으면 건너뛴다(재실행 안전). 소재는 문구가 바뀌었으면
// 기존 APPROVED를 SUPERSEDED로 전이하고 다음 version을 append한다.
// 감사 추적을 위해 audit_logs에 실행 기록을 남긴다(actorAdminId는 사람이 아니므로 NULL).
//
// 노출 조건(ad-decision.service.js): 광고주 ACTIVE + 캠페인 ACTIVE + 승인된 크리에이티브 1건.
// HOUSE는 예산 검사를 받지 않으므로 billing_ledger 입금 없이 바로 노출된다.
//
// 리워드: HOUSE는 rewardPolicyId가 있을 때만 적립한다(campaign.js §eligibility).
// 이 시드는 회사 재원 프로모션으로 HOUSE_REWARD_POLICY_ID를 부여하므로 미지급 리워드 부채가 발생한다.
// 적립을 끄려면 rewardPolicyId를 null로 두고 다시 등록한다.

const { runCompose } = require('./lib/production-compose');

/** 회사 재원 하우스 프로모션 정책 식별자. 리워드 단가·상한은 정책 설정에서 온다. */
const HOUSE_REWARD_POLICY_ID = 'house-promo-v1';

/** 하우스 광고 인벤토리. text에 `[광고]`를 넣지 않는다 — 노출 시점에 시스템이 붙인다. */
const HOUSE_CAMPAIGNS = [
  {
    advertiser: '클로애드',
    campaign: '클로애드 만족도 조사',
    brand: '클로애드',
    text: '클로애드 써보니 어떠셨나요? 1분 만족도 조사에 참여해 주세요',
    landingUrl: 'https://clawad.whatsup.house/survey.html',
    rewardPolicyId: HOUSE_REWARD_POLICY_ID,
  },
  {
    advertiser: '와썹하우스',
    campaign: '와썹하우스 퇴근게더링',
    brand: '와썹하우스',
    text: '퇴근 후 친구 만들고 싶으신 분! 인스타그램 @whatsup_house',
    landingUrl: 'https://www.instagram.com/whatsup_house/',
    rewardPolicyId: HOUSE_REWARD_POLICY_ID,
  },
  {
    advertiser: '와썹하우스',
    campaign: '와썹하우스 우연한식탁',
    brand: '와썹하우스',
    text: '낯선 사람과 친해지는데, 밥 한끼면 충분할까요? 인스타그램 @whatsup_house',
    landingUrl: 'https://www.instagram.com/whatsup_house/',
    rewardPolicyId: HOUSE_REWARD_POLICY_ID,
  },
];

// 크리에이티브 text는 varchar(120), brand는 varchar(60), 캠페인 name은 varchar(200)이다.
const LIMITS = { text: 120, brand: 60, campaign: 200, advertiser: 200, landingUrl: 2048 };

function validate() {
  for (const ad of HOUSE_CAMPAIGNS) {
    for (const [field, max] of Object.entries(LIMITS)) {
      const value = field === 'campaign' ? ad.campaign : field === 'advertiser' ? ad.advertiser : ad[field];
      if (value != null && String(value).length > max) {
        throw new Error(`${ad.campaign}: ${field}가 ${max}자를 넘습니다 (${String(value).length}자)`);
      }
    }
    if (/\[광고\]/.test(ad.text)) {
      throw new Error(`${ad.campaign}: text에 [광고] 표기를 넣지 않습니다 — 노출 시점에 시스템이 붙입니다.`);
    }
    const hasControlChar = [...ad.text].some((c) => {
      const code = c.codePointAt(0);
      return code < 0x20 || code === 0x7f;
    });
    if (hasControlChar) {
      throw new Error(`${ad.campaign}: text에 제어문자가 있습니다.`);
    }
  }
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqlNullable(value) {
  return value == null ? 'NULL' : sqlString(value);
}

function buildSql() {
  const advertisers = [...new Set(HOUSE_CAMPAIGNS.map((ad) => ad.advertiser))];

  // 광고주: 이름이 같은 행이 이미 있으면 그대로 쓴다. 하우스 광고주는 일일 노출 상한을 두지 않는다.
  const advertiserInserts = advertisers.map((name) => `
    INSERT INTO advertisers (name, status, "dailyImpressionLimit")
    SELECT ${sqlString(name)}, 'ACTIVE', NULL
    WHERE NOT EXISTS (SELECT 1 FROM advertisers WHERE name = ${sqlString(name)});`).join('\n');

  // 캠페인: HOUSE는 pricePerImpressionKrw가 0이어야 한다(CK_campaigns_non_paid_zero_price).
  // 등록 즉시 노출되도록 ACTIVE로 넣는다 — 하우스 광고는 자사 소재라 외부 심사 대상이 아니다.
  const campaignInserts = HOUSE_CAMPAIGNS.map((ad) => `
    INSERT INTO campaigns ("advertiserId", name, type, status, "pricePerImpressionKrw", "rewardPolicyId")
    SELECT a.id, ${sqlString(ad.campaign)}, 'HOUSE', 'ACTIVE', 0, ${sqlNullable(ad.rewardPolicyId)}
    FROM advertisers a
    WHERE a.name = ${sqlString(ad.advertiser)}
      AND NOT EXISTS (SELECT 1 FROM campaigns WHERE name = ${sqlString(ad.campaign)});`).join('\n');

  // 크리에이티브: 캠페인당 APPROVED는 하나만 허용된다(UQ_creatives_one_approved_per_campaign).
  // 소재는 append-only다 — 기존 행의 text를 UPDATE하지 않는다. 문구가 바뀌면
  // (1) 기존 APPROVED를 SUPERSEDED로 전이하고 (2) 다음 version을 APPROVED로 append한다.
  // 하우스 광고는 자사 소재라 외부 심사 대상이 아니므로 PENDING_REVIEW를 거치지 않는다.
  const creativeInserts = HOUSE_CAMPAIGNS.map((ad) => `
    UPDATE creatives cr SET status = 'SUPERSEDED'
    FROM campaigns c
    WHERE cr."campaignId" = c.id
      AND c.name = ${sqlString(ad.campaign)}
      AND cr.status = 'APPROVED'
      AND (cr.text <> ${sqlString(ad.text)}
        OR cr.brand <> ${sqlString(ad.brand)}
        OR cr."landingUrl" IS DISTINCT FROM ${sqlNullable(ad.landingUrl)});

    INSERT INTO creatives ("campaignId", version, text, brand, "landingUrl", status)
    SELECT c.id, COALESCE(MAX(cr.version), 0) + 1,
           ${sqlString(ad.text)}, ${sqlString(ad.brand)}, ${sqlNullable(ad.landingUrl)}, 'APPROVED'
    FROM campaigns c
    LEFT JOIN creatives cr ON cr."campaignId" = c.id
    WHERE c.name = ${sqlString(ad.campaign)}
    GROUP BY c.id
    HAVING NOT EXISTS (
      SELECT 1 FROM creatives x WHERE x."campaignId" = c.id AND x.status = 'APPROVED');`).join('\n');

  const auditNote = `하우스 캠페인 시드-소재 갱신 ${HOUSE_CAMPAIGNS.length}건 (scripts/production-seed-house-campaigns.js)`;
  const auditInsert = `
    INSERT INTO audit_logs ("actorAdminId", "actorRole", action, "targetId", params)
    VALUES (NULL, 'SYSTEM', 'HOUSE_CAMPAIGN_SEED', 'campaigns', ${sqlString(auditNote)});`;

  const summary = `
    SELECT a.name AS advertiser, c.name AS campaign, c.type, c.status,
           c."rewardPolicyId", cr.status AS creative_status, cr.text, cr."landingUrl"
    FROM campaigns c
    JOIN advertisers a ON a.id = c."advertiserId"
    LEFT JOIN creatives cr ON cr."campaignId" = c.id AND cr.status = 'APPROVED'
    WHERE c.type = 'HOUSE'
    ORDER BY a.name, c.name;`;

  // psql -c는 문자열 전체를 한 트랜잭션으로 보낸다. 별도 BEGIN/COMMIT을 넣지 않는다.
  return [advertiserInserts, campaignInserts, creativeInserts, auditInsert, summary].join('\n');
}

function main() {
  validate();
  const sql = buildSql();
  const output = runCompose(
    ['exec', '-T', 'postgres', 'sh', '-c', 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c "$1"', '--', sql],
    { capture: true, failureMessage: '하우스 캠페인 등록에 실패했습니다.' },
  );
  console.log(output);
}

main();
