#!/usr/bin/env node
// 리워드 샵 상품 카탈로그 시드 (CLAW-36).
// 운영자 API로 실제 상품을 등록한다. 이미 있으면 중복 등록되므로 최초 1회만 실행.
//
// 사용:
//   CLAWAD_SERVER=http://localhost:3111 \
//   ADMIN_EMAIL=root@clawad.local ADMIN_PASSWORD=... \
//   node scripts/seed-catalog.mjs
//
// 주의: 카페 단품 가격은 리서치 시점 기준 추정이 섞여 있다(스타벅스 4700·메가 2500은 확인,
// 컴포즈·빽다방·바나·투썸은 근사). 알파 오픈 전 운영자가 실제 기프티콘 가격으로 최종 확정할 것.
'use strict';

const SERVER = process.env.CLAWAD_SERVER || 'http://localhost:3111';
const EMAIL = process.env.ADMIN_EMAIL;
const PASSWORD = process.env.ADMIN_PASSWORD;

// 1P = 1원 상당. pointCost = 실제 판매가.
const CATALOG = [
  // 공식 선물하기로 실제 전달 가능 확인됨(Claude Pro, $22 상당). OpenAI ChatGPT Plus는 제3자 선물하기 기능이
  // 없어 목록에서 제외한다.
  { category: 'SUBSCRIPTION', brand: 'Anthropic', name: 'Claude Pro 1개월 이용권', pointCost: 30000 },

  // 편의점 모바일 금액권 — 액면가(정확).
  { category: 'CONVENIENCE', brand: 'GS25', name: '모바일 금액권 3천원', pointCost: 3000 },
  { category: 'CONVENIENCE', brand: 'GS25', name: '모바일 금액권 5천원', pointCost: 5000 },
  { category: 'CONVENIENCE', brand: 'CU', name: '모바일 금액권 3천원', pointCost: 3000 },
  { category: 'CONVENIENCE', brand: 'CU', name: '모바일 금액권 5천원', pointCost: 5000 },
  { category: 'CONVENIENCE', brand: '세븐일레븐', name: '모바일 교환권 3천원', pointCost: 3000 },
  { category: 'CONVENIENCE', brand: '세븐일레븐', name: '모바일 교환권 5천원', pointCost: 5000 },

  // 카페 아메리카노 단품 — 실제 판매가 기준(운영자 확정).
  { category: 'CAFE', brand: '스타벅스', name: '카페 아메리카노 Tall', pointCost: 4700 },
  { category: 'CAFE', brand: '투썸플레이스', name: '아메리카노 (R)', pointCost: 4700 },
  { category: 'CAFE', brand: '메가커피', name: '아메리카노 (ICE)', pointCost: 2000 },
  { category: 'CAFE', brand: '컴포즈커피', name: '아메리카노 (ICE)', pointCost: 1800 },
  { category: 'CAFE', brand: '빽다방', name: '아메리카노 (ICE)', pointCost: 2000 },
  { category: 'CAFE', brand: '바나프레소', name: '아메리카노 (ICE)', pointCost: 2000 },

  // 문화상품권.
  { category: 'VOUCHER', brand: '컬쳐랜드', name: '문화상품권 5천원', pointCost: 5000 },
  { category: 'VOUCHER', brand: '컬쳐랜드', name: '문화상품권 1만원', pointCost: 10000 },

  // 온라인 결제·배달 금액권 — 액면가(정확).
  { category: 'VOUCHER', brand: '네이버페이', name: '포인트 금액권 5천원', pointCost: 5000 },
  { category: 'VOUCHER', brand: '네이버페이', name: '포인트 금액권 1만원', pointCost: 10000 },
  { category: 'VOUCHER', brand: '배달의민족', name: '상품권 금액권 1만원', pointCost: 10000 },
  { category: 'VOUCHER', brand: '배달의민족', name: '상품권 금액권 2만원', pointCost: 20000 },
];

async function main() {
  if (!EMAIL || !PASSWORD) {
    console.error('ADMIN_EMAIL·ADMIN_PASSWORD 환경변수가 필요합니다 (SUPERADMIN 계정).');
    process.exit(1);
  }

  const loginRes = await fetch(`${SERVER}/admin/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!loginRes.ok) {
    console.error(`관리자 로그인 실패: HTTP ${loginRes.status}`);
    process.exit(1);
  }
  const { accessToken } = await loginRes.json();

  let created = 0;
  let failed = 0;
  for (const p of CATALOG) {
    const res = await fetch(`${SERVER}/internal/v1/products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(p),
    });
    if (res.ok) {
      created++;
      console.log(`  + ${p.brand} ${p.name} — ${p.pointCost.toLocaleString('ko-KR')}P`);
    } else {
      failed++;
      const e = await res.json().catch(() => ({}));
      console.log(`  ! ${p.brand} ${p.name} — HTTP ${res.status} ${e.error || ''}`);
    }
  }
  console.log(`\n상품 등록: ${created}건 성공, ${failed}건 실패 (총 ${CATALOG.length}건).`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
