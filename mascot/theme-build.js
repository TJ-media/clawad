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
  armSm: '188px 545px',   // 작은 팔-몸통 연결부 (팔 이미지의 오른쪽 아래)
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
    ${img('cheekL')}${img('cheekR')}<g class="mouth">${img('mouth')}</g>
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
    .mouth { transform-origin: 222px 437px; }
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

// ── 픽셀 하트 (흰 언더레이로 시인성 확보) ──
function heartPixel(x, y, s, cls, color) {
  const blocks = [[8, 0, 16, 16], [32, 0, 16, 16], [0, 12, 56, 16], [8, 28, 40, 12], [18, 40, 20, 10]];
  const layer = (fill, pad) => blocks.map(([bx, by, bw, bh]) =>
    `<rect x="${x + bx * s - pad}" y="${y + by * s - pad}" width="${bw * s + pad * 2}" height="${bh * s + pad * 2}" fill="${fill}"/>`).join('');
  return `<g class="${cls}">${layer('#ffffff', 5)}${layer(color, 0)}</g>`;
}

// ── 픽셀 모니터 (프레임 + 타이핑되는 코드 라인) ──
// 라인은 .ln1~.ln4 클래스로 노출 — 상태 CSS에서 scaleX(왼쪽 기준)로 타이핑 연출
function monitorPixel(x, y, cls) {
  return `<g class="${cls}">
    <rect x="${x}" y="${y}" width="190" height="130" fill="#1e2235"/>
    <rect x="${x + 12}" y="${y + 12}" width="166" height="94" fill="#3a4368"/>
    <rect class="ln ln1" x="${x + 24}" y="${y + 26}" width="90" height="10" fill="#9fb0e8"/>
    <rect class="ln ln2" x="${x + 24}" y="${y + 44}" width="120" height="10" fill="#7ec8ff"/>
    <rect class="ln ln3" x="${x + 40}" y="${y + 62}" width="80" height="10" fill="#9fb0e8"/>
    <rect class="ln ln4" x="${x + 24}" y="${y + 80}" width="60" height="10" fill="#ffd23e"/>
    <rect class="caret" x="${x + 90}" y="${y + 80}" width="12" height="10" fill="#ffffff"/>
    <rect x="${x + 75}" y="${y + 130}" width="40" height="18" fill="#1e2235"/>
    <rect x="${x + 55}" y="${y + 148}" width="80" height="12" fill="#1e2235"/>
  </g>`;
}
// 타이핑 라인 키프레임 생성 (prefix로 상태별 네임스페이스)
function typingCss(prefix, cycle) {
  const spans = [[0, 18], [25, 43], [50, 68], [75, 90]];
  let css = `    .ln { transform-box: fill-box; transform-origin: left center; }\n`;
  spans.forEach(([a, b], i) => {
    css += `    .ln${i + 1} { animation: ${prefix}L${i + 1} ${cycle}s steps(6) infinite; }
    @keyframes ${prefix}L${i + 1} { 0%${a > 0 ? `, ${a}%` : ''} { transform: scaleX(0); } ${b}%, 100% { transform: scaleX(1); } }\n`;
  });
  return css;
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

// ═══════════ 수면 시퀀스 (full 모드: yawning → dozing → collapsing → sleeping → waking) ═══════════

// 하품: 입 크게 + 눈 질끈 + 팔로 입 가리기 + 기지개
STATES['yawning'] = {
  label: 'yawning — 하품 (수면 진입 1)',
  css: () => `
    .pet { animation: ywStretch 3.6s ease-in-out infinite; }
    @keyframes ywStretch {
      0%, 12%, 78%, 100% { transform: scale(1, 1) translateY(0); }
      30%, 52% { transform: scale(1.012, 1.03) translateY(-6px); }
    }
    .mouth { animation: ywMouth 3.6s ease-in-out infinite; }
    @keyframes ywMouth {
      0%, 12%, 78%, 100% { transform: scale(1); }
      28%, 55% { transform: scale(1.65); }
    }
    .blink { animation: ywEyes 3.6s ease-in-out infinite; }
    @keyframes ywEyes {
      0%, 10% { transform: scaleY(1); }
      25%, 58% { transform: scaleY(0.12); }
      72%, 100% { transform: scaleY(0.5); }
    }
    .brow-l { animation: ywBrowL 3.6s ease-in-out infinite; }
    .brow-r { animation: ywBrowR 3.6s ease-in-out infinite; }
    @keyframes ywBrowL { 0%, 12% { transform: translateY(0); } 30%, 55% { transform: translateY(-8px); } 78%, 100% { transform: translateY(5px) rotate(-4deg); } }
    @keyframes ywBrowR { 0%, 12% { transform: translateY(0); } 30%, 55% { transform: translateY(-8px); } 78%, 100% { transform: translateY(5px) rotate(4deg); } }
    .ant-l { animation: ywAntL 3.6s ease-in-out infinite; }
    .ant-r { animation: ywAntR 3.6s ease-in-out infinite; }
    @keyframes ywAntL { 0%, 12% { transform: rotate(-6deg); } 35%, 55% { transform: rotate(-12deg); } 80%, 100% { transform: rotate(-14deg); } }
    @keyframes ywAntR { 0%, 12% { transform: rotate(6deg); } 35%, 55% { transform: rotate(12deg); } 80%, 100% { transform: rotate(13deg); } }
`,
  inner: () => `
  ${SHADOW_BAR}
  <g class="pet">${bodyMarkup()}
  </g>`,
};

// 꾸벅꾸벅: 반쯤 감긴 눈으로 천천히 앞으로 기울다 화들짝 되돌아옴
STATES['dozing'] = {
  label: 'dozing — 꾸벅꾸벅 (수면 진입 2)',
  css: () => `
    .pet { animation: dzNod 5.8s ease-in-out infinite; }
    @keyframes dzNod {
      0%, 8% { transform: rotate(0deg) translateY(0); }
      38% { transform: rotate(3deg) translateY(4px); }
      50% { transform: rotate(4.5deg) translateY(7px); }
      56% { transform: rotate(-1deg) translateY(-2px); }
      62%, 100% { transform: rotate(0deg) translateY(0); }
    }
    .blink { animation: dzEyes 5.8s ease-in-out infinite; }
    @keyframes dzEyes {
      0%, 8% { transform: scaleY(0.5); }
      38%, 52% { transform: scaleY(0.12); }
      58%, 66% { transform: scaleY(0.85); }
      80%, 100% { transform: scaleY(0.5); }
    }
    .brow-l { transform: translateY(6px) rotate(-4deg); }
    .brow-r { transform: translateY(6px) rotate(4deg); }
    .face { transform: scale(0.75) translate(0, 5px); }
    .ant-l { animation: dzAntL 5.8s ease-in-out infinite; }
    .ant-r { animation: dzAntR 5.8s ease-in-out infinite; }
    @keyframes dzAntL { 0%, 8% { transform: rotate(-13deg); } 45% { transform: rotate(-18deg); } 60%, 100% { transform: rotate(-13deg); } }
    @keyframes dzAntR { 0%, 8% { transform: rotate(12deg); } 45% { transform: rotate(17deg); } 60%, 100% { transform: rotate(12deg); } }
    .arm-sm { transform: rotate(-6deg); }
    .arm-big { transform: rotate(2deg); }
`,
  inner: () => `
  ${SHADOW_BAR}
  <g class="pet">${bodyMarkup()}
  </g>`,
};

// 스르륵 잠들기: 깨어 있는 자세 → 수면 자세로 전환 (1회 재생, 끝 포즈 = sleeping 시작 포즈)
STATES['collapsing'] = {
  label: 'collapsing — 잠들기 전환',
  css: () => `
    .pet { animation: clSlump 1.6s ease-in-out both; }
    @keyframes clSlump {
      0% { transform: translateY(0) scale(1, 1); }
      55% { transform: translateY(12px) scale(1.012, 0.95); }
      100% { transform: translateY(0) scale(1, 1); }
    }
    .blink { animation: clEyes 1.6s ease-in both; }
    @keyframes clEyes { 0% { transform: scaleY(0.5); } 60%, 100% { transform: scaleY(0.08); } }
    .brow-l { animation: clBrowL 1.6s ease-in-out both; }
    .brow-r { animation: clBrowR 1.6s ease-in-out both; }
    @keyframes clBrowL { 0% { transform: translateY(6px) rotate(-4deg); } 100% { transform: translateY(9px) rotate(-6deg); } }
    @keyframes clBrowR { 0% { transform: translateY(6px) rotate(4deg); } 100% { transform: translateY(9px) rotate(6deg); } }
    .face { animation: clFace 1.6s ease-in-out both; transform-origin: ${PIVOT.face}; }
    @keyframes clFace { 0% { transform: scale(0.75) translate(0, 5px); } 100% { transform: scale(0.75) translate(0, 8px); } }
    .ant-l { animation: clAntL 1.6s ease-in-out both; }
    .ant-r { animation: clAntR 1.6s ease-in-out both; }
    @keyframes clAntL { 0% { transform: rotate(-13deg); } 100% { transform: rotate(-23deg); } }
    @keyframes clAntR { 0% { transform: rotate(12deg); } 100% { transform: rotate(21deg); } }
    .arm-sm { animation: clArmL 1.6s ease-in-out both; }
    @keyframes clArmL { 0% { transform: rotate(-6deg); } 100% { transform: rotate(-10deg); } }
    .arm-big { animation: clArmR 1.6s ease-in-out both; }
    @keyframes clArmR { 0% { transform: rotate(2deg); } 100% { transform: rotate(4deg); } }
`,
  inner: () => `
  ${SHADOW_BAR}
  <g class="pet">${bodyMarkup()}
  </g>`,
};

// 기지개: 수면 자세 → 쭉 스트레칭 → 눈 뜨고 복귀 (1회 재생)
STATES['waking'] = {
  label: 'waking — 기지개 (기상)',
  css: () => `
    .pet { animation: wkuStretch 2.6s ease-in-out both; }
    @keyframes wkuStretch {
      0%, 10% { transform: scale(1, 1) translateY(0); }
      42%, 58% { transform: scale(1.014, 1.05) translateY(-10px); }
      78%, 100% { transform: scale(1, 1) translateY(0); }
    }
    .blink { animation: wkuEyes 2.6s ease-in-out both; }
    @keyframes wkuEyes {
      0%, 12% { transform: scaleY(0.08); }
      40%, 55% { transform: scaleY(0.12); }
      66% { transform: scaleY(1); }
      74% { transform: scaleY(0.3); }
      82%, 100% { transform: scaleY(1); }
    }
    .brow-l { animation: wkuBrowL 2.6s ease-in-out both; }
    .brow-r { animation: wkuBrowR 2.6s ease-in-out both; }
    @keyframes wkuBrowL { 0%, 12% { transform: translateY(9px) rotate(-6deg); } 45%, 60% { transform: translateY(2px) rotate(-2deg); } 80%, 100% { transform: translateY(0) rotate(0deg); } }
    @keyframes wkuBrowR { 0%, 12% { transform: translateY(9px) rotate(6deg); } 45%, 60% { transform: translateY(2px) rotate(2deg); } 80%, 100% { transform: translateY(0) rotate(0deg); } }
    .face { animation: wkuFace 2.6s ease-in-out both; transform-origin: ${PIVOT.face}; }
    @keyframes wkuFace { 0%, 12% { transform: scale(0.75) translate(0, 8px); } 60%, 100% { transform: scale(0.75) translate(0, 0); } }
    .arm-sm { animation: wkuArmL 2.6s ease-in-out both; }
    @keyframes wkuArmL { 0%, 10% { transform: rotate(-10deg); } 42%, 58% { transform: rotate(-34deg); } 80%, 100% { transform: rotate(0deg); } }
    .arm-big { animation: wkuArmR 2.6s ease-in-out both; }
    @keyframes wkuArmR { 0%, 10% { transform: rotate(4deg); } 42%, 58% { transform: rotate(-5deg); } 80%, 100% { transform: rotate(0deg); } }
    .ant-l { animation: wkuAntL 2.6s ease-in-out both; }
    .ant-r { animation: wkuAntR 2.6s ease-in-out both; }
    @keyframes wkuAntL { 0%, 12% { transform: rotate(-23deg); } 55% { transform: rotate(-2deg); } 80%, 100% { transform: rotate(-6deg); } }
    @keyframes wkuAntR { 0%, 12% { transform: rotate(21deg); } 55% { transform: rotate(2deg); } 80%, 100% { transform: rotate(6deg); } }
`,
  inner: () => `
  ${SHADOW_BAR}
  <g class="pet">${bodyMarkup()}
  </g>`,
};

// ═══════════ working 티어 (동시 세션 수별) ═══════════

// 저글링(멀티태스킹): 모니터 2대를 번갈아 보기
STATES['juggling'] = {
  label: 'juggling — 모니터 2대 (동시 세션 2)',
  css: () => `
    .pet { animation: jgTurn 2.4s steps(1) infinite; }
    @keyframes jgTurn { 0%, 45% { transform: rotate(-1.5deg); } 50%, 95% { transform: rotate(1.5deg); } 100% { transform: rotate(-1.5deg); } }
    .face { animation: jgLook 2.4s steps(1) infinite; }
    @keyframes jgLook {
      0%, 45% { transform: scale(0.75) translate(-20px, 8px); }
      50%, 95% { transform: scale(0.75) translate(20px, 8px); }
      100% { transform: scale(0.75) translate(-20px, 8px); }
    }
    .brow-l { transform: rotate(10deg) scaleY(0.85); }
    .brow-r { transform: rotate(-10deg) scaleY(0.85); }
    .blink { animation: jgBlink 3.7s ease-in-out infinite; }
    @keyframes jgBlink { 0%, 92%, 100% { transform: scaleY(1); } 95% { transform: scaleY(0.42); } }
    .ant-l { animation: jgAntL 1.2s ease-in-out infinite alternate; }
    .ant-r { animation: jgAntR 1.2s ease-in-out 0.3s infinite alternate backwards; }
    @keyframes jgAntL { from { transform: rotate(-5deg); } to { transform: rotate(3deg); } }
    @keyframes jgAntR { from { transform: rotate(-3deg); } to { transform: rotate(5deg); } }
    .arm-sm { animation: jgArmL 1.2s ease-in-out infinite alternate; }
    @keyframes jgArmL { from { transform: rotate(-4deg); } to { transform: rotate(2deg); } }
    .caret { animation: jgCaret 0.7s steps(1) infinite; }
    @keyframes jgCaret { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }
${typingCss('jg', 3.2)}`,
  inner: () => `
  ${SHADOW_BAR}
  <g class="pet">${bodyMarkup()}
  </g>
  ${monitorPixel(-20, 540, 'mon-l')}
  ${monitorPixel(320, 540, 'mon-r')}`,
};

// 크런치 모드: 모니터 2대에 폭풍 타이핑 + 발 연타 + 커피
STATES['building'] = {
  label: 'building — 크런치 모드 (동시 세션 3+)',
  css: () => `
    .pet { animation: bdBounce 0.3s steps(2, jump-none) infinite; }
    @keyframes bdBounce { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-3px); } }
    .lg { animation: bdTap 0.3s steps(2, jump-none) infinite; }
    .lg2 { animation-delay: 0.075s; }
    .lg3 { animation-delay: 0.15s; }
    .lg4 { animation-delay: 0.225s; }
    @keyframes bdTap { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(9px); } }
    .face { animation: bdLook 1.2s steps(1) infinite; }
    @keyframes bdLook {
      0%, 45% { transform: scale(0.75) translate(-20px, 8px); }
      50%, 95% { transform: scale(0.75) translate(20px, 8px); }
      100% { transform: scale(0.75) translate(-20px, 8px); }
    }
    .pet { transform-origin: ${PIVOT.pet}; }
    .brow-l { transform: rotate(24deg) scaleY(0.75); }
    .brow-r { transform: rotate(-24deg) scaleY(0.75); }
    .ant-l { animation: bdAntL 0.45s ease-in-out infinite alternate; }
    .ant-r { animation: bdAntR 0.45s ease-in-out infinite alternate; }
    @keyframes bdAntL { from { transform: rotate(-10deg); } to { transform: rotate(8deg); } }
    @keyframes bdAntR { from { transform: rotate(8deg); } to { transform: rotate(-10deg); } }
    .arm-big { animation: bdArmR 0.6s ease-in-out infinite alternate; }
    @keyframes bdArmR { from { transform: rotate(-2deg); } to { transform: rotate(3deg); } }
    .claw-up { animation: bdSnap 0.6s steps(2, jump-none) infinite; }
    @keyframes bdSnap { 0%, 100% { transform: rotate(-10deg); } 50% { transform: rotate(-2deg); } }
    .cfill { transform-box: fill-box; transform-origin: 50% 100%; animation: bdSip 7s steps(6) infinite; }
    @keyframes bdSip { 0% { transform: scaleY(1); } 92%, 100% { transform: scaleY(0.08); } }
    .caret { animation: bdCaret 0.35s steps(1) infinite; }
    @keyframes bdCaret { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }
${typingCss('bd', 1.7)}${KEY_ANIM_CSS}`,
  inner: () => `
  ${SHADOW_BAR}
  ${keyboardMarkup()}
  <g class="pet">${bodyMarkup()}
  </g>
  ${monitorPixel(-20, 540, 'mon-l')}
  ${monitorPixel(320, 540, 'mon-r')}
  <g class="coffee">
    <g fill="#1e2235">
      <rect x="548" y="558" width="60" height="22"/>
      <rect x="538" y="570" width="80" height="30"/>
      <rect x="526" y="594" width="104" height="24"/>
      <rect x="536" y="614" width="84" height="94"/>
    </g>
    <rect x="554" y="564" width="48" height="12" fill="#f0f0f4"/>
    <rect x="544" y="576" width="68" height="20" fill="#f0f0f4"/>
    <rect x="532" y="600" width="92" height="12" fill="#e2e4ea"/>
    <rect x="542" y="620" width="72" height="82" fill="#eef0f4"/>
    <g class="cfill">
      <rect x="548" y="626" width="60" height="70" fill="#6b3a1e"/>
    </g>
    <g fill="#26262c">
      <rect x="572" y="524" width="14" height="76"/>
      <rect x="572" y="620" width="14" height="76"/>
    </g>
  </g>`,
};

// 지휘: 작은 팔이 지휘봉을 흔들고 픽셀 음표가 떠오름
STATES['conducting'] = {
  label: 'conducting — 지휘 (서브에이전트 2+)',
  css: () => `
    .pet { animation: cdSway 1.6s ease-in-out infinite alternate; }
    @keyframes cdSway { from { transform: rotate(-2deg); } to { transform: rotate(2deg); } }
    .arm-sm { animation: cdWave 0.8s ease-in-out infinite alternate; }
    @keyframes cdWave { from { transform: translateY(-28px) rotate(-26deg); } to { transform: translateY(-28px) rotate(8deg); } }
    .arm-big { animation: cdArmR 0.8s ease-in-out 0.4s infinite alternate backwards; }
    @keyframes cdArmR { from { transform: translateY(14px) rotate(-3deg); } to { transform: translateY(14px) rotate(3deg); } }
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
    armSmExtra: `<rect x="88" y="352" width="12" height="124" fill="#1e2235" transform="rotate(26 94 470)"/>`,
    extra: `
    <g class="note n1" fill="#1e2235">
      <rect x="56" y="276" width="18" height="18"/>
      <rect x="70" y="230" width="6" height="56"/>
    </g>
    <g class="note n2" fill="#1e2235">
      <rect x="112" y="236" width="18" height="18"/>
      <rect x="126" y="188" width="6" height="58"/>
      <rect x="132" y="188" width="16" height="8"/>
      <rect x="140" y="196" width="10" height="10"/>
    </g>
    <g class="note n3" fill="#1e2235">
      <rect x="16" y="212" width="16" height="16"/>
      <rect x="54" y="216" width="16" height="16"/>
      <rect x="28" y="164" width="6" height="56"/>
      <rect x="66" y="168" width="6" height="56"/>
      <rect x="28" y="164" width="44" height="8"/>
      <rect x="28" y="178" width="44" height="8"/>
    </g>` })}
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
  label: 'mini-peek — 미니: 빼꼼 (오른쪽 절반)',
  css: () => `
    .pet { animation: mpPeek 1.5s ease-in-out infinite; }
    @keyframes mpPeek { 0% { transform: translateX(-680px); } 35%, 75% { transform: translateX(-250px); } 100% { transform: translateX(-680px); } }
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
    ${heartPixel(300, 130, 1.5, 'heart h1', '#ff5b6a')}
    ${heartPixel(398, 62, 1.1, 'heart h2', '#ff8a9d')}` })}
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
  version: '1.6.0',
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
    yawning: ['clawad-yawning.svg'],
    dozing: ['clawad-dozing.svg'],
    collapsing: ['clawad-collapsing.svg'],
    sleeping: ['clawad-sleeping.svg'],
    waking: ['clawad-waking.svg'],
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
  sleepSequence: { mode: 'full' },
  timings: {
    minDisplay: { attention: 2700, error: 5000, notification: 2600, working: 1000, thinking: 1000 },
    autoReturn: { attention: 2700, error: 5200, notification: 2600 },
    yawnDuration: 3600,
    collapseDuration: 1600,
    wakeDuration: 2600,
    deepSleepTimeout: 600000,
    mouseIdleTimeout: 20000,
    mouseSleepTimeout: 60000,
  },
  hitBoxes: {
    default: { x: 60, y: 250, w: 380, h: 440 },
    sleeping: { x: 60, y: 380, w: 380, h: 310 },
  },
  sleepingHitboxFiles: [
    'clawad-yawning.svg',
    'clawad-dozing.svg',
    'clawad-collapsing.svg',
    'clawad-sleeping.svg',
    'clawad-waking.svg',
  ],
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

// ── 앱 스키마로 자체 검증 (선택적) ──
// spec/theme-schema.js는 clawd-on-desk(AGPL)에서 추출한 참조 사본으로, CLAW-114에서
// 저장소에서 제거될 예정. 없으면 검증만 건너뛰고 빌드는 정상 진행한다.
let schema = null;
try { schema = require('./spec/theme-schema.js'); } catch (e) { /* 사본 없음 */ }
if (schema) {
  const errors = schema.validateTheme(themeJson);
  if (errors.length) { console.error('VALIDATION ERRORS:', errors); process.exit(1); }
  const effective = schema.mergeDefaults(themeJson, 'clawad', false);
  const missing = schema.collectRequiredAssetFiles(effective).filter(f => !fs.existsSync(path.join(ASSETS, f)));
  if (missing.length) { console.error('MISSING ASSETS:', missing); process.exit(1); }
  console.log('schema validation: OK');
} else {
  // 최소 자체 점검: states가 가리키는 파일 존재 여부만 확인
  const referenced = new Set();
  for (const v of Object.values(themeJson.states)) (Array.isArray(v) ? v : v.files || []).forEach(f => referenced.add(f));
  if (themeJson.miniMode && themeJson.miniMode.states) {
    for (const v of Object.values(themeJson.miniMode.states)) v.forEach(f => referenced.add(f));
  }
  const missing = [...referenced].filter(f => !fs.existsSync(path.join(ASSETS, f)));
  if (missing.length) { console.error('MISSING ASSETS:', missing); process.exit(1); }
  console.log('schema validation: SKIPPED (spec/theme-schema.js 없음) — 파일 존재만 확인함');
}
