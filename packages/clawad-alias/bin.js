#!/usr/bin/env node
'use strict';
// `npx clawad ...`로 들어온 호출을 실제 패키지 @clawad/cli로 넘긴다.
//
// cli.js는 require.main 가드가 없고 process.argv[2]부터 읽는다. 이 파일이 argv[1]이므로
// 인자 위치가 그대로 맞아, 두 번째 node 프로세스를 띄우지 않고 require 한 번으로 끝난다.
// 경로를 직접 적지 않고 의존 패키지의 bin 선언을 따라간다 — 내부 배치가 바뀌어도 깨지지 않는다.

let target;
try {
  const pkg = require('@clawad/cli/package.json');
  const bin = pkg.bin && (typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.clawad);
  if (!bin) throw new Error('@clawad/cli에 clawad bin 선언이 없습니다.');
  target = require.resolve('@clawad/cli/' + bin.replace(/^\.\//, ''));
} catch (error) {
  console.error('클로애드 CLI(@clawad/cli)를 찾을 수 없습니다. 이 패키지는 이름 별칭일 뿐입니다.');
  console.error('직접 실행: npx --yes @clawad/cli setup');
  console.error(`사유: ${error && error.message ? error.message : error}`);
  process.exit(1);
}

require(target);
