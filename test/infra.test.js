'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const composePath = path.join(__dirname, '..', 'docker-compose.yml');

test('Redis는 AOF always와 이름 볼륨으로 세션을 영속화한다', () => {
  const compose = fs.readFileSync(composePath, 'utf8').replace(/^\uFEFF/, '');

  assert.match(
    compose,
    /command:\s*\['redis-server', '--appendonly', 'yes', '--appendfsync', 'always'\]/,
  );
  assert.match(compose, /- clawad-redisdata:\/data/);
  assert.match(compose, /volumes:\s*\r?\n\s+clawad-pgdata:\s*\r?\n\s+clawad-redisdata:/);
});

test('유료 전환 시드는 예산을 캠페인에 나누고 재실행에 안전하다 (CLAW-101)', () => {
  const seed = require('../scripts/production-seed-paid-campaigns.js');
  seed.validate();
  // 단가는 정책의 CPM에서 유도한다 — 코드에 고정하지 않는다.
  const cpm = require('../policy/policy').loadPolicy().advertiser.defaultCpmKrw;
  assert.strictEqual(seed.PRICE_PER_IMPRESSION_KRW, Math.round(cpm / 1000));
  // 광고주 예산이 소속 캠페인에 정확히 배분되는지.
  for (const [advertiser, budget] of Object.entries(seed.ADVERTISER_BUDGET_KRW)) {
    const count = seed.CAMPAIGNS.filter((c) => c.advertiser === advertiser).length;
    assert.strictEqual(seed.budgetFor(advertiser) * count, budget, `${advertiser} 예산 배분이 어긋난다`);
  }
  const sql = seed.buildSql();
  assert.match(sql, /UPDATE campaigns SET type = 'PAID'/);
  assert.match(sql, /AND type <> 'PAID'/, '이미 PAID면 다시 전환하지 않는다.');
  assert.match(sql, /'DEPOSIT'/);
  assert.doesNotMatch(sql, /UPDATE billing_ledger|DELETE FROM billing_ledger/, '원장은 append-only다.');
  assert.doesNotMatch(sql, /BEGIN;|COMMIT;/, 'psql -c가 한 트랜잭션으로 보낸다.');
  // 재실행 중복 입금 차단.
  const keys = sql.match(/'seed:paid-budget:v1:[^']+'/g) || [];
  assert.strictEqual(keys.length, seed.CAMPAIGNS.length * 2, '입금마다 멱등 키와 존재 검사가 있어야 한다.');
});
