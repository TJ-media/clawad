'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  addPinballRankProgress,
  addPinballScore,
  addPinballSpecialScore,
  advancePinballMission,
  autoMoveToFoundation,
  awardPinballSkillShot,
  canPlaceOnTableau,
  collideBumper,
  createAnimationLoop,
  createPinballState,
  dealKlondike,
  drainPinballBall,
  drawStock,
  feedPinballBall,
  isKlondikeWon,
  launchPinball,
  moveCardToFoundation,
  moveCardToTableau,
  moveTableauRun,
  nudgePinball,
  pinballInputEnabled,
  pinballMissionName,
  pinballPickMission,
  pinballRankName,
  projectPinball,
  reflectBallFromSegment,
  selectPinballMission,
  startPinballMission,
  stepPinball,
  tableauCardOffsets,
} = require('../apps/user-web/games.js');

const WEB_ROOT = path.join(__dirname, '..', 'apps', 'user-web');
const HTML = fs.readFileSync(path.join(WEB_ROOT, 'index.html'), 'utf8');
const GAMES_JS = fs.readFileSync(path.join(WEB_ROOT, 'games.js'), 'utf8');
// 금지어 검사는 주석을 빼고 본다 — "localStorage도 쓰지 않는다"라고 적어 둔 주석이
// localStorage를 쓴 것으로 잡히면, 규칙을 설명한 벌로 검사가 깨진다.
const GAMES_CODE = GAMES_JS.replace(/\/\/.*$/gm, '');

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
  const bumper = { id: 'attack1', group: 'attack', x: 100, y: 100, radius: 18 };
  state.balls = [{ x: 100, y: 92, vx: 0, vy: 100, radius: 8, contacts: new Set() }];

  assert.ok(collideBumper(state, bumper));
  assert.strictEqual(state.score, 500, '무기 보강 전 공격 범퍼는 500점이다');
  assert.ok(state.balls[0].vy < 0);
  assert.ok(!collideBumper(state, bumper), '같은 접촉 중 점수를 반복해 주면 안 된다');
  assert.strictEqual(state.score, 500);
});

test('점수 배수·보너스·잭팟은 원작 표대로 얹힌다 (CLAW-255)', () => {
  const state = createPinballState();
  state.multiplier = 3; // score_multipliers[3] === 5
  assert.strictEqual(addPinballScore(state, 1000), 5000);
  assert.strictEqual(state.score, 5000);

  const collecting = createPinballState();
  collecting.bonusFlag = true;
  collecting.jackpotFlag = true;
  addPinballScore(collecting, 1000);
  assert.strictEqual(collecting.bonusScore, 11000, '보너스가 켜져 있으면 얻은 점수만큼 쌓인다');
  assert.strictEqual(collecting.jackpotScore, 21000);

  // 임무 완료·보너스 지급은 배수와 적립을 건드리지 않는다(원작 SpecialAddScore).
  const special = createPinballState();
  special.multiplier = 4;
  special.bonusFlag = true;
  assert.strictEqual(addPinballSpecialScore(special, 1000), 1000);
  assert.strictEqual(special.bonusScore, 10000, '적립분이 늘면 안 된다');
  assert.strictEqual(special.multiplier, 4, '배수는 그대로 남아야 한다');
});

test('임무는 계급과 맞힌 표적 조합으로 갈린다 (CLAW-255)', () => {
  // 원작 SelectMissionController의 분기표 그대로다.
  assert.deepStrictEqual([1, 2, 3, 4].map((level) => pinballPickMission(1, level)), [3, 4, 2, 5]);
  assert.deepStrictEqual([1, 2, 3, 4].map((level) => pinballPickMission(3, level)), [9, 11, 10, 16]);
  assert.deepStrictEqual([1, 2, 3, 4].map((level) => pinballPickMission(5, level)), [6, 8, 7, 15]);
  assert.deepStrictEqual([1, 2, 3, 4].map((level) => pinballPickMission(7, level)), [12, 13, 14, 17]);
  assert.deepStrictEqual([1, 2, 3, 4].map((level) => pinballPickMission(9, level)), [15, 16, 17, 18]);
  assert.strictEqual(pinballMissionName(2), '사격 연습');
  assert.strictEqual(pinballMissionName(18), '대혼란');
  assert.strictEqual(pinballRankName(1), '후보생');
  assert.strictEqual(pinballRankName(9), '제독');
});

test('임무는 표적으로 걸고 발사대로 시작해 단계를 밟아 끝난다 (CLAW-255)', () => {
  const state = createPinballState();
  feedPinballBall(state);
  assert.strictEqual(state.mission, 1, '구슬이 올라오면 임무 선택 상태가 된다');

  assert.strictEqual(selectPinballMission(state, 3), 2, '후보생이 표적 3을 맞히면 사격 연습이 걸린다');
  assert.match(state.missionText, /사격 연습 임무 시작/);

  assert.ok(startPinballMission(state));
  assert.strictEqual(state.mission, 2);
  assert.strictEqual(state.missionCount, 8, '공격 범퍼를 여덟 번 맞혀야 한다');

  for (let hit = 0; hit < 7; hit += 1) advancePinballMission(state, 'attackBumper');
  assert.strictEqual(state.missionCount, 1);
  assert.strictEqual(state.mission, 2, '아직 끝나면 안 된다');

  advancePinballMission(state, 'attackBumper');
  assert.strictEqual(state.mission, 1, '완료하면 다시 임무 선택으로 돌아간다');
  assert.ok(state.score >= 500000, '사격 연습은 50만 점이다');
  assert.strictEqual(state.rankProgress, 6, '완료하면 계급 진행이 6칸 오른다');
});

test('계급은 바깥 고리를 다 채워야 오른다 (CLAW-255)', () => {
  const state = createPinballState();
  assert.strictEqual(state.rank, 1);
  assert.ok(!addPinballRankProgress(state, 9));
  assert.strictEqual(state.rank, 1);
  assert.ok(addPinballRankProgress(state, 9), '고리를 다 채우면 승급한다');
  assert.strictEqual(state.rank, 2);
  assert.strictEqual(state.rankProgress, 0, '승급하면 고리가 비워진다');
  assert.match(state.missionText, /소위/);
});

test('연료가 떨어지면 진행 중인 임무가 취소된다 (CLAW-255)', () => {
  const state = createPinballState();
  feedPinballBall(state);
  selectPinballMission(state, 3);
  startPinballMission(state);
  assert.strictEqual(state.mission, 2);

  state.fuel = 1;
  for (let tick = 0; tick < 60 * 12; tick += 1) stepPinball(state, 1 / 60, {});
  assert.strictEqual(state.fuel, 0);
  assert.strictEqual(state.mission, 1, '연료가 0이 되면 임무가 취소된다');
});

test('쏘기 기술 점수는 슈트를 얼마나 돌았는지로 갈린다 (CLAW-255)', () => {
  // 원작 control_oneway4_score1 그대로 — 가운데(관문 3)가 가장 크다.
  const scores = [1, 2, 3, 4, 5, 6].map((gates) => {
    const state = createPinballState();
    feedPinballBall(state);
    state.skillShot = gates;
    state.skillShotArmed = true;
    const before = state.score;
    awardPinballSkillShot(state);
    return state.score - before;
  });
  assert.deepStrictEqual(scores, [15000, 30000, 75000, 30000, 15000, 7500]);
});

test('구슬이 빠지면 추락 보너스를 주고 세 번째에 게임이 끝난다 (CLAW-255)', () => {
  const state = createPinballState();
  for (let ballNumber = 1; ballNumber <= 3; ballNumber += 1) {
    assert.ok(launchPinball(state, 0.7), `${ballNumber}번째 구슬은 쏠 수 있어야 한다`);
    assert.strictEqual(state.ballsLeft, 4 - ballNumber);
    drainPinballBall(state, state.balls[0]);
  }
  assert.ok(state.gameOver);
  assert.strictEqual(state.ballsLeft, 0);
  assert.ok(state.score > 0, '마지막 구슬에도 추락 보너스가 붙는다');
  assert.ok(!launchPinball(state, 1), '끝난 판에서 네 번째 구슬을 만들면 안 된다');
});

test('보너스 구슬이 있으면 남은 구슬을 깎지 않는다 (CLAW-255)', () => {
  const state = createPinballState();
  launchPinball(state, 0.7);
  state.extraBalls = 1;
  drainPinballBall(state, state.balls[0]);
  assert.strictEqual(state.ballsLeft, 3, '보너스 구슬을 먼저 쓴다');
  assert.strictEqual(state.extraBalls, 0);
  assert.strictEqual(state.balls.length, 1, '새 구슬이 바로 올라온다');
});

test('판을 네 번 흔들면 반칙이고 플리퍼가 죽는다 (CLAW-255)', () => {
  const state = createPinballState();
  launchPinball(state, 0.7);
  for (let count = 0; count < 3; count += 1) assert.ok(nudgePinball(state, -1));
  assert.ok(!state.tiltLock, '세 번까지는 경고만 한다');
  nudgePinball(state, -1);
  assert.ok(state.tiltLock);
  assert.strictEqual(state.missionText, '반칙!');

  const before = { ...state.flippers?.flipL };
  stepPinball(state, 1 / 60, { left: true, right: true });
  assert.ok(!state.flippers.flipL.omega || Math.abs(state.flippers.flipL.omega) < 1e-6
    || state.flippers.flipL.angle === before.angle, '반칙 뒤에는 플리퍼가 올라가지 않는다');
});

test('판은 원작 투영으로 아래가 위보다 넓게 그려진다 (CLAW-255)', () => {
  const topLeft = projectPinball(0, 0);
  const topRight = projectPinball(380, 0);
  const bottomLeft = projectPinball(0, 560);
  const bottomRight = projectPinball(380, 560);
  const topWidth = topRight.x - topLeft.x;
  const bottomWidth = bottomRight.x - bottomLeft.x;
  assert.ok(bottomWidth > topWidth, '가까운 아래쪽이 더 넓어야 한다');
  assert.ok(Math.abs(bottomWidth / topWidth - 1.237) < 0.02, '원작 사다리꼴 비율(약 1.24)과 같아야 한다');
  assert.ok(bottomRight.y > topRight.y, '판 좌표 y가 커지면 화면 아래로 가야 한다');
  assert.ok(bottomLeft.scale > topLeft.scale, '가까울수록 크게 그려야 한다');
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
    HTML.indexOf("const GAME_IDS = new Set(['mine', 'pinball', 'solitaire'])"),
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
  assert.doesNotMatch(GAMES_CODE, /\bfetch\s*\(|XMLHttpRequest|WebSocket/);
  assert.doesNotMatch(GAMES_CODE, /localStorage|sessionStorage|\/v1\/|reward|ledger|balance/i);
});
