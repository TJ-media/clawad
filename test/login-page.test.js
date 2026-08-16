'use strict';
// 브라우저 로그인 복귀 페이지 (CLAW-208).
//
// 설치 과정에서 사용자가 보는 마지막 화면이다. 로그인이 끝나는 순간 뜨는 페이지라
// 외부 요청이 나가면 안 되고, 쿼리로 들어온 값이 화면에 실려서도 안 된다.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { OUTCOMES, renderCallbackPage } = require('../client/login-page');

const ALL = Object.keys(OUTCOMES);

test('성공·실패 두 갈래를 구분해 보여준다', () => {
  const ok = renderCallbackPage('ok');
  assert.match(ok, /로그인이 끝났습니다/);
  assert.match(ok, /터미널로 돌아가세요/);
  assert.match(ok, /동기화를 시작했습니다/, '다음에 무슨 일이 일어나는지 알려야 한다');

  // 실패는 사유를 화면에도 적는다 — 예전에는 터미널에만 있었다.
  assert.match(renderCallbackPage('provider'), /공급자가 인증을 거절했습니다/);
  assert.match(renderCallbackPage('no-code'), /로그인 정보를 받지 못했습니다/);
});

test('알 수 없는 상태는 실패로 떨어뜨린다', () => {
  // 성공으로 오인되면 사용자가 터미널을 확인하지 않는다.
  assert.strictEqual(renderCallbackPage('made-up'), renderCallbackPage('no-code'));
  assert.strictEqual(renderCallbackPage(undefined), renderCallbackPage('no-code'));
});

// 이 페이지는 로그인이 끝나는 순간 뜬다. 폰트·이미지·CSS를 원격에서 받으면 그 시점에
// 외부 요청이 나간다. 배포 tarball에 없는 파일을 참조해도 깨진 화면이 된다.
test('외부 자산을 참조하지 않는다', () => {
  for (const outcome of ALL) {
    const html = renderCallbackPage(outcome);
    assert.doesNotMatch(html, /https?:\/\//, '원격 주소를 참조하면 안 된다');
    assert.doesNotMatch(html, /<script/i, '스크립트를 넣지 않는다');
    assert.doesNotMatch(html, /<img|<link|@import|url\(/i, '외부 자산을 불러오지 않는다');
  }
});

test('쿼리에서 온 값을 페이지에 싣지 않는다', () => {
  // renderCallbackPage는 자유 문자열을 받지 않는다 — 이스케이프를 잊을 자리가 없다.
  const injected = renderCallbackPage('<script>alert(1)</script>');
  assert.doesNotMatch(injected, /alert\(1\)/);
  assert.strictEqual(injected, renderCallbackPage('no-code'));
});

// 광고 창구는 오버레이 하나뿐이고(CLAW-134), 이 페이지는 광고를 표시하지 않는다.
// Claude Code 공식 화면으로 오인될 문구도 쓰지 않는다 (rules §3).
test('광고를 표시하지 않고 공식 메시지로 오인될 표현을 쓰지 않는다', () => {
  for (const outcome of ALL) {
    const html = renderCallbackPage(outcome);
    assert.doesNotMatch(html, /\[광고\]/);
    assert.doesNotMatch(html, /Claude Code|Anthropic/i);
  }
});

test('login.js가 쿼리 대신 정해진 상태만 넘긴다', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'client', 'login.js'), 'utf8');
  assert.match(source, /renderCallbackPage\(outcome\)/);
  assert.match(source, /error \? 'provider' : \(code \? 'ok' : 'no-code'\)/);
});

// 배포 tarball은 client/·policy/만 담는다. apps/user-web의 자산은 실행 시점에 존재하지 않는다.
test('페이지 모듈이 client/ 안에서 완결된다', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'client', 'login-page.js'), 'utf8');
  assert.doesNotMatch(source, /require\(/, '다른 모듈에 의존하지 않는다');
  // 파일을 읽어 화면을 만들면 배포물에 없는 자산에 기대게 된다. 문자열로 완결한다.
  assert.doesNotMatch(source, /readFileSync|readFile\(/, '실행 시점에 파일을 읽지 않는다');
});
