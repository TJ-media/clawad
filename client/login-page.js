'use strict';

// 브라우저 로그인 복귀 페이지 (CLAW-208).
//
// `http://127.0.0.1:<port>/callback`으로 돌아왔을 때 loopback 서버가 그리는 화면이다.
// 설치 과정에서 사용자가 보는 **마지막 화면**이라, 방금 지나온 리워드 샵 로그인 화면과 같은
// 제품으로 읽혀야 한다. 디자인 언어는 `apps/user-web`의 Windows XP(Luna) 다이얼로그를 따른다.
//
// **외부 자산을 참조하지 않는다.** 이 페이지는 로그인이 끝나는 순간 뜨는데, 폰트·이미지·CSS를
// 원격에서 받으면 그 시점에 외부 요청이 나간다. CSS는 인라인이고 이미지는 없다.
//
// 마스코트를 넣지 않은 이유: 마스코트 SVG는 490KB다. 클라이언트 배포 tarball 전체가 70KB이므로
// 그림 하나로 배포물이 일곱 배가 된다. 다이얼로그 크롬만으로도 같은 제품임이 드러난다.
//
// 색을 전부 명시한다 — 시스템 다크 모드가 상속으로 끼어들 여지를 두지 않는다. 라이트·다크
// 어디서 열어도 같은 화면이다.
//
// **쿼리 값을 페이지에 넣지 않는다.** 이 함수는 자유 문자열을 받지 않고 아래 상태 중 하나만
// 받는다. 이스케이프를 잊을 자리 자체를 없앤다.

/** 페이지가 표현하는 상태. 쿼리에서 온 문자열을 그대로 쓰지 않고 여기로 좁힌다. */
const OUTCOMES = {
  ok: {
    title: '로그인 완료',
    heading: '로그인이 끝났습니다',
    lead: '이 창을 닫고 터미널로 돌아가세요.',
    note: '광고를 준비하는 동기화를 시작했습니다. 잠시 뒤 오버레이 앱에 광고가 표시됩니다.',
  },
  provider: {
    title: '로그인 실패',
    heading: '로그인 공급자가 인증을 거절했습니다',
    lead: '터미널로 돌아가 다시 시도하세요.',
    note: '다른 로그인 수단을 골라도 됩니다.',
  },
  'no-code': {
    title: '로그인 실패',
    heading: '로그인 정보를 받지 못했습니다',
    lead: '터미널로 돌아가 다시 시도하세요.',
    note: '브라우저에서 동의를 취소했거나 주소가 잘린 경우입니다.',
  },
};

function renderCallbackPage(outcome) {
  const view = OUTCOMES[outcome] || OUTCOMES['no-code'];
  const failed = outcome !== 'ok';
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>클로애드 ${view.title}</title>
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;
 font-family:Tahoma,'Malgun Gothic','Apple SD Gothic Neo',sans-serif;font-size:12px;line-height:1.65;color:#000;
 background:radial-gradient(circle at 30% 18%,#5A8ED0 0%,#3A6EA5 55%,#24486F 100%) fixed}
.win{width:100%;max-width:420px;border:3px solid #0831D9;border-radius:8px 8px 4px 4px;overflow:hidden;
 background:#ECE9D8;box-shadow:3px 6px 16px rgba(0,0,0,.45)}
.bar{display:flex;align-items:center;padding:5px 6px 5px 10px;color:#fff;font-size:13px;font-weight:700;
 text-shadow:1px 1px 1px #0A1E63;user-select:none;
 background:linear-gradient(180deg,#0058E6 0%,#3593FF 4%,#0262EE 16%,#0054E3 30%,#0062FF 76%,#003399 100%)}
.close{margin-left:auto;width:21px;height:21px;display:grid;place-items:center;border-radius:3px;
 border:1px solid #fff;font-size:10px;
 background:linear-gradient(180deg,#EB9C81 0%,#D6512D 40%,#BE3413 100%)}
.body{padding:18px 20px 20px}
h1{font-size:15px;margin:0 0 8px;color:${failed ? '#a32d2d' : '#003399'}}
p{margin:0 0 8px}
.note{margin:0;padding:9px 11px;background:#FFFFE1;border:1px solid #D0D0BF;border-radius:3px;color:#4A4A42}
</style></head>
<body><div class="win" role="dialog" aria-labelledby="t">
<div class="bar"><span>클로애드</span><span class="close" aria-hidden="true">✕</span></div>
<div class="body">
<h1 id="t">${view.heading}</h1>
<p>${view.lead}</p>
<p class="note">${view.note}</p>
</div></div></body></html>`;
}

module.exports = { OUTCOMES, renderCallbackPage };
