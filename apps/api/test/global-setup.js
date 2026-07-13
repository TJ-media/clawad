'use strict';
// e2e 전역 셋업 (CLAW-39): 전용 테스트 DB가 없으면 만든다.
// 데모용 dev DB(clawad)와 분리해 테스트가 데모 데이터를 오염시키지 않게 한다.
// setupFiles(setup-env.ts)보다 먼저 실행되므로 기본값을 여기서 자체 보유한다.
const { Client } = require('pg');

module.exports = async () => {
  const host = process.env.DB_HOST || 'localhost';
  const port = Number(process.env.DB_PORT || 55432);
  const user = process.env.DB_USER || 'clawad';
  const password = process.env.DB_PASSWORD || 'clawad_local_dev';
  const dbName = process.env.DB_NAME || 'clawad_test';

  // 관리 접속은 항상 존재하는 기본 DB로 붙는다. 대상 DB 생성은 여기서만 한다.
  const admin = new Client({ host, port, user, password, database: 'postgres' });
  await admin.connect();
  try {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (exists.rowCount === 0) {
      // 식별자는 화이트리스트 문자만 허용(SQL 인젝션 방지). 스키마는 앱의 migrationsRun이 만든다.
      if (!/^[a-zA-Z0-9_]+$/.test(dbName)) throw new Error(`잘못된 DB_NAME: ${dbName}`);
      await admin.query(`CREATE DATABASE "${dbName}" OWNER "${user}"`);
      // eslint 없음 — 콘솔로 최소 안내만.
      console.log(`[e2e] 테스트 DB 생성: ${dbName}`);
    }
  } finally {
    await admin.end();
  }
};
