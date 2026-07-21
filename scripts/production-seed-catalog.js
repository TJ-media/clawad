'use strict';

// 운영 DB 상품 카탈로그 등록. scripts/seed-catalog.mjs(관리자 API·JWT 경유)와 달리
// postgres 컨테이너에 직접 SQL을 실행한다 — 카탈로그 등록만을 위해 부트스트랩 SUPERADMIN
// 계정을 새로 만들 필요가 없다. 이미 있는 brand+name 조합은 건너뛴다(재실행 안전).
// 감사 추적을 위해 audit_logs에 실행 기록을 남긴다(actorAdminId는 사람이 아니므로 NULL).

const { runCompose } = require('./lib/production-compose');

const CATALOG = [
  // 공식 선물하기로 실제 전달 가능(Claude Pro, $22 상당). OpenAI ChatGPT Plus는 제3자
  // 선물하기 기능이 없어 목록에서 제외한다.
  { category: 'SUBSCRIPTION', brand: 'Anthropic', name: 'Claude Pro 1개월 이용권', pointCost: 30000 },

  // 편의점 모바일 금액권 — 액면가.
  { category: 'CONVENIENCE', brand: 'GS25', name: '모바일 금액권 3천원', pointCost: 3000 },
  { category: 'CONVENIENCE', brand: 'GS25', name: '모바일 금액권 5천원', pointCost: 5000 },
  { category: 'CONVENIENCE', brand: 'CU', name: '모바일 금액권 3천원', pointCost: 3000 },
  { category: 'CONVENIENCE', brand: 'CU', name: '모바일 금액권 5천원', pointCost: 5000 },
  { category: 'CONVENIENCE', brand: '세븐일레븐', name: '모바일 교환권 3천원', pointCost: 3000 },
  { category: 'CONVENIENCE', brand: '세븐일레븐', name: '모바일 교환권 5천원', pointCost: 5000 },

  // 카페 아메리카노 단품 — 실제 판매가(운영자 확정).
  { category: 'CAFE', brand: '스타벅스', name: '카페 아메리카노 Tall', pointCost: 4700 },
  { category: 'CAFE', brand: '투썸플레이스', name: '아메리카노 (R)', pointCost: 4700 },
  { category: 'CAFE', brand: '메가커피', name: '아메리카노 (ICE)', pointCost: 2000 },
  { category: 'CAFE', brand: '컴포즈커피', name: '아메리카노 (ICE)', pointCost: 1800 },
  { category: 'CAFE', brand: '빽다방', name: '아메리카노 (ICE)', pointCost: 2000 },
  { category: 'CAFE', brand: '바나프레소', name: '아메리카노 (ICE)', pointCost: 2000 },

  // 문화상품권.
  { category: 'VOUCHER', brand: '컬쳐랜드', name: '문화상품권 5천원', pointCost: 5000 },
  { category: 'VOUCHER', brand: '컬쳐랜드', name: '문화상품권 1만원', pointCost: 10000 },

  // 온라인 결제·배달 금액권 — 액면가.
  { category: 'VOUCHER', brand: '네이버페이', name: '포인트 금액권 5천원', pointCost: 5000 },
  { category: 'VOUCHER', brand: '네이버페이', name: '포인트 금액권 1만원', pointCost: 10000 },
  { category: 'VOUCHER', brand: '배달의민족', name: '상품권 금액권 1만원', pointCost: 10000 },
  { category: 'VOUCHER', brand: '배달의민족', name: '상품권 금액권 2만원', pointCost: 20000 },
];

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function buildSql() {
  const inserts = CATALOG.map((p) => `
    INSERT INTO products (name, brand, category, "pointCost")
    SELECT ${sqlString(p.name)}, ${sqlString(p.brand)}, ${sqlString(p.category)}, ${p.pointCost}
    WHERE NOT EXISTS (
      SELECT 1 FROM products WHERE brand = ${sqlString(p.brand)} AND name = ${sqlString(p.name)}
    );`).join('\n');

  const auditNote = `카탈로그 시드 ${CATALOG.length}건 (scripts/production-seed-catalog.js)`;
  const auditInsert = `
    INSERT INTO audit_logs ("actorAdminId", "actorRole", action, "targetId", params)
    VALUES (NULL, 'SYSTEM', 'PRODUCT_CATALOG_SEED', 'products', ${sqlString(auditNote)});`;

  const summary = `SELECT category, brand, name, "pointCost", active FROM products ORDER BY category, brand, "pointCost";`;

  return [inserts, auditInsert, summary].join('\n');
}

function main() {
  const sql = buildSql();
  const output = runCompose(
    ['exec', '-T', 'postgres', 'sh', '-c', 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"', '--', sql],
    { capture: true, failureMessage: '상품 카탈로그 등록에 실패했습니다.' },
  );
  console.log(output);
}

main();
