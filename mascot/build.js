// ClawAd 마스코트 빌더 — 파츠 PNG를 base64로 인라인해 자립형 애니메이션 HTML 생성
// 사용: node build.js [--pose] (--pose: 리깅 검증용 강제 포즈)
const fs = require('fs');
const path = require('path');

const PARTS_DIR = path.join(__dirname, 'parts');
const OUT = path.join(__dirname, 'clawad-mascot.html');
const POSE = process.argv.includes('--pose');

function dataUri(name) {
  const buf = fs.readFileSync(path.join(PARTS_DIR, name + '.png'));
  return 'data:image/png;base64,' + buf.toString('base64');
}
const u = {};
for (const n of ['antenna-left','antenna-right','arm-right','claw-1','claw-2','leg-1','leg-2','leg-3','leg-4','tail-side','body-face','arm-left','eyes-eyebrows','cheek-left','cheek-right','mouth']) {
  u[n] = dataUri(n);
}

// 리깅 검증용 강제 포즈 (집게 열림 + 더듬이 최대 스윙 + 시선 이동)
const poseCss = POSE ? `
  .claw-upper { animation: none !important; transform: rotate(-14deg) !important; }
  .antenna-l { animation: none !important; transform: rotate(-6deg) !important; }
  .antenna-r { animation: none !important; transform: rotate(6deg) !important; }
  .arm-big { animation: none !important; transform: rotate(2deg) !important; }
  .arm-left-w { animation: none !important; transform: rotate(-3deg) !important; }
  #face { transform: translate(7px, 5px) scale(0.75) !important; }
` : '';

const html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ClawAd 마스코트</title>
<style>
  html, body { margin: 0; height: 100%; background: #fdfaf4; overflow: hidden; }
  body { display: flex; align-items: center; justify-content: center; }
  #stage { position: relative; width: 720px; height: 760px; flex: none; }
  #stage img { position: absolute; image-rendering: pixelated; user-select: none; -webkit-user-drag: none; pointer-events: none; }
  #tilt, #pet { position: absolute; inset: 0; }
  .grp { position: absolute; }

  /* ── 시선/기울임: JS가 --lx, --ly(-1..1)만 갱신 ── */
  #tilt {
    transform: rotate(calc(var(--lx, 0) * 1.4deg));
    transform-origin: 222px 700px;
  }

  /* ── 숨쉬기 ── */
  #pet {
    animation: breathe 3.4s ease-in-out infinite alternate;
    transform-origin: 222px 700px;
  }
  @keyframes breathe {
    from { transform: scale(1, 1) translateY(0); }
    to   { transform: scale(1.008, 1.02) translateY(-3px); }
  }

  /* ── 더듬이 살랑거림 (주기를 서로 다르게 해 기계적 반복 방지) ── */
  .antenna-l {
    left: 69px; top: 122px; width: 112px; height: 228px;
    transform-origin: 95% 96%;
    animation: sway-l 2.3s ease-in-out infinite alternate;
  }
  .antenna-r {
    left: 164px; top: 115px; width: 81px; height: 232px;
    transform-origin: 85% 96%;
    animation: sway-r 2.7s ease-in-out 0.4s infinite alternate;
    animation-fill-mode: backwards;
  }
  @keyframes sway-l { from { transform: rotate(-6deg); } to { transform: rotate(4deg); } }
  @keyframes sway-r { from { transform: rotate(-4deg); } to { transform: rotate(6deg); } }

  /* ── 큰 집게 팔: 어깨 기준 천천히 흔들기 ── */
  .arm-big {
    left: 272px; top: 65px; width: 326px; height: 467px;
    z-index: 2;
    transform-origin: 58px 435px;
    animation: arm-wave 5.6s ease-in-out infinite alternate;
  }
  @keyframes arm-wave { from { transform: rotate(-1.5deg); } to { transform: rotate(1.8deg); } }

  /* ── 집게 위짝: 관절 기준으로 가끔 딸깍 개폐 ── */
  .claw-upper {
    left: 8px; top: 22px; width: 159px; height: 295px;
    transform-origin: 108px 285px;
    animation: claw-snap 4.8s steps(3, jump-none) infinite;
  }
  @keyframes claw-snap {
    0%, 52%   { transform: rotate(0deg); }
    58%, 64%  { transform: rotate(-14deg); }
    67%, 71%  { transform: rotate(-3deg); }
    74%, 78%  { transform: rotate(-14deg); }
    84%, 100% { transform: rotate(0deg); }
  }

  /* ── 왼쪽 작은 팔: 어깨 기준 잔잔한 흔들림 ── */
  .arm-left-w {
    left: 73px; top: 405px; width: 123px; height: 178px;
    z-index: 6;
    transform-origin: 92% 28%;
    animation: arm-rock 4.1s ease-in-out 0.7s infinite alternate;
    animation-fill-mode: backwards;
  }
  @keyframes arm-rock { from { transform: rotate(-3deg); } to { transform: rotate(2deg); } }

  /* ── 얼굴: 커서 따라 이동 (눈+볼+입 일체) ── */
  #face {
    left: 117px; top: 283px; width: 245px; height: 182px;
    z-index: 7;
    transform: translate(calc(var(--lx, 0) * 7px), calc(var(--ly, 0) * 5px)) scale(0.75);
    transform-origin: 50% 45%;
  }
  #blink {
    left: 13px; top: 0; width: 184px; height: 115px;
    transform-origin: 50% 80%;
    animation: blink 4.6s ease-in-out infinite;
  }
  @keyframes blink {
    0%, 91%, 100% { transform: scaleY(1); }
    94%, 97%      { transform: scaleY(0.42); }
  }
  ${poseCss}
</style>
</head>
<body>
  <div id="stage">
    <div id="tilt">
      <div id="pet">
        <div class="grp antenna-l"><img src="${u['antenna-left']}"></div>
        <div class="grp antenna-r"><img src="${u['antenna-right']}"></div>

        <div class="grp arm-big">
          <img src="${u['arm-left']}" style="left:3px;top:258px;transform:rotate(10deg)">
          <img src="${u['claw-2']}" style="left:113px;top:-8px">
          <div class="grp claw-upper"><img src="${u['claw-1']}"></div>
        </div>

        <img src="${u['tail-side']}" style="left:-45px;top:470px;z-index:1">
        <img src="${u['leg-1']}" style="left:90px;top:550px;width:60px;z-index:1">
        <img src="${u['leg-2']}" style="left:145px;top:558px;width:52px;z-index:1">
        <img src="${u['leg-3']}" style="left:205px;top:558px;width:52px;z-index:1">
        <img src="${u['leg-4']}" style="left:260px;top:550px;width:58px;z-index:1">

        <img src="${u['body-face']}" style="left:123px;top:264px;z-index:5">
        <div class="grp arm-left-w"><img src="${u['arm-right']}" style="width:123px"></div>

        <div class="grp" id="face">
          <div class="grp" id="blink"><img src="${u['eyes-eyebrows']}"></div>
          <img src="${u['cheek-left']}" style="left:0;top:117px">
          <img src="${u['cheek-right']}" style="left:145px;top:112px">
          <img src="${u['mouth']}" style="left:66px;top:125px">
        </div>
      </div>
    </div>
  </div>
<script>
  // 커서 추적: 목표값(-1..1)을 lerp로 부드럽게 따라가며 CSS 변수만 갱신
  (function () {
    var stage = document.getElementById('stage');
    var tx = 0, ty = 0, cx = 0, cy = 0;
    var LERP = 0.10;

    document.addEventListener('pointermove', function (e) {
      var r = stage.getBoundingClientRect();
      var mx = (e.clientX - (r.left + r.width * 0.31)) / (window.innerWidth / 2);
      var my = (e.clientY - (r.top + r.height * 0.48)) / (window.innerHeight / 2);
      tx = Math.max(-1, Math.min(1, mx));
      ty = Math.max(-1, Math.min(1, my));
    });

    (function loop() {
      cx += (tx - cx) * LERP;
      cy += (ty - cy) * LERP;
      stage.style.setProperty('--lx', cx.toFixed(3));
      stage.style.setProperty('--ly', cy.toFixed(3));
      requestAnimationFrame(loop);
    })();

    // 창 크기에 맞춰 축소
    function fit() {
      var s = Math.min(1, window.innerWidth / 760, window.innerHeight / 800);
      stage.style.transform = 'scale(' + s + ')';
    }
    window.addEventListener('resize', fit);
    fit();
  })();
</script>
</body>
</html>
`;

fs.writeFileSync(OUT, html);
console.log('written:', OUT, POSE ? '(pose 검증 모드)' : '');

// ── 아티팩트용 (doctype/html/head/body 래퍼 없이, 테마 토큰 + reduced-motion) ──
const bodyInner = html
  .replace(/^[\s\S]*?<body>/, '')
  .replace(/<\/body>[\s\S]*$/, '');
const styleInner = html.match(/<style>([\s\S]*?)<\/style>/)[1]
  .replace(/html, body \{[^}]*\}\n/, '')
  .replace(/body \{[^}]*\}\n/, '');

const artifact = `<title>ClawAd 마스코트</title>
<style>
  :root {
    --ground: #fbf7f0;
    --caption: #8a8378;
  }
  @media (prefers-color-scheme: dark) {
    :root { --ground: #14161d; --caption: #6f7482; }
  }
  :root[data-theme="dark"] { --ground: #14161d; --caption: #6f7482; }
  :root[data-theme="light"] { --ground: #fbf7f0; --caption: #8a8378; }

  #ground {
    position: fixed; inset: 0;
    background: var(--ground);
    display: flex; align-items: center; justify-content: center;
    overflow: hidden;
  }
  #caption {
    position: fixed; left: 0; right: 0; bottom: 20px;
    text-align: center;
    font-family: ui-monospace, Consolas, monospace;
    font-size: 12px; letter-spacing: 0.18em; text-transform: uppercase;
    color: var(--caption);
    pointer-events: none;
  }
${styleInner}
  @media (prefers-reduced-motion: reduce) {
    #pet, .grp { animation: none !important; }
  }
</style>
<div id="ground">
${bodyInner.replace('<div id="stage">', '<div id="stage">').replace(/<script>[\s\S]*<\/script>/, '')}
<div id="caption">ClawAd &mdash; 커서를 움직여 보세요</div>
</div>
${bodyInner.match(/<script>[\s\S]*<\/script>/)[0]}
`;
fs.writeFileSync(path.join(__dirname, 'mascot-artifact.html'), artifact);
console.log('written: mascot-artifact.html');
