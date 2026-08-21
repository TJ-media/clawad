'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  autoMoveToFoundation,
  canPlaceOnTableau,
  collideBumper,
  createAnimationLoop,
  createPinballState,
  dealKlondike,
  drawStock,
  isKlondikeWon,
  launchPinball,
  moveCardToFoundation,
  moveCardToTableau,
  moveTableauRun,
  pinballInputEnabled,
  reflectBallFromSegment,
  stepPinball,
  tableauCardOffsets,
} = require('../apps/user-web/games.js');

const WEB_ROOT = path.join(__dirname, '..', 'apps', 'user-web');
const HTML = fs.readFileSync(path.join(WEB_ROOT, 'index.html'), 'utf8');
const GAMES_JS = fs.readFileSync(path.join(WEB_ROOT, 'games.js'), 'utf8');

function card(suit, rank, faceUp = true) {
  return { id: `${suit}-${rank}`, suit, rank, faceUp };
}

test('클론다이크는 7열을 1~7장으로 나누고 맨 위 카드만 공개한다 (CLAW-255)', () => {
  const state = dealKlondike(() => 0.25);

  assert.deepStrictEqual(state.tableau.map((column) => column.length), [1, 2, 3, 4, 5, 6, 7]);
  assert.strictEqual(state.stock.length, 24);
  assert.strictEqual(state.waste.length, 0);
  assert.deepStrictEqual(state.foundations.map((pile) => pile.length), [0, 0, 0, 0]);
  for (const column of state.tableau) {
    assert.ok(column.at(-1).faceUp, '각 열의 맨 위 카드는 공개돼야 한다');
    assert.ok(column.slice(0, -1).every((card) => !card.faceUp), '덮인 카드는 공개되면 안 된다');
  }
});

test('테이블 이동은 색을 번갈아 한 단계씩 내려갈 때만 허용한다 (CLAW-255)', () => {
  assert.ok(canPlaceOnTableau(card('hearts', 8), card('clubs', 9)));
  assert.ok(canPlaceOnTableau(card('spades', 13), null), '빈 열에는 킹만 놓을 수 있어야 한다');
  assert.ok(!canPlaceOnTableau(card('diamonds', 8), card('hearts', 9)), '같은 색은 거절해야 한다');
  assert.ok(!canPlaceOnTableau(card('clubs', 7), card('hearts', 9)), '두 단계 차이는 거절해야 한다');
  assert.ok(!canPlaceOnTableau(card('clubs', 12), null), '빈 열의 퀸은 거절해야 한다');
});

test('유효한 카드 묶음만 옮기고 드러난 카드를 뒤집는다 (CLAW-255)', () => {
  const state = {
    tableau: [
      [card('spades', 10, false), card('hearts', 9), card('clubs', 8)],
      [card('diamonds', 10)],
      [card('clubs', 10)],
    ],
    moves: 0,
  };

  assert.ok(moveTableauRun(state, 0, 1, 2));
  assert.deepStrictEqual(state.tableau[2].map((item) => item.rank), [10, 9, 8]);
  assert.ok(state.tableau[0][0].faceUp, '묶음 아래에 있던 카드를 공개해야 한다');
  assert.strictEqual(state.moves, 1);

  const snapshot = JSON.stringify(state);
  assert.ok(!moveTableauRun(state, 2, 1, 1), '빨간 9를 빨간 10 위로 옮기면 안 된다');
  assert.strictEqual(JSON.stringify(state), snapshot, '거절된 이동은 상태를 바꾸면 안 된다');
});

test('스톡을 한 장씩 넘기고 다 쓰면 웨이스트를 다시 덮는다 (CLAW-255)', () => {
  const state = {
    stock: [card('spades', 1, false), card('hearts', 2, false)],
    waste: [],
    moves: 0,
  };

  assert.strictEqual(drawStock(state).id, 'hearts-2');
  assert.ok(state.waste.at(-1).faceUp);
  assert.strictEqual(drawStock(state).id, 'spades-1');
  assert.strictEqual(state.stock.length, 0);
  assert.strictEqual(drawStock(state), null, '재순환 클릭은 카드를 바로 공개하지 않아야 한다');
  assert.deepStrictEqual(state.stock.map((item) => item.id), ['spades-1', 'hearts-2']);
  assert.ok(state.stock.every((item) => !item.faceUp));
  assert.strictEqual(state.waste.length, 0);
});

test('파운데이션은 같은 무늬를 에이스부터 순서대로 받는다 (CLAW-255)', () => {
  const state = {
    waste: [card('hearts', 2)],
    foundations: [[card('hearts', 1)], [], [], []],
    tableau: [[card('clubs', 1)], [card('spades', 3)]],
    moves: 0,
  };

  assert.ok(moveCardToFoundation(state, { zone: 'waste' }, 0));
  assert.deepStrictEqual(state.foundations[0].map((item) => item.rank), [1, 2]);
  assert.ok(!moveCardToFoundation(state, { zone: 'tableau', column: 1 }, 1), '3부터 시작하면 안 된다');
  assert.ok(moveCardToFoundation(state, { zone: 'tableau', column: 0 }, 1));
  assert.strictEqual(state.foundations[1][0].id, 'clubs-1');
});

test('웨이스트·파운데이션 카드를 유효한 테이블 열로 되돌릴 수 있다 (CLAW-255)', () => {
  const state = {
    waste: [card('hearts', 9)],
    foundations: [[card('clubs', 1)], [], [], []],
    tableau: [[card('clubs', 10)], [card('diamonds', 2)]],
    moves: 0,
  };

  assert.ok(moveCardToTableau(state, { zone: 'waste' }, 0));
  assert.strictEqual(state.tableau[0].at(-1).id, 'hearts-9');
  assert.ok(moveCardToTableau(state, { zone: 'foundation', column: 0 }, 1));
  assert.strictEqual(state.tableau[1].at(-1).id, 'clubs-1');
});

test('자동 올리기는 무늬가 맞는 파운데이션만 골라 이동한다 (CLAW-255)', () => {
  const state = {
    waste: [card('hearts', 2)],
    foundations: [[], [card('hearts', 1)], [], []],
    tableau: [],
    moves: 0,
  };

  assert.ok(autoMoveToFoundation(state, { zone: 'waste' }));
  assert.deepStrictEqual(state.foundations[1].map((item) => item.id), ['hearts-1', 'hearts-2']);
});

test('이미 파운데이션에 오른 카드는 자동 올리기로 다른 칸에 옮기지 않는다 (CLAW-255)', () => {
  const state = {
    waste: [],
    foundations: [[card('hearts', 1)], [], [], []],
    tableau: [],
    moves: 0,
  };

  assert.ok(!autoMoveToFoundation(state, { zone: 'foundation', column: 0 }));
  assert.strictEqual(state.foundations[0][0].id, 'hearts-1');
  assert.strictEqual(state.foundations[1].length, 0);
});

test('네 파운데이션에 52장이 모여야 승리다 (CLAW-255)', () => {
  assert.ok(isKlondikeWon({ foundations: Array.from({ length: 4 }, () => Array(13).fill({})) }));
  assert.ok(!isKlondikeWon({ foundations: [Array(13).fill({}), Array(13).fill({}), [], []] }));
});

test('공은 선분에 닿아 다가가던 속도만 반사한다 (CLAW-255)', () => {
  const ball = { x: 50, y: 95, vx: 20, vy: 80, radius: 8 };

  assert.ok(reflectBallFromSegment(ball, { ax: 0, ay: 100, bx: 100, by: 100 }, 1));
  assert.strictEqual(ball.vx, 20);
  assert.ok(ball.vy < 0, '아래로 가던 공이 위로 튀어야 한다');
  assert.ok(ball.y <= 92, '공이 선분 바깥으로 밀려나야 한다');

  const departing = { x: 50, y: 92, vx: 0, vy: -40, radius: 8 };
  assert.ok(!reflectBallFromSegment(departing, { ax: 0, ay: 100, bx: 100, by: 100 }, 1));
  assert.strictEqual(departing.vy, -40, '멀어지는 공을 다시 뒤집으면 안 된다');
});

test('범퍼는 진입할 때 한 번만 점수를 주고 공을 튕긴다 (CLAW-255)', () => {
  const state = createPinballState();
  state.ball = { x: 100, y: 92, vx: 0, vy: 100, radius: 8, contacts: new Set() };
  const bumper = { id: 'top', x: 100, y: 100, radius: 18, points: 250 };

  assert.ok(collideBumper(state, bumper));
  assert.strictEqual(state.score, 250);
  assert.ok(state.ball.vy < 0);
  assert.ok(!collideBumper(state, bumper), '같은 접촉 중 점수를 반복해 주면 안 된다');
  assert.strictEqual(state.score, 250);
});

test('핀볼은 세 공을 차례로 발사하고 마지막 드레인에서 종료한다 (CLAW-255)', () => {
  const state = createPinballState();

  for (let ballNumber = 1; ballNumber <= 3; ballNumber += 1) {
    assert.ok(launchPinball(state, 0.7));
    assert.strictEqual(state.ballsLeft, 3 - ballNumber);
    state.ball.y = state.height + state.ball.radius + 1;
    stepPinball(state, 1 / 60, { left: false, right: false });
    assert.strictEqual(state.ball, null);
  }
  assert.ok(state.gameOver);
  assert.ok(!launchPinball(state, 1), '종료 뒤 네 번째 공을 만들면 안 된다');
});

test('핀볼판의 발사 레일과 하단 가이드는 공을 경기장 안으로 되돌린다 (CLAW-255)', () => {
  const railState = createPinballState();
  railState.ball = { x: 497, y: 300, vx: -120, vy: 0, radius: 8, contacts: new Set() };
  stepPinball(railState, 1 / 120, { left: false, right: false });
  assert.ok(railState.ball.vx > 0, '발사 레일을 통과하면 안 된다');

  const guideState = createPinballState();
  guideState.ball = { x: 100, y: 470, vx: 40, vy: 180, radius: 8, contacts: new Set() };
  stepPinball(guideState, 1 / 120, { left: false, right: false });
  assert.ok(guideState.ball.vy < 180, '하단 가이드가 낙하 속도를 위쪽으로 돌려야 한다');
});

test('애니메이션 루프는 중지 뒤 예약된 프레임이 와도 진행하지 않는다 (CLAW-255)', () => {
  let queued = null;
  const elapsed = [];
  const loop = createAnimationLoop(
    (seconds) => elapsed.push(seconds),
    (callback) => { queued = callback; return 7; },
    () => {},
  );

  loop.start();
  queued(100);
  queued(116);
  assert.deepStrictEqual(elapsed, [0.016]);
  queued(10116);
  assert.strictEqual(elapsed.at(-1), 0.05, '장시간 멈춘 탭의 프레임 간격은 50ms로 제한해야 한다');
  const staleFrame = queued;
  loop.stop();
  staleFrame(132);
  assert.deepStrictEqual(elapsed, [0.016, 0.05]);
  assert.ok(!loop.isRunning());
});

test('카드 열의 세로 위치는 앞선 카드 간격을 누적해 계산한다 (CLAW-255)', () => {
  const column = [
    card('spades', 10, false),
    card('hearts', 9, false),
    card('clubs', 8),
    card('diamonds', 7),
  ];
  assert.deepStrictEqual(tableauCardOffsets(column), [0, 16, 32, 59]);
});

test('핀볼 키는 활성 창이 보일 때만 가로챈다 (CLAW-255)', () => {
  assert.ok(pinballInputEnabled({ paused: false, hidden: false, minimized: false, active: true }));
  assert.ok(!pinballInputEnabled({ paused: false, hidden: false, minimized: false, active: false }));
  assert.ok(!pinballInputEnabled({ paused: false, hidden: false, minimized: true, active: true }));
  assert.ok(!pinballInputEnabled({ paused: true, hidden: false, minimized: false, active: true }));
});

test('핀볼과 카드놀이는 링크·해시 없는 독립 창으로 지연 로드된다 (CLAW-255)', () => {
  const table = HTML.slice(HTML.indexOf('const WINDOWS = {'), HTML.indexOf('// 로그인 여부.'));
  assert.match(table, /pinball: \{ title: '[^']+', icon: 'pinball' \}/);
  assert.match(table, /solitaire: \{ title: '[^']+', icon: 'solitaire' \}/);
  assert.doesNotMatch(table, /pinball: \{[^}]+(?:href|doc):/);
  assert.doesNotMatch(table, /solitaire: \{[^}]+(?:href|doc):/);
  assert.match(HTML, /script\.src = '\.\/games\.js'/, '게임 코드는 처음 열 때 받아야 한다');
  assert.doesNotMatch(HTML, /<script src="\.\/games\.js"/, '첫 화면에서 게임 코드를 받으면 안 된다');
  const routes = HTML.match(/const HASH_ROUTES = \{([^}]+)\}/)?.[1] || '';
  assert.doesNotMatch(routes, /pinball|solitaire/);
});

test('게임 창은 열기·최소화·복원·닫기에 맞춰 실행 상태를 바꾼다 (CLAW-255)', () => {
  const open = HTML.slice(HTML.indexOf('function openWindow('), HTML.indexOf('function readGeometry'));
  const focus = HTML.slice(HTML.indexOf('function focusWindow('), HTML.indexOf('function minimizeWindow'));
  const minimize = HTML.slice(HTML.indexOf('function minimizeWindow('), HTML.indexOf('function setMaximizeButton'));
  const close = HTML.slice(HTML.indexOf('function closeWindow('), HTML.indexOf('function closeAllWindows'));
  const closeAll = HTML.slice(HTML.indexOf('function closeAllWindows('), HTML.indexOf('function renderTaskbar'));
  assert.match(open, /prepareGame\(id\)/);
  assert.match(focus, /resumeGame\(t\)/);
  assert.match(minimize, /pauseGame\(id\)/);
  assert.match(close, /disposeGame\(id\)/);
  assert.match(closeAll, /disposeGame\(id\)/);
  assert.match(HTML, /generation:\s*nextGameGeneration\(id\)/, '열 때마다 새 게임 세대를 발급해야 한다');
  assert.match(HTML, /games\.mount\(id,[^;]+ready\.generation\)/s, 'mount에 창 세대를 전달해야 한다');
  assert.match(HTML, /games\.destroy\(id,\s*ready\.generation\)/, '닫힌 세대만 폐기해야 한다');
});

test('게임 스크립트 로딩 중 닫고 다시 열어도 새 창 세대만 마운트한다 (CLAW-255)', async () => {
  const lifecycleSource = HTML.slice(
    HTML.indexOf("const GAME_IDS = new Set(['pinball', 'solitaire'])"),
    HTML.indexOf('// 설치 안내·법률 문서는 별도 정적 페이지다.'),
  );
  let pendingScript = null;
  const windowStub = {};
  const documentStub = {
    createElement: () => ({}),
    head: { appendChild: (script) => { pendingScript = script; } },
  };
  const openWindows = ['solitaire'];
  const fakeWindow = { classList: { contains: () => false }, querySelector: () => ({}) };
  const mountGenerations = [];
  const destroyGenerations = [];
  const games = {
    mount: (id, root, generation) => mountGenerations.push(generation),
    destroy: (id, generation) => destroyGenerations.push(generation),
    resume: () => {},
    pause: () => {},
  };
  const createLifecycle = new Function(
    'window', 'document', 'openWindows', 'winEl', 'showToast',
    `${lifecycleSource}; return { prepareGame, disposeGame };`,
  );
  const lifecycle = createLifecycle(windowStub, documentStub, openWindows, () => fakeWindow, () => {});

  lifecycle.prepareGame('solitaire');
  openWindows.splice(0, 1);
  lifecycle.disposeGame('solitaire');
  openWindows.push('solitaire');
  lifecycle.prepareGame('solitaire');
  windowStub.ClawadGames = games;
  pendingScript.onload();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepStrictEqual(mountGenerations, [2]);
  assert.deepStrictEqual(destroyGenerations, [1]);
});

test('핀볼은 캔버스와 키보드 안내를, 카드놀이는 7열 보드를 제공한다 (CLAW-255)', () => {
  const pinball = HTML.slice(HTML.indexOf('id="pinballView"'), HTML.indexOf('</section>', HTML.indexOf('id="pinballView"')));
  const solitaire = HTML.slice(HTML.indexOf('id="solitaireView"'), HTML.indexOf('</section>', HTML.indexOf('id="solitaireView"')));
  assert.match(pinball, /<canvas[^>]+aria-label="[^"]+핀볼/);
  for (const key of ['←', '→', 'Z', 'M', 'Space']) assert.ok(pinball.includes(key), `${key} 조작 안내가 필요하다`);
  assert.match(pinball, /키보드가 필요합니다/);
  assert.match(solitaire, /data-game-root="solitaire"/);
  assert.match(GAMES_JS, /requestAnimationFrame/);
  assert.match(GAMES_JS, /prefers-reduced-motion: reduce/);
  assert.match(GAMES_JS, /\.solitaire-top\s*>\s*div\s*\{[^}]*position:relative[^}]*width:72px[^}]*height:96px/s,
    '상단 카드 셀은 절대 배치 카드의 위치 기준과 크기를 가져야 한다');
  assert.match(GAMES_JS, /<button type="button" class="solitaire-slot solitaire-empty-column"[^>]+data-target-zone="tableau"/,
    '빈 테이블 열은 키보드로 선택할 수 있는 버튼이어야 한다');
  assert.doesNotMatch(solitaire, /role="application"/, '완전한 application 키 모델이 없으므로 application role을 쓰면 안 된다');
  assert.match(GAMES_JS, /setPointerCapture\(event\.pointerId\)/, '플런저 버튼 밖에서 포인터를 떼도 종료 이벤트를 받아야 한다');
});

test('게임은 네트워크·리워드·영구 저장소와 분리된다 (CLAW-255)', () => {
  assert.doesNotMatch(GAMES_JS, /\bfetch\s*\(|XMLHttpRequest|WebSocket/);
  assert.doesNotMatch(GAMES_JS, /localStorage|sessionStorage|\/v1\/|reward|ledger|balance/i);
});
