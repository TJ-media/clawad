'use strict';
// 리워드 원장 스키마 정합성 (CLAW-97).
//
// 원장 항목 유형을 코드에만 추가하고 DB의 enum·부호 CHECK 제약을 함께 갱신하지 않으면
// 해당 유형의 모든 INSERT가 런타임에 23514/22P02로 실패한다. CI는 API e2e를 돌리지 않으므로
// (.github/workflows/production-deploy.yml은 lint·test만 실행) 이 불일치를 여기서 잡는다.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ENTITY = path.join(ROOT, 'apps', 'api', 'src', 'entities', 'reward-ledger.entity.ts');
const MIGRATIONS_DIR = path.join(ROOT, 'apps', 'api', 'src', 'migrations');

/** RewardEntryType enum에 선언된 값 목록. */
function entryTypesFromCode() {
  const source = fs.readFileSync(ENTITY, 'utf8').replace(/^﻿/, '');
  const block = source.slice(source.indexOf('export enum RewardEntryType'));
  const body = block.slice(0, block.indexOf('}'));
  return [...body.matchAll(/=\s*'([A-Z_]+)'/g)].map((m) => m[1]);
}

/** 파일명 순서상 가장 마지막에 patternE 정의를 갱신한 마이그레이션의 up() 본문. */
function latestUpContaining(pattern) {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.ts')).sort();
  let latest = null;
  for (const file of files) {
    const source = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8').replace(/^﻿/, '');
    // down()은 되돌리기용 옛 정의를 담고 있으므로 up()만 본다.
    const downAt = source.indexOf('public async down');
    const up = downAt === -1 ? source : source.slice(0, downAt);
    if (pattern.test(up)) latest = { file, up };
  }
  return latest;
}

test('원장 enum 값이 DB enum 타입 정의에 모두 있다', () => {
  const types = entryTypesFromCode();
  assert.ok(types.length >= 6, `enum 값을 찾지 못했다: ${types.join(',')}`);

  const latest = latestUpContaining(/CREATE TYPE "reward_ledger_entrytype_enum"/);
  assert.ok(latest, 'reward_ledger_entrytype_enum을 정의하는 마이그레이션이 있어야 한다');

  for (const type of types) {
    assert.ok(latest.up.includes(`'${type}'`), `${type}이 ${latest.file}의 enum 타입 정의에 없다`);
  }
});

test('원장 enum 값이 부호 CHECK 제약에 모두 있다', () => {
  const types = entryTypesFromCode();
  const latest = latestUpContaining(/ADD CONSTRAINT "CK_reward_ledger_sign"/);
  assert.ok(latest, 'CK_reward_ledger_sign을 정의하는 마이그레이션이 있어야 한다');

  const start = latest.up.indexOf('ADD CONSTRAINT "CK_reward_ledger_sign"');
  const constraint = latest.up.slice(start, latest.up.indexOf('`', start));

  for (const type of types) {
    // 어느 분기든 들어가 있어야 한다. 빠지면 그 유형의 INSERT가 전부 거절된다.
    assert.ok(constraint.includes(`'${type}'`), `${type}이 ${latest.file}의 CK_reward_ledger_sign 분기에 없다`);
  }
});

test('확정 잔액 집계가 양수 적립 유형을 빠뜨리지 않는다', () => {
  // 적립(양수) 유형이 confirmedBalance 화이트리스트에 없으면 잔액에 반영되지 않는다.
  const service = fs.readFileSync(path.join(ROOT, 'apps', 'api', 'src', 'events', 'reward.service.ts'), 'utf8');
  const start = service.indexOf('async confirmedBalance');
  assert.ok(start > 0, 'confirmedBalance가 있어야 한다');
  const body = service.slice(start, start + 1500);

  // 즉시 확정되는 적립 유형은 화이트리스트에 있어야 한다. pending은 검증 중이므로 제외가 맞다.
  for (const type of ['ACCRUE_CONFIRM', 'PROMO_ACCRUE']) {
    assert.ok(body.includes(`'${type}'`), `${type}이 confirmedBalance 집계에 없다`);
  }
  assert.ok(!/IN \([^)]*'ACCRUE_PENDING'/.test(body), 'ACCRUE_PENDING은 확정 잔액에 들어가면 안 된다');
});
