'use strict';
// 공개 법률문서 정합성 (CLAW-98).
//
// 처리방침 본문이 실제 수집 스키마보다 좁으면 고지 없는 수집이 되고, 넓으면 문서가 코드보다
// 넓은 범위를 선언하게 된다(rules §6). 활성 버전 문서에 수집 항목이 빠지지 않았는지 확인한다.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'docs', 'legal', 'public');
const read = (name) => fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8').replace(/^﻿/, '');

const envExample = () => fs.readFileSync(path.join(__dirname, '..', 'deploy', 'production', '.env.example'), 'utf8');

/** 운영 .env 예시가 가리키는 활성 문서 파일명. 문서와 설정이 어긋나면 잘못된 버전이 게시된다. */
function activeFile(urlKey) {
  const url = envExample().match(new RegExp(`^${urlKey}=(.+)$`, 'm'));
  assert.ok(url, `${urlKey}가 있어야 한다`);
  return url[1].trim().split('/').pop();
}

const activePrivacyFile = () => activeFile('LEGAL_PRIVACY_URL');
const activeTermsFile = () => activeFile('LEGAL_TERMS_URL');

test('활성 처리방침 파일이 존재하고 버전 표기가 설정과 일치한다', () => {
  const file = activePrivacyFile();
  assert.ok(fs.existsSync(path.join(PUBLIC_DIR, file)), `${file}이 있어야 한다`);

  const env = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'production', '.env.example'), 'utf8');
  const version = env.match(/^LEGAL_PRIVACY_VERSION=(.+)$/m)[1].trim();
  const html = read(file);
  assert.ok(html.includes(`버전 ${version}`), `본문 버전 표기가 ${version}이어야 한다`);

  // 시행일이 어긋나면 legal-documents.service가 기동을 거부하거나(같은 시행일 중복)
  // 게시본과 다른 시행일이 고지된다.
  const effectiveAt = env.match(/^LEGAL_PRIVACY_EFFECTIVE_AT=(.+)$/m)[1].trim();
  assert.ok(html.includes(`시행일 ${effectiveAt}`), `본문 시행일이 ${effectiveAt}이어야 한다`);

  // 활성 버전은 이전 버전과 시행일이 달라야 한다 (같으면 활성화가 거부된다).
  for (const other of fs.readdirSync(PUBLIC_DIR).filter((f) => /^privacy-v\d+\.html$/.test(f) && f !== file)) {
    const m = read(other).match(/시행일 (\d{4}-\d{2}-\d{2})/);
    if (m) assert.notStrictEqual(m[1], effectiveAt, `${other}와 시행일이 같으면 활성화가 거부된다`);
  }
});

test('활성 처리방침에 설문 응답 수집이 고지돼 있다', () => {
  // survey_responses를 수집하면서 방침에 없으면 고지 없는 수집이다 (CLAW-97 연동).
  const html = read(activePrivacyFile());
  assert.match(html, /설문 응답/, '설문 응답 수집 항목이 있어야 한다');
  assert.match(html, /회원 식별자와 연결하여 저장/, '계정 연결 사실을 고지해야 한다');
  assert.match(html, /설문 응답을 광고 노출 기록과 결합하지 않으며/, '노출 기록 미결합을 명시해야 한다');
});

test('활성 처리방침에 미확정 마커가 없다', () => {
  // production-smoke가 게시본에서 잡지만, 저장소 단계에서 먼저 막는다.
  for (const file of fs.readdirSync(PUBLIC_DIR).filter((f) => f.endsWith('.html'))) {
    assert.ok(!read(file).includes('[미확정:'), `${file}에 미확정 마커가 남아 있다`);
  }
});

test('사용자 화면이 활성 처리방침 버전을 링크한다', () => {
  const file = activePrivacyFile();
  const webDir = path.join(__dirname, '..', 'apps', 'user-web');
  for (const page of ['install.html', 'survey.html']) {
    const html = fs.readFileSync(path.join(webDir, page), 'utf8');
    assert.ok(html.includes(file), `${page}가 ${file}을 링크해야 한다`);
    assert.ok(!/privacy-v1\.html/.test(html) || file === 'privacy-v1.html',
      `${page}에 구버전 링크가 남아 있으면 안 된다`);
  }
});

// 약관 v1이 광고 창구를 상태줄로 정의한 채 CLAW-134 이후에도 공개돼 있었다. 같은 드리프트를 막는다.
test('활성 약관 파일이 존재하고 버전 표기가 설정과 일치한다', () => {
  const file = activeTermsFile();
  assert.ok(fs.existsSync(path.join(PUBLIC_DIR, file)), `${file}이 있어야 한다`);

  const env = envExample();
  const version = env.match(/^LEGAL_TERMS_VERSION=(.+)$/m)[1].trim();
  const effectiveAt = env.match(/^LEGAL_TERMS_EFFECTIVE_AT=(.+)$/m)[1].trim();
  const html = read(file);
  assert.ok(html.includes(`버전 ${version}`), `본문 버전 표기가 ${version}이어야 한다`);
  assert.ok(html.includes(`시행일 ${effectiveAt}`), `본문 시행일이 ${effectiveAt}이어야 한다`);

  // 활성 버전은 구버전과 시행일이 달라야 한다 (같으면 legal-documents.service가 활성화를 거부한다).
  for (const other of fs.readdirSync(PUBLIC_DIR).filter((f) => /^terms-v\d+\.html$/.test(f) && f !== file)) {
    const m = read(other).match(/시행일 (\d{4}-\d{2}-\d{2})/);
    if (m) assert.notStrictEqual(m[1], effectiveAt, `${other}와 시행일이 같으면 활성화가 거부된다`);
  }
});

test('활성 약관이 광고 창구를 오버레이로 정의한다 (CLAW-134)', () => {
  const html = read(activeTermsFile());
  // 정의 조항이 상태줄 표시를 전제하면 실제 서비스와 어긋난 채 공개된다.
  assert.match(html, /오버레이 앱이 이용자의 화면에 광고를 표시한 사실/, '"노출" 정의가 오버레이 기준이어야 한다');
  assert.ok(!/상태줄\(statusline\)에 광고를 표시/.test(html), '상태줄 광고 표시 정의가 남아 있으면 안 된다');
  // 상태줄 언급은 "쓰지 않는다"·"원상복구"·개정 안내 맥락에서만 허용한다.
  for (const line of html.split(String.fromCharCode(10))) {
    if (!/상태줄/.test(line)) continue;
    assert.ok(/사용하지 않|원상복구|일원화|더 이상/.test(line),
      `상태줄을 광고 표시 창구로 서술하면 안 된다: ${line.trim().slice(0, 70)}`);
  }
});

test('활성 약관이 전송 여부로 서술한다 (CLAW-127)', () => {
  // 오버레이는 단말 안에서 프롬프트 첫 줄·경로를 읽는다. "수집하지 않는다"는 오해를 만든다.
  const html = read(activeTermsFile());
  assert.match(html, /운영자의 서버로 전송하지 않습니다/, '전송 기준으로 서술해야 한다');
  assert.ok(!/개발 작업 내용은 일절 수집하지 않습니다/.test(html),
    '"일절 수집하지 않습니다"는 CLAW-127 결정과 어긋난다');
});

test('사용자 화면이 활성 약관 버전을 링크한다', () => {
  const file = activeTermsFile();
  const webDir = path.join(__dirname, '..', 'apps', 'user-web');
  for (const page of ['install.html', 'survey.html']) {
    const html = fs.readFileSync(path.join(webDir, page), 'utf8');
    assert.ok(html.includes(file), `${page}가 ${file}을 링크해야 한다`);
    assert.ok(!/terms-v1\.html/.test(html) || file === 'terms-v1.html',
      `${page}에 구버전 링크가 남아 있으면 안 된다`);
  }
});

test('설계 문서에 설문 응답 수집·파기 경로가 있다', () => {
  const design = fs.readFileSync(path.join(__dirname, '..', 'docs', 'legal', 'privacy-design.md'), 'utf8');
  assert.match(design, /만족도 설문 응답/, '수집 허용목록에 설문이 있어야 한다');
  assert.match(design, /surveyResponsesDeleted/, '파기 기록 필드가 문서화돼야 한다');
  // 탈퇴는 users 행을 지우지 않아 FK CASCADE가 발화하지 않는다. 설문 파기를 CASCADE로 설명하면
  // 사실과 다르므로, 설문을 언급하는 줄에 CASCADE가 함께 나오지 않아야 한다.
  for (const line of design.split(String.fromCharCode(10))) {
    if (/설문/.test(line) && /CASCADE/.test(line)) {
      assert.ok(/CASCADE에 의존하지 않는다|CASCADE가 걸리지 않는다/.test(line),
        `설문 파기를 CASCADE로 서술하면 안 된다: ${line.trim().slice(0, 60)}`);
    }
  }
});
