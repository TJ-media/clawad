'use strict';
// 정책 파일이 로드 가능하고 불변식을 통과하는지 확인한다 (CLAW-12).
// 배포 전·CI에서 잘못된 정책값을 걸러내는 용도. API 기동 시 검사(main.ts)와 같은 경로를 쓴다.
// CLAWAD_POLICY_FILE로 검사 대상을 지정할 수 있다.
const { loadPolicy, defaultFile } = require('../policy/policy.js');

try {
  const file = defaultFile();
  const policy = loadPolicy();
  console.log(`POLICY_CHECK_PASS version=${policy.version} file=${file}`);
} catch (error) {
  console.error(`POLICY_CHECK_FAIL ${error.message}`);
  process.exit(1);
}
