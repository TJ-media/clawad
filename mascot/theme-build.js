// ClawAd → clawd-on-desk 테마 빌더 (+ 상태 미리보기 갤러리 생성)
// parts/*.png + 상태별 SVG + theme.json을 theme-out/clawad/ 에 생성한다.
// 제약: data: URI 금지(새니타이저가 제거) → 테마 SVG는 assets/ 상대경로 참조.
const fs = require('fs');
const path = require('path');

const PARTS = path.join(__dirname, 'parts');
const OUT = path.join(__dirname, 'theme-out', 'clawad');
const ASSETS = path.join(OUT, 'assets');
fs.rmSync(path.join(__dirname, 'theme-out'), { recursive: true, force: true });
fs.mkdirSync(ASSETS, { recursive: true });

const PNG_PARTS = ['antenna-left','antenna-right','arm-left','arm-right','body-face','cheek-left','cheek-right','claw-1','claw-2','brow-l','brow-r','eye-l','eye-r','leg-1','leg-2','leg-3','leg-4','mouth','tail-side'];
for (const n of PNG_PARTS) fs.copyFileSync(path.join(PARTS, n + '.png'), path.join(ASSETS, 'p-' + n + '.png'));

// ── 공통 지오메트리 (viewBox -60 0 780 760) ──
const IMG = {
  antL:   ['p-antenna-left.png',  69, 122, 112, 228],
  antR:   ['p-antenna-right.png', 164, 115, 81, 232],
  armBig: ['p-arm-left.png',      275, 323, 137, 197],
  claw2:  ['p-claw-2.png',        385, 57, 221, 334],
  claw1:  ['p-claw-1.png',        280, 87, 159, 295],
  tail:   ['p-tail-side.png',     -45, 470, 250, 200],
  leg1:   ['p-leg-1.png',         90, 550, 60, 102],
  leg2:   ['p-leg-2.png',         145, 558, 52, 103],
  leg3:   ['p-leg-3.png',         205, 558, 52, 103],
  leg4:   ['p-leg-4.png',         260, 550, 58, 101],
  body:   ['p-body-face.png',     123, 264, 199, 338],
  armSm:  ['p-arm-right.png',     73, 405, 123, 177],
  browL:  ['p-brow-l.png', 133, 283, 42, 26],
  browR:  ['p-brow-r.png', 271, 283, 41, 26],
  eyeL:   ['p-eye-l.png',  130, 326, 45, 72],
  eyeR:   ['p-eye-r.png',  270, 326, 43, 72],
  cheekL: ['p-cheek-left.png',    117, 400, 66, 36],
  cheekR: ['p-cheek-right.png',   262, 395, 64, 36],
  mouth:  ['p-mouth.png',         183, 408, 79, 57],
};
let USE_MODE = false; // true면 <use href="#im-*"> (미리보기 갤러리용)
function img(k, extra) {
  const [href, x, y, w, h] = IMG[k];
  if (USE_MODE) return `<use href="#im-${k}"${extra ? ' ' + extra : ''}/>`;
  return `<image href="${href}" x="${x}" y="${y}" width="${w}" height="${h}"${extra ? ' ' + extra : ''}/>`;
}

const PIVOT = {
  antL: '175px 341px',
  antR: '233px 338px',
  armBig: '330px 500px',
  armLimb: '343px 421px',
  clawUp: '388px 372px',
  armSm: '186px 455px',
  face: '239px 365px',
  blink: '222px 375px',
  pet: '222px 700px',
};

// ── 고정 픽셀 바 그림자 (전체 폭의 2/3, 몸 중심 정렬) ──
const SHADOW_BAR = `<rect x="60" y="698" width="420" height="12" fill="#1e2235" opacity="0.16"/><rect x="80" y="710" width="380" height="6" fill="#1e2235" opacity="0.09"/>`;

function bodyMarkup(o) {
  o = o || {};
  return `
  <g class="ant-l">${img('antL')}</g>
  <g class="ant-r">${img('antR')}</g>
  <g class="arm-big">
    <g style="transform:rotate(10deg);transform-origin:${PIVOT.armLimb}">${img('armBig')}</g>
    ${img('claw2')}
    <g class="claw-up">${img('claw1')}</g>
  </g>
  ${img('tail', 'class="tail"')}
  <g class="lg lg1">${img('leg1')}</g>
  <g class="lg lg2">${img('leg2')}</g>
  <g class="lg lg3">${img('leg3')}</g>
  <g class="lg lg4">${img('leg4')}</g>
  ${img('body')}
  <g class="arm-sm">${img('armSm')}${o.armSmExtra || ''}</g>
  ${o.eyesJsOpen ? '<g id="eyes-js">' : ''}
  <g class="face">
    <g class="brow-l">${img('browL')}</g>
    <g class="brow-r">${img('browR')}</g>
    <g class="blink">${img('eyeL')}${img('eyeR')}</g>
    ${img('cheekL')}${img('cheekR')}${img('mouth')}
  </g>
  ${o.eyesJsOpen ? '</g>' : ''}
  ${o.extra || ''}`;
}

// 상태 공통(정적) CSS — 미리보기에서는 전역으로 1회만 출력
const BASE_CSS = `
    image { image-rendering: pixelated; }
    .face { transform: scale(0.75); transform-origin: ${PIVOT.face}; }
    .ant-l { transform-origin: ${PIVOT.antL}; }
    .ant-r { transform-origin: ${PIVOT.antR}; }
    .arm-big { transform-origin: ${PIVOT.armBig}; }
    .claw-up { transform-origin: ${PIVOT.clawUp}; }
    .arm-sm { transform-origin: ${PIVOT.armSm}; }
    .blink { transform-origin: 222px 390px; }
    .brow-l { transform-origin: 154px 296px; }
    .brow-r { transform-origin: 291px 296px; }
    .pet { transform-origin: ${PIVOT.pet}; }
    .tail { transform-origin: 190px 560px; }
`;

// ── 키보드(정면 뷰): 키를 개별 요소로, 눌림 애니메이션은 상태 CSS에서 ──
function keyboardMarkup() {
  let keys = '';
  let n = 1;
  for (let i = 0; i < 6; i++) keys += `<rect class="key kt k${n++}" x="${70 + i * 48}" y="632" width="40" height="30" rx="5"/>`;
  for (let i = 0; i < 6; i++) keys += `<rect class="key kb k${n++}" x="${70 + i * 48}" y="670" width="40" height="30" rx="5"/>`;
  keys += `<rect class="key kb k${n++}" x="118" y="708" width="216" height="18" rx="5"/>`;
  return `<g><rect x="56" y="618" width="340" height="118" rx="12" fill="#1e2235"/>${keys}</g>`;
}
// 키 13개 눌림 타이밍(의사 랜덤: 주기·지연을 제각각) — 평균 2~3개가 눌린 상태
const KEY_ANIM_CSS = (() => {
  const durations = [2.9, 3.4, 3.1, 3.8, 2.7, 3.6, 3.3, 2.8, 3.7, 3.0, 3.5, 2.6, 3.2];
  const delays =    [0.0, 1.3, 2.1, 0.7, 1.8, 0.3, 2.6, 1.1, 0.5, 2.3, 1.6, 0.9, 2.9];
  let css = `
    .kt { fill: #4a5070; }
    .kb { fill: #3a405c; }
    .key { transform-box: fill-box; }
    @keyframes keyPress {
      0%, 74%, 90%, 100% { fill: #4a5070; transform: translateY(0); }
      78%, 86% { fill: #9fb0e8; transform: translateY(2px); }
    }
    @keyframes keyPressB {
      0%, 74%, 90%, 100% { fill: #3a405c; transform: translateY(0); }
      78%, 86% { fill: #9fb0e8; transform: translateY(2px); }
    }
`;
  for (let i = 0; i < 13; i++) {
    const name = i < 6 ? 'keyPress' : 'keyPressB';
    css += `    .k${i + 1} { animation: ${name} ${durations[i]}s steps(1) ${delays[i]}s infinite; }\n`;
  }
  return css;
})();

// ── 픽셀 구름 말풍선 ──
// 내부(흰) rect 집합을 정의하고, 실루엣(테두리) 레이어는 각 rect를 10px씩
// 사방으로 확장해 자동 생성한다 → 어느 단이든 테두리가 균일하게 완성된다.
function cloudMarkup() {
  const BORDER = 10;
  // 레퍼런스(생각 구름)를 좌우반전한 형태: 사방에 볼록 돌기, 꼬리는 우하단
  const interior = [
    [-30, 70, 280, 80],   // 중심 본체
    [-10, 40, 80, 40],    // 상단 왼쪽 봉우리
    [80, 26, 80, 50],     // 상단 가운데 큰 봉우리
    [170, 44, 60, 36],    // 상단 오른쪽 봉우리
    [-48, 90, 30, 44],    // 왼쪽 옆 돌기
    [238, 84, 26, 46],    // 오른쪽 옆 돌기
    [-16, 138, 70, 32],   // 하단 왼쪽 볼록
    [66, 146, 80, 28],    // 하단 가운데 볼록
    [158, 138, 64, 30],   // 하단 오른쪽 볼록
  ];
  const rects = (a, pad) => a.map(([x, y, w, h]) =>
    `<rect x="${x - pad}" y="${y - pad}" width="${w + pad * 2}" height="${h + pad * 2}"/>`).join('');
  return `
    <g fill="#1e2235"><rect x="248" y="196" width="38" height="38"/><rect x="284" y="242" width="26" height="26"/></g>
    <g fill="#ffffff"><rect x="258" y="206" width="18" height="18"/><rect x="291" y="249" width="12" height="12"/></g>
    <g fill="#1e2235">${rects(interior, BORDER)}</g>
    <g fill="#ffffff">${rects(interior, 0)}</g>
    <rect class="dot"      x="30"  y="94" width="32" height="32" fill="#1e2235"/>
    <rect class="dot dot2" x="96"  y="94" width="32" height="32" fill="#1e2235"/>
    <rect class="dot dot3" x="162" y="94" width="32" height="32" fill="#1e2235"/>`;
}

// ── 픽셀 Z 글자 (5x5 그리드, 흰 언더레이로 시인성 확보) ──
function zPixel(x, y, u, cls) {
  const blocks = [[0, 0, 5, 1], [3, 1, 1, 1], [2, 2, 1, 1], [1, 3, 1, 1], [0, 4, 5, 1]];
  const layer = (fill, pad) => blocks.map(([bx, by, bw, bh]) =>
    `<rect x="${x + bx * u - pad}" y="${y + by * u - pad}" width="${bw * u + pad * 2}" height="${bh * u + pad * 2}" fill="${fill}"/>`).join('');
  return `<g class="${cls}">${layer('#ffffff', 5)}${layer('#5a6084', 0)}</g>`;
}

function svgDoc(css, inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-60 0 780 760">
  <style>${BASE_CSS}${css}
  </style>
${inner}
</svg>
`;
}

// ── 상태 정의 (css/마크업을 함수로 두고 테마·미리보기 두 모드로 생성) ──
const STATES = {};

STATES['idle'] = {
  label: 'idle — 대기 (눈동자 추적은 앱에서만)',
  css: () => `
    #eyes-js, #body-js { transition: transform 0.2s ease-out; }
    .pet { animation: breathe 3.4s ease-in-out infinite alternate; }
    @keyframes breathe { from { transform: scale(1,1) translateY(0); } to { transform: scale(1.008,1.02) translateY(-3px); } }
    .ant-l { animation: swayL 2.3s ease-in-out infinite alternate; }
    .ant-r { animation: swayR 2.7s ease-in-out 0.4s infinite alternate backwards; }
    @keyframes swayL { from { transform: rotate(-6deg); } to { transform: rotate(4deg); } }
    @keyframes swayR { from { transform: rotate(-4deg); } to { transform: rotate(6deg); } }
    .arm-big { animation: wave 5.6s ease-in-out infinite alternate; }
    @keyframes wave { from { transform: rotate(-1.5deg); } to { transform: rotate(1.8deg); } }
    .claw-up { animation: snap 4.8s steps(3, jump-none) infinite; }
    @keyframes snap {
      0%, 52% { transform: rotate(0deg); }
      58%, 64% { transform: rotate(-14deg); }
      67%, 71% { transform: rotate(-3deg); }
      74%, 78% { transform: rotate(-14deg); }
      84%, 100% { transform: rotate(0deg); }
    }
    .arm-sm { animation: rock 4.1s ease-in-out 0.7s infinite alternate backwards; }
    @keyframes rock { from { transform: rotate(-3deg); } to { transform: rotate(2deg); } }
    .blink { animation: blink 4.6s ease-in-out infinite; }
    @keyframes blink { 0%, 91%, 100% { transform: scaleY(1); } 94%, 97% { transform: scaleY(0.42); } }
`,
  inner: () => `
  ${SHADOW_BAR}
  <g id="body-js">
    <g class="pet">${bodyMarkup({ eyesJsOpen: true })}
    </g>
  </g>`,
};

STATES['thinking'] = {
  label: 'thinking — 생각 중',
  css: () => `
    .pet { animation: tkBreathe 3.4s ease-in-out infinite alternate; }
    @keyframes tkBreathe { from { transform: scale(1,1) translateY(0); } to { transform: scale(1.008,1.02) translateY(-3px); } }
    .face { transform: scale(0.75) translate(-8px, -10px); }
    .ant-l { animation: tkAntL 1.3s ease-in-out infinite alternate; }
    .ant-r { animation: tkAntR 1.5s ease-in-out 0.2s infinite alternate backwards; }
    @keyframes tkAntL { from { transform: rotate(-9deg); } to { transform: rotate(5deg); } }
    @keyframes tkAntR { from { transform: rotate(-5deg); } to { transform: rotate(9deg); } }
    .arm-big { animation: tkTap 2.4s ease-in-out infinite; }
    @keyframes tkTap { 0%, 100% { transform: rotate(0deg); } 30% { transform: rotate(-4deg); } 45% { transform: rotate(-1deg); } 60% { transform: rotate(-4deg); } }
    .claw-up { animation: tkPinch 2.4s steps(2, jump-none) infinite; }
    @keyframes tkPinch { 0%, 25%, 70%, 100% { transform: rotate(-2deg); } 35%, 60% { transform: rotate(-10deg); } }
    .arm-sm { transform: rotate(-4deg); }
    .brow-l { transform: translateY(-9px) rotate(6deg); }
    .brow-r { transform: translateY(2px); }
    .dot { animation: tkDot 2.4s ease-in-out infinite; opacity: 0; }
    .dot2 { animation-delay: 0.4s; }
    .dot3 { animation-delay: 0.8s; }
    @keyframes tkDot { 0%, 15% { opacity: 0; } 35%, 75% { opacity: 1; } 95%, 100% { opacity: 0; } }
`,
  inner: () => `
  ${SHADOW_BAR}
  <g class="pet">${bodyMarkup({ extra: cloudMarkup() })}
  </g>`,
};

STATES['working'] = {
  label: 'working — 작업 중',
  css: () => `
    .pet { animation: wkBounce 0.35s steps(2, jump-none) infinite; }
    @keyframes wkBounce { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-3px); } }
    .lg { animation: wkTap 0.35s steps(2, jump-none) infinite; }
    .lg2 { animation-delay: 0.09s; }
    .lg3 { animation-delay: 0.18s; }
    .lg4 { animation-delay: 0.27s; }
    @keyframes wkTap { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(9px); } }
    .tail { animation: wkTail 1.1s ease-in-out infinite alternate; }
    @keyframes wkTail { from { transform: rotate(-5deg); } to { transform: rotate(5deg); } }
    .arm-sm { animation: wkArm 1.2s ease-in-out infinite alternate; }
    @keyframes wkArm { from { transform: rotate(-5deg); } to { transform: rotate(1deg); } }
    .arm-big { animation: wkArmR 1.4s ease-in-out infinite alternate; }
    @keyframes wkArmR { from { transform: rotate(-1deg); } to { transform: rotate(2deg); } }
    .claw-up { animation: wkSnap 0.8s steps(2, jump-none) infinite; }
    @keyframes wkSnap { 0%, 100% { transform: rotate(0deg); } 50% { transform: rotate(-14deg); } }
    .ant-l { animation: wkAntL 0.9s ease-in-out infinite alternate; }
    .ant-r { animation: wkAntR 0.9s ease-in-out infinite alternate; }
    @keyframes wkAntL { from { transform: rotate(-14deg); } to { transform: rotate(12deg); } }
    @keyframes wkAntR { from { transform: rotate(14deg); } to { transform: rotate(-12deg); } }
    .blink { animation: wkBlink 3.1s ease-in-out infinite; }
    @keyframes wkBlink { 0%, 93%, 100% { transform: scaleY(1); } 96% { transform: scaleY(0.42); } }
    .brow-l { transform: rotate(24deg) scaleY(0.75); }
    .brow-r { transform: rotate(-24deg) scaleY(0.75); }
${KEY_ANIM_CSS}`,
  inner: () => `
  ${SHADOW_BAR}
  ${keyboardMarkup()}
  <g class="pet">${bodyMarkup()}
  </g>`,
};

STATES['attention'] = {
  label: 'attention — 기쁨',
  css: () => `
    .pet { animation: hpHop 0.9s ease-in-out infinite; }
    @keyframes hpHop { 0%, 100% { transform: translateY(0) scale(1,1); } 30% { transform: translateY(-26px) scale(0.99,1.02); } 55% { transform: translateY(0) scale(1.02,0.97); } 70% { transform: translateY(0) scale(1,1); } }
    .arm-big { animation: hpWave 0.9s ease-in-out infinite alternate; }
    @keyframes hpWave { from { transform: rotate(-7deg); } to { transform: rotate(5deg); } }
    .claw-up { animation: hpSnap 0.45s steps(2, jump-none) infinite; }
    @keyframes hpSnap { 0%, 100% { transform: rotate(-14deg); } 50% { transform: rotate(0deg); } }
    .arm-sm { animation: hpArmL 0.9s ease-in-out infinite alternate; }
    @keyframes hpArmL { from { transform: rotate(-14deg); } to { transform: rotate(6deg); } }
    .ant-l { animation: hpAntL 0.45s ease-in-out infinite alternate; }
    .ant-r { animation: hpAntR 0.45s ease-in-out 0.1s infinite alternate backwards; }
    @keyframes hpAntL { from { transform: rotate(-10deg); } to { transform: rotate(6deg); } }
    @keyframes hpAntR { from { transform: rotate(-6deg); } to { transform: rotate(10deg); } }
    .brow-l, .brow-r { animation: hpBrow 0.9s ease-in-out infinite; }
    @keyframes hpBrow { 0%, 100% { transform: translateY(0); } 30% { transform: translateY(-10px); } }
    .spark { animation: hpSpark 1.8s ease-in-out infinite; opacity: 0; transform-box: fill-box; transform-origin: center; }
    .sp2 { animation-delay: 0.45s; }
    .sp3 { animation-delay: 0.9s; }
    .sp4 { animation-delay: 1.35s; }
    @keyframes hpSpark { 0%, 10% { opacity: 0; transform: scale(0.4); } 25%, 45% { opacity: 1; transform: scale(1); } 60%, 100% { opacity: 0; transform: scale(0.4); } }
`,
  inner: () => `
  ${SHADOW_BAR}
  <g class="pet">${bodyMarkup({ extra: `
    <path class="spark"     d="M 60 200 l 10 22 22 10 -22 10 -10 22 -10 -22 -22 -10 22 -10 z" fill="#ffd23e"/>
    <path class="spark sp2" d="M 560 480 l 8 18 18 8 -18 8 -8 18 -8 -18 -18 -8 18 -8 z" fill="#ffd23e"/>
    <path class="spark sp3" d="M 640 210 l 9 20 20 9 -20 9 -9 20 -9 -20 -20 -9 20 -9 z" fill="#ff8a5c"/>
    <path class="spark sp4" d="M 130 90 l 8 18 18 8 -18 8 -8 18 -8 -18 -18 -8 18 -8 z" fill="#ff8a5c"/>` })}
  </g>`,
};

STATES['notification'] = {
  label: 'notification — 알림',
  css: () => `
    .pet { animation: ntHop 1.3s ease-in-out infinite; }
    @keyframes ntHop { 0%, 100% { transform: translateY(0); } 12% { transform: translateY(-20px); } 24% { transform: translateY(0); } 36% { transform: translateY(-12px); } 48%, 100% { transform: translateY(0); } }
    .ant-l { animation: ntAntL 0.35s ease-in-out infinite alternate; }
    .ant-r { animation: ntAntR 0.35s ease-in-out infinite alternate; }
    @keyframes ntAntL { from { transform: rotate(-12deg); } to { transform: rotate(-6deg); } }
    @keyframes ntAntR { from { transform: rotate(6deg); } to { transform: rotate(12deg); } }
    .claw-up { transform: rotate(-14deg); }
    .brow-l { transform: rotate(24deg) scaleY(0.75); }
    .brow-r { transform: rotate(-24deg) scaleY(0.75); }
    .badge { animation: ntBadge 1.3s ease-in-out infinite; transform-origin: 447px 190px; }
    @keyframes ntBadge { 0%, 100% { transform: translateY(0) scale(1); } 12% { transform: translateY(-16px) scale(1.1); } 24% { transform: translateY(0) scale(1); } 36% { transform: translateY(-9px) scale(1.05); } 48%, 100% { transform: translateY(0) scale(1); } }
`,
  inner: () => `
  ${SHADOW_BAR}
  <g class="pet">${bodyMarkup()}
  </g>
  <g class="badge">
    <g fill="#1e2235">
      <rect x="413" y="46" width="64" height="34"/>
      <rect x="399" y="60" width="92" height="148"/>
      <rect x="409" y="188" width="72" height="34"/>
      <rect x="419" y="202" width="52" height="32"/>
      <rect x="405" y="242" width="80" height="78"/>
    </g>
    <g fill="#ffd23e">
      <rect x="423" y="56" width="44" height="14"/>
      <rect x="409" y="70" width="72" height="128"/>
      <rect x="419" y="198" width="52" height="14"/>
      <rect x="429" y="212" width="32" height="12"/>
      <rect x="415" y="252" width="60" height="58"/>
    </g>
  </g>`,
};

STATES['error'] = {
  label: 'error — 오류',
  css: () => `
    .pet { animation: erShake 2.6s ease-in-out infinite; }
    @keyframes erShake { 0%, 40%, 100% { transform: translateX(0); } 5% { transform: translateX(-15px); } 10% { transform: translateX(13px); } 15% { transform: translateX(-11px); } 20% { transform: translateX(9px); } 25% { transform: translateX(-6px); } 30% { transform: translateX(4px); } 35% { transform: translateX(0); } }
    .ant-l { transform: rotate(-26deg); }
    .ant-r { animation: erAntR 2.6s ease-in-out infinite; }
    @keyframes erAntR { 0%, 100% { transform: rotate(24deg); } 50% { transform: rotate(20deg); } }
    .face { transform: scale(0.75) translate(0, 6px); }
    .brow-l { transform: rotate(-10deg) translateY(-3px); }
    .brow-r { transform: rotate(10deg) translateY(-3px); }
    .arm-sm { transform: rotate(-8deg); }
    .arm-big { transform: rotate(3deg); }
    .claw-up { animation: erClaw 2.6s steps(2, jump-none) infinite; }
    @keyframes erClaw { 0%, 55%, 100% { transform: rotate(-2deg); } 8%, 45% { transform: rotate(-9deg); } }
    .drop { animation: erDrop 2.6s ease-in infinite; }
    @keyframes erDrop {
      0%, 22% { opacity: 0; transform: translateY(0); }
      32%, 72% { opacity: 1; }
      50% { transform: translateY(26px); }
      92%, 100% { opacity: 0; transform: translateY(84px); }
    }
`,
  inner: () => `
  ${SHADOW_BAR}
  <g class="pet">${bodyMarkup({ extra: `
    <g class="drop">
      <path d="M 322 300 q 26 46 26 70 a 26 26 0 1 1 -52 0 q 0 -24 26 -70 z" fill="#7ec8ff" stroke="#3f7fbf" stroke-width="6"/>
      <path d="M 334 346 q 8 13 4 32" stroke="#ffffff" stroke-width="7" stroke-linecap="round" fill="none" opacity="0.95"/>
    </g>` })}
  </g>`,
};

STATES['sleeping'] = {
  label: 'sleeping — 수면',
  css: () => `
    .pet { animation: slBreathe 5.2s ease-in-out infinite alternate; }
    @keyframes slBreathe { from { transform: scale(1,1) translateY(0); } to { transform: scale(1.014,1.035) translateY(-4px); } }
    .blink { transform: scaleY(0.08); }
    .brow-l { transform: translateY(9px) rotate(-6deg); }
    .brow-r { transform: translateY(9px) rotate(6deg); }
    .face { transform: scale(0.75) translate(0, 8px); }
    .ant-l { animation: slAntL 5.2s ease-in-out infinite alternate; }
    .ant-r { animation: slAntR 5.2s ease-in-out infinite alternate; }
    @keyframes slAntL { from { transform: rotate(-24deg); } to { transform: rotate(-21deg); } }
    @keyframes slAntR { from { transform: rotate(20deg); } to { transform: rotate(23deg); } }
    .arm-sm { transform: rotate(-10deg); }
    .arm-big { transform: rotate(4deg); }
    .zz { opacity: 0; }
    .z1 { animation: slZ 5.2s ease-in-out infinite; }
    .z2 { animation: slZ 5.2s ease-in-out 1.7s infinite; }
    .z3 { animation: slZ 5.2s ease-in-out 3.4s infinite; }
    @keyframes slZ { 0% { opacity: 0; transform: translate(0, 0); } 20%, 60% { opacity: 0.95; } 100% { opacity: 0; transform: translate(-30px, -70px); } }
`,
  inner: () => `
  ${SHADOW_BAR}
  <g class="pet">${bodyMarkup({ extra: `
    ${zPixel(126, 244, 13, 'zz z1')}
    ${zPixel(56, 158, 18, 'zz z2')}
    ${zPixel(-24, 56, 23, 'zz z3')}` })}
  </g>`,
};

// ═══════════ working 티어 (동시 세션 수별) ═══════════

// 저글링: 픽셀 공 3개가 양팔 사이를 순환
STATES['juggling'] = {
  label: 'juggling — 저글링 (동시 세션 2)',
  css: () => `
    .pet { animation: jgBounce 0.83s ease-in-out infinite; }
    @keyframes jgBounce { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-5px); } }
    .arm-sm { animation: jgArmL 0.83s ease-in-out infinite alternate; }
    @keyframes jgArmL { from { transform: rotate(-18deg); } to { transform: rotate(4deg); } }
    .arm-big { animation: jgArmR 0.83s ease-in-out infinite alternate; }
    @keyframes jgArmR { from { transform: rotate(-4deg); } to { transform: rotate(4deg); } }
    .claw-up { animation: jgSnap 0.83s steps(2, jump-none) infinite; }
    @keyframes jgSnap { 0%, 100% { transform: rotate(-10deg); } 50% { transform: rotate(0deg); } }
    .face { transform: scale(0.75) translate(0, -8px); }
    .brow-l, .brow-r { transform: translateY(-8px); }
    .ant-l { animation: jgAntL 0.83s ease-in-out infinite alternate; }
    .ant-r { animation: jgAntR 0.83s ease-in-out infinite alternate; }
    @keyframes jgAntL { from { transform: rotate(-8deg); } to { transform: rotate(4deg); } }
    @keyframes jgAntR { from { transform: rotate(-4deg); } to { transform: rotate(8deg); } }
    .ball { animation: jgOrbit 1.66s linear infinite; }
    .b2 { animation-delay: -0.55s; }
    .b3 { animation-delay: -1.11s; }
    @keyframes jgOrbit {
      0% { transform: translate(0, 0); }
      30% { transform: translate(110px, -290px); }
      48% { transform: translate(250px, -130px); }
      62% { transform: translate(170px, -30px); }
      100% { transform: translate(0, 0); }
    }
`,
  inner: () => `
  ${SHADOW_BAR}
  <g class="pet">${bodyMarkup({ extra: `
    <rect class="ball"    x="140" y="440" width="34" height="34" fill="#ffd23e" stroke="#1e2235" stroke-width="6"/>
    <rect class="ball b2" x="140" y="440" width="34" height="34" fill="#7ec8ff" stroke="#1e2235" stroke-width="6"/>
    <rect class="ball b3" x="140" y="440" width="34" height="34" fill="#ff8a5c" stroke="#1e2235" stroke-width="6"/>` })}
  </g>`,
};

// 건설: 큰 집게가 망치를 휘둘러 블록을 두드림
STATES['building'] = {
  label: 'building — 건설 (동시 세션 3+)',
  css: () => `
    .pet { animation: bdBounce 0.9s ease-in-out infinite; }
    @keyframes bdBounce { 0%, 35%, 100% { transform: translateY(0); } 48% { transform: translateY(4px); } 60% { transform: translateY(0); } }
    .brow-l { transform: rotate(24deg) scaleY(0.75); }
    .brow-r { transform: rotate(-24deg) scaleY(0.75); }
    .arm-big { animation: bdArm 0.9s ease-in infinite; }
    @keyframes bdArm { 0%, 15% { transform: rotate(-6deg); } 40%, 55% { transform: rotate(4deg); } 80%, 100% { transform: rotate(-6deg); } }
    .claw-up { animation: bdGrip 0.9s steps(2, jump-none) infinite; }
    @keyframes bdGrip { 0%, 15% { transform: rotate(-10deg); } 40%, 100% { transform: rotate(-2deg); } }
    .hammer { transform-origin: 462px 352px; animation: bdSwing 0.9s ease-in infinite; }
    @keyframes bdSwing { 0%, 15% { transform: rotate(-52deg); } 40%, 55% { transform: rotate(8deg); } 80%, 100% { transform: rotate(-52deg); } }
    .spark { opacity: 0; animation: bdSpark 0.9s linear infinite; transform-box: fill-box; transform-origin: center; }
    @keyframes bdSpark { 0%, 38% { opacity: 0; transform: scale(0.4); } 44%, 56% { opacity: 1; transform: scale(1); } 64%, 100% { opacity: 0; transform: scale(0.4); } }
    .ant-l { animation: bdAnt 0.9s ease-in-out infinite alternate; }
    .ant-r { animation: bdAnt 0.9s ease-in-out 0.2s infinite alternate backwards; }
    @keyframes bdAnt { from { transform: rotate(-5deg); } to { transform: rotate(5deg); } }
`,
  inner: () => `
  ${SHADOW_BAR}
  <rect x="530" y="606" width="104" height="84" fill="#1e2235"/>
  <rect x="544" y="620" width="34" height="24" fill="#3a405c"/>
  <rect x="586" y="650" width="34" height="26" fill="#3a405c"/>
  <g class="pet">${bodyMarkup({ extra: `
    <g class="hammer">
      <rect x="470" y="360" width="18" height="150" fill="#b07840" stroke="#1e2235" stroke-width="6"/>
      <rect x="436" y="486" width="86" height="46" fill="#4a5070" stroke="#1e2235" stroke-width="6"/>
    </g>
    <path class="spark" d="M 560 570 l 8 18 18 8 -18 8 -8 18 -8 -18 -18 -8 18 -8 z" fill="#ffd23e"/>
    <path class="spark" style="animation-delay:0.06s" d="M 620 590 l 7 15 15 7 -15 7 -7 15 -7 -15 -15 -7 15 -7 z" fill="#ff8a5c"/>` })}
  </g>`,
};

// 지휘: 작은 팔이 지휘봉을 흔들고 픽셀 음표가 떠오름
STATES['conducting'] = {
  label: 'conducting — 지휘 (서브에이전트 2+)',
  css: () => `
    .pet { animation: cdSway 1.6s ease-in-out infinite alternate; }
    @keyframes cdSway { from { transform: rotate(-2deg); } to { transform: rotate(2deg); } }
    .arm-sm { animation: cdWave 0.8s ease-in-out infinite alternate; }
    @keyframes cdWave { from { transform: rotate(-26deg); } to { transform: rotate(8deg); } }
    .arm-big { animation: cdArmR 0.8s ease-in-out 0.4s infinite alternate backwards; }
    @keyframes cdArmR { from { transform: rotate(-3deg); } to { transform: rotate(3deg); } }
    .claw-up { animation: cdSnap 1.6s steps(2, jump-none) infinite; }
    @keyframes cdSnap { 0%, 40%, 100% { transform: rotate(-2deg); } 50%, 90% { transform: rotate(-12deg); } }
    .brow-l { transform: translateY(-6px); }
    .brow-r { transform: translateY(-6px); }
    .ant-l { animation: cdAntL 0.8s ease-in-out infinite alternate; }
    .ant-r { animation: cdAntR 0.8s ease-in-out infinite alternate; }
    @keyframes cdAntL { from { transform: rotate(-10deg); } to { transform: rotate(6deg); } }
    @keyframes cdAntR { from { transform: rotate(-6deg); } to { transform: rotate(10deg); } }
    .note { opacity: 0; }
    .n1 { animation: cdNote 2.4s ease-out infinite; }
    .n2 { animation: cdNote 2.4s ease-out 0.8s infinite; }
    .n3 { animation: cdNote 2.4s ease-out 1.6s infinite; }
    @keyframes cdNote { 0% { opacity: 0; transform: translate(0, 0); } 15%, 60% { opacity: 1; } 100% { opacity: 0; transform: translate(-24px, -90px); } }
`,
  inner: () => `
  ${SHADOW_BAR}
  <g class="pet">${bodyMarkup({
    armSmExtra: `<rect x="52" y="366" width="12" height="110" fill="#1e2235" transform="rotate(-28 58 476)"/>`,
    extra: `
    <g class="note n1"><rect x="60" y="280" width="18" height="18" fill="#1e2235"/><rect x="74" y="238" width="6" height="52" fill="#1e2235"/></g>
    <g class="note n2"><rect x="118" y="240" width="18" height="18" fill="#1e2235"/><rect x="132" y="198" width="6" height="52" fill="#1e2235"/></g>
    <g class="note n3"><rect x="24" y="216" width="18" height="18" fill="#1e2235"/><rect x="38" y="174" width="6" height="52" fill="#1e2235"/></g>` })}
  </g>`,
};

// ═══════════ 미니 모드 8종 ═══════════

STATES['mini-idle'] = {
  label: 'mini-idle — 미니: 대기',
  css: () => STATES['idle'].css(),
  inner: () => `
  ${SHADOW_BAR}
  <g class="pet">${bodyMarkup()}
  </g>`,
};

STATES['mini-enter'] = {
  label: 'mini-enter — 미니: 등장',
  css: () => `
    .pet { animation: meIn 1.1s cubic-bezier(0.22, 0.9, 0.35, 1.1) both, meBreathe 3.4s ease-in-out 1.1s infinite alternate; }
    @keyframes meIn { 0% { transform: translateX(-660px); } 75% { transform: translateX(16px); } 100% { transform: translateX(0); } }
    @keyframes meBreathe { from { transform: scale(1,1) translateY(0); } to { transform: scale(1.008,1.02) translateY(-3px); } }
    .ant-l { animation: meAntL 2.3s ease-in-out infinite alternate; }
    .ant-r { animation: meAntR 2.7s ease-in-out infinite alternate; }
    @keyframes meAntL { from { transform: rotate(-6deg); } to { transform: rotate(4deg); } }
    @keyframes meAntR { from { transform: rotate(-4deg); } to { transform: rotate(6deg); } }
`,
  inner: () => `
  <g class="pet">${bodyMarkup()}
  </g>`,
};

STATES['mini-enter-sleep'] = {
  label: 'mini-enter-sleep — 미니: 졸린 등장',
  css: () => `
    .pet { animation: mesIn 1.45s ease-out both, mesBreathe 5.2s ease-in-out 1.45s infinite alternate; }
    @keyframes mesIn { 0% { transform: translateX(-660px); } 100% { transform: translateX(0); } }
    @keyframes mesBreathe { from { transform: scale(1,1) translateY(0); } to { transform: scale(1.014,1.035) translateY(-4px); } }
    .blink { transform: scaleY(0.08); }
    .brow-l { transform: translateY(9px) rotate(-6deg); }
    .brow-r { transform: translateY(9px) rotate(6deg); }
    .face { transform: scale(0.75) translate(0, 8px); }
    .ant-l { transform: rotate(-22deg); }
    .ant-r { transform: rotate(21deg); }
    .arm-sm { transform: rotate(-10deg); }
`,
  inner: () => `
  <g class="pet">${bodyMarkup()}
  </g>`,
};

STATES['mini-crabwalk'] = {
  label: 'mini-crabwalk — 미니: 게걸음',
  css: () => `
    .pet { animation: mcWalk 1.16s ease-in-out infinite; }
    @keyframes mcWalk { 0%, 100% { transform: translateX(-36px) rotate(-2deg); } 50% { transform: translateX(36px) rotate(2deg); } }
    .lg { animation: mcStep 0.29s steps(2, jump-none) infinite; }
    .lg2 { animation-delay: 0.07s; }
    .lg3 { animation-delay: 0.14s; }
    .lg4 { animation-delay: 0.21s; }
    @keyframes mcStep { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(8px); } }
    .ant-l { animation: mcAntL 0.58s ease-in-out infinite alternate; }
    .ant-r { animation: mcAntR 0.58s ease-in-out infinite alternate; }
    @keyframes mcAntL { from { transform: rotate(-10deg); } to { transform: rotate(6deg); } }
    @keyframes mcAntR { from { transform: rotate(-6deg); } to { transform: rotate(10deg); } }
    .tail { animation: mcTail 0.58s ease-in-out infinite alternate; }
    @keyframes mcTail { from { transform: rotate(-4deg); } to { transform: rotate(4deg); } }
`,
  inner: () => `
  ${SHADOW_BAR}
  <g class="pet">${bodyMarkup()}
  </g>`,
};

STATES['mini-peek'] = {
  label: 'mini-peek — 미니: 빼꼼',
  css: () => `
    .pet { animation: mpPeek 1.5s ease-in-out both; }
    @keyframes mpPeek { 0% { transform: translateY(480px); } 35%, 75% { transform: translateY(330px); } 100% { transform: translateY(480px); } }
    .brow-l, .brow-r { transform: translateY(-9px); }
    .ant-l { animation: mpAnt 0.5s ease-in-out infinite alternate; }
    .ant-r { animation: mpAnt 0.5s ease-in-out 0.12s infinite alternate backwards; }
    @keyframes mpAnt { from { transform: rotate(-7deg); } to { transform: rotate(7deg); } }
`,
  inner: () => `
  <g class="pet">${bodyMarkup()}
  </g>`,
};

STATES['mini-alert'] = {
  label: 'mini-alert — 미니: 알림',
  css: () => STATES['notification'].css(),
  inner: () => STATES['notification'].inner(),
};

STATES['mini-happy'] = {
  label: 'mini-happy — 미니: 기쁨',
  css: () => STATES['attention'].css(),
  inner: () => STATES['attention'].inner(),
};

STATES['mini-sleep'] = {
  label: 'mini-sleep — 미니: 수면',
  css: () => STATES['sleeping'].css(),
  inner: () => STATES['sleeping'].inner(),
};

// ═══════════ 리액션 (클릭·드래그) ═══════════

STATES['react-drag'] = {
  label: 'react-drag — 드래그: 대롱대롱',
  css: () => `
    .pet { transform-origin: 260px 60px; animation: rdSwing 1.3s ease-in-out infinite alternate; }
    @keyframes rdSwing { from { transform: rotate(-11deg); } to { transform: rotate(11deg); } }
    .lg { animation: rdDangle 0.9s ease-in-out infinite alternate; }
    .lg2 { animation-delay: 0.15s; }
    .lg3 { animation-delay: 0.3s; }
    .lg4 { animation-delay: 0.45s; }
    @keyframes rdDangle { from { transform: translateY(4px); } to { transform: translateY(11px); } }
    .tail { animation: rdTail 1.3s ease-in-out infinite alternate; }
    @keyframes rdTail { from { transform: rotate(-7deg); } to { transform: rotate(7deg); } }
    .ant-l { transform: rotate(-18deg); }
    .ant-r { transform: rotate(18deg); }
    .brow-l, .brow-r { transform: translateY(-10px); }
    .arm-sm { animation: rdArm 0.9s ease-in-out infinite alternate; }
    @keyframes rdArm { from { transform: rotate(-14deg); } to { transform: rotate(-2deg); } }
`,
  inner: () => `
  <g class="pet">${bodyMarkup()}
  </g>`,
};

STATES['react-poke'] = {
  label: 'react-poke — 클릭: 화들짝',
  css: () => `
    .pet { animation: rpJump 1.1s cubic-bezier(0.3, 1.4, 0.5, 1) both; }
    @keyframes rpJump { 0% { transform: translateY(0); } 22% { transform: translateY(-48px); } 52% { transform: translateY(0); } 68% { transform: translateY(-14px); } 84%, 100% { transform: translateY(0); } }
    .brow-l, .brow-r { transform: translateY(-12px); }
    .ant-l { animation: rpAnt 0.3s ease-in-out infinite alternate; }
    .ant-r { animation: rpAnt 0.3s ease-in-out 0.07s infinite alternate backwards; }
    @keyframes rpAnt { from { transform: rotate(-12deg); } to { transform: rotate(-4deg); } }
    .claw-up { transform: rotate(-14deg); }
    .qm { animation: rpQm 1.4s ease-out both; opacity: 0; }
    @keyframes rpQm { 0% { opacity: 0; transform: translateY(8px); } 18%, 72% { opacity: 1; transform: translateY(0); } 100% { opacity: 0; transform: translateY(-14px); } }
`,
  inner: () => `
  ${SHADOW_BAR}
  <g class="pet">${bodyMarkup({ extra: `
    <g class="qm" fill="#ffd23e">
      <rect x="150" y="150" width="26" height="56"/>
      <rect x="150" y="222" width="26" height="24"/>
    </g>` })}
  </g>`,
};

STATES['react-double'] = {
  label: 'react-double — 더블클릭: 신남',
  css: () => `
    .pet { animation: rdbHop 0.65s ease-in-out infinite; }
    @keyframes rdbHop { 0%, 100% { transform: translateY(0) scale(1,1); } 35% { transform: translateY(-20px) scale(0.99,1.02); } 60% { transform: translateY(0) scale(1.02,0.97); } 80% { transform: translateY(0) scale(1,1); } }
    .claw-up { animation: rdbSnap 0.32s steps(2, jump-none) infinite; }
    @keyframes rdbSnap { 0%, 100% { transform: rotate(-14deg); } 50% { transform: rotate(0deg); } }
    .arm-big { animation: rdbWave 0.65s ease-in-out infinite alternate; }
    @keyframes rdbWave { from { transform: rotate(-6deg); } to { transform: rotate(5deg); } }
    .arm-sm { animation: rdbArmL 0.65s ease-in-out infinite alternate; }
    @keyframes rdbArmL { from { transform: rotate(-16deg); } to { transform: rotate(6deg); } }
    .brow-l, .brow-r { animation: rdbBrow 0.65s ease-in-out infinite; }
    @keyframes rdbBrow { 0%, 100% { transform: translateY(0); } 35% { transform: translateY(-11px); } }
    .heart { opacity: 0; }
    .h1 { animation: rdbHeart 1.6s ease-out infinite; }
    .h2 { animation: rdbHeart 1.6s ease-out 0.8s infinite; }
    @keyframes rdbHeart { 0% { opacity: 0; transform: translate(0, 0) scale(0.7); } 15%, 60% { opacity: 1; transform: translate(-8px, -40px) scale(1); } 100% { opacity: 0; transform: translate(-16px, -90px) scale(1); } }
`,
  inner: () => `
  ${SHADOW_BAR}
  <g class="pet">${bodyMarkup({ extra: `
    <g class="heart h1" fill="#ff5b6a">
      <rect x="90" y="180" width="16" height="16"/><rect x="114" y="180" width="16" height="16"/>
      <rect x="82" y="192" width="56" height="16"/><rect x="90" y="208" width="40" height="12"/>
      <rect x="100" y="220" width="20" height="10"/>
    </g>
    <g class="heart h2" fill="#ff8a9d">
      <rect x="150" y="140" width="12" height="12"/><rect x="168" y="140" width="12" height="12"/>
      <rect x="144" y="149" width="42" height="12"/><rect x="150" y="161" width="30" height="9"/>
      <rect x="158" y="170" width="14" height="8"/>
    </g>` })}
  </g>`,
};

// ── 테마 SVG 생성 (파일 참조 모드) ──
USE_MODE = false;
for (const [key, st] of Object.entries(STATES)) {
  fs.writeFileSync(path.join(ASSETS, `clawad-${key}.svg`), svgDoc(st.css(), st.inner()));
}

// ── theme.json ──
const themeJson = {
  schemaVersion: 1,
  name: 'ClawAd',
  author: 'TJmedia',
  version: '1.5.0',
  description: 'ClawAd 픽셀 랍스터 마스코트 테마',
  viewBox: { x: -60, y: 0, width: 780, height: 760 },
  layout: {
    contentBox: { x: -45, y: 45, width: 665, height: 665 },
    centerX: 222,
    baselineY: 706,
    visibleHeightRatio: 0.58,
    baselineBottomRatio: 0.05,
  },
  rendering: { svgChannel: 'object' },
  eyeTracking: {
    enabled: true,
    states: ['idle'],
    eyeRatioX: 0.5,
    eyeRatioY: 0.48,
    maxOffset: 16,
    bodyScale: 0.33,
    ids: { eyes: 'eyes-js', body: 'body-js' },
  },
  states: {
    idle: ['clawad-idle.svg'],
    thinking: ['clawad-thinking.svg'],
    working: ['clawad-working.svg'],
    juggling: ['clawad-juggling.svg'],
    attention: ['clawad-attention.svg'],
    notification: ['clawad-notification.svg'],
    error: ['clawad-error.svg'],
    sleeping: ['clawad-sleeping.svg'],
  },
  workingTiers: [
    { minSessions: 3, file: 'clawad-building.svg' },
    { minSessions: 2, file: 'clawad-juggling.svg' },
    { minSessions: 1, file: 'clawad-working.svg' },
  ],
  jugglingTiers: [
    { minSessions: 2, file: 'clawad-conducting.svg' },
    { minSessions: 1, file: 'clawad-juggling.svg' },
  ],
  reactions: {
    drag: { file: 'clawad-react-drag.svg' },
    clickLeft: { file: 'clawad-react-poke.svg', duration: 2600 },
    double: { files: ['clawad-react-double.svg'], duration: 3200 },
  },
  sleepSequence: { mode: 'direct' },
  timings: {
    minDisplay: { attention: 2700, error: 5000, notification: 2600, working: 1000, thinking: 1000 },
    autoReturn: { attention: 2700, error: 5200, notification: 2600 },
    mouseIdleTimeout: 20000,
    mouseSleepTimeout: 60000,
  },
  hitBoxes: {
    default: { x: 60, y: 250, w: 380, h: 440 },
    sleeping: { x: 60, y: 380, w: 380, h: 310 },
  },
  miniMode: {
    supported: true,
    viewBox: { x: -60, y: 0, width: 780, height: 760 },
    states: {
      'mini-idle': ['clawad-mini-idle.svg'],
      'mini-enter': ['clawad-mini-enter.svg'],
      'mini-enter-sleep': ['clawad-mini-enter-sleep.svg'],
      'mini-crabwalk': ['clawad-mini-crabwalk.svg'],
      'mini-peek': ['clawad-mini-peek.svg'],
      'mini-alert': ['clawad-mini-alert.svg'],
      'mini-happy': ['clawad-mini-happy.svg'],
      'mini-sleep': ['clawad-mini-sleep.svg'],
    },
    timings: {
      minDisplay: { 'mini-alert': 2600, 'mini-happy': 3600, 'mini-peek': 1500 },
      autoReturn: { 'mini-alert': 2600, 'mini-happy': 3600, 'mini-peek': 1500 },
    },
  },
};
fs.writeFileSync(path.join(OUT, 'theme.json'), JSON.stringify(themeJson, null, 2) + '\n');

// ── 미리보기 갤러리 생성 (<use> + data URI, CSS는 상태별로 스코프) ──
USE_MODE = true;
function scopeCss(css, scope) {
  return css.replace(/^(\s*)([.#][^{}@\n]+)\{/gm, (m, ind, sel) =>
    ind + sel.split(',').map(s => `${scope} ${s.trim()}`).join(', ') + ' {');
}
const defs = Object.entries(IMG).map(([k, [href, x, y, w, h]]) => {
  const b64 = fs.readFileSync(path.join(ASSETS, href)).toString('base64');
  return `<image id="im-${k}" href="data:image/png;base64,${b64}" x="${x}" y="${y}" width="${w}" height="${h}"/>`;
}).join('\n');

let cards = '';
let scopedCss = '';
for (const [key, st] of Object.entries(STATES)) {
  scopedCss += scopeCss(st.css(), `#st-${key}`) + '\n';
  cards += `
    <figure class="card">
      <svg id="st-${key}" viewBox="-60 0 780 760">${st.inner()}</svg>
      <figcaption>${st.label}</figcaption>
    </figure>`;
}

const preview = `<title>ClawAd 테마 상태 미리보기</title>
<style>
  :root { --bg: #faf6ef; --card: #ffffff; --line: #e5ddcf; --text: #3b3630; --sub: #8a8378; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #14161d; --card: #1c1f29; --line: #2b2f3d; --text: #e8e6e1; --sub: #6f7482; }
  }
  :root[data-theme="dark"] { --bg: #14161d; --card: #1c1f29; --line: #2b2f3d; --text: #e8e6e1; --sub: #6f7482; }
  :root[data-theme="light"] { --bg: #faf6ef; --card: #ffffff; --line: #e5ddcf; --text: #3b3630; --sub: #8a8378; }
  body { background: var(--bg); color: var(--text); font-family: 'Segoe UI', system-ui, sans-serif; margin: 0; padding: 28px 20px 48px; }
  h1 { font-size: 20px; letter-spacing: 0.04em; margin: 0 0 4px; text-align: center; }
  p.note { text-align: center; color: var(--sub); font-size: 13px; margin: 0 0 26px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 18px; max-width: 1180px; margin: 0 auto; }
  .card { margin: 0; background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 12px 12px 6px; }
  .card svg { width: 100%; height: auto; display: block; }
  figcaption { text-align: center; font-size: 13px; color: var(--sub); padding: 6px 0 8px; font-variant-numeric: tabular-nums; }
  .defs { position: absolute; width: 0; height: 0; overflow: hidden; }
  svg image { image-rendering: pixelated; }
${BASE_CSS.replace(/^    image \{.*$\n/m, '').split('\n').map(l => l).join('\n')}
${scopedCss}
</style>
<svg class="defs" aria-hidden="true"><defs>
${defs}
</defs></svg>
<h1>ClawAd 테마 — 상태별 애니메이션</h1>
<p class="note">clawd-on-desk 테마 v${themeJson.version} · idle의 눈동자 커서 추적은 앱 런타임에서만 동작합니다</p>
<div class="grid">${cards}
</div>
`;
fs.writeFileSync(path.join(__dirname, 'theme-preview.html'), preview);

console.log('theme written:', OUT);
console.log('assets:', fs.readdirSync(ASSETS).length, 'files');
console.log('preview written: theme-preview.html');

// ── 앱 스키마로 자체 검증 ──
const schema = require('./spec/theme-schema.js');
const errors = schema.validateTheme(themeJson);
if (errors.length) { console.error('VALIDATION ERRORS:', errors); process.exit(1); }
const effective = schema.mergeDefaults(themeJson, 'clawad', false);
const missing = schema.collectRequiredAssetFiles(effective).filter(f => !fs.existsSync(path.join(ASSETS, f)));
if (missing.length) { console.error('MISSING ASSETS:', missing); process.exit(1); }
console.log('schema validation: OK');
