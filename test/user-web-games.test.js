'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  addPinballRankProgress,
  addPinballScore,
  addPinballSpecialScore,
  applyPinballKeyControl,
  advancePinballMission,
  autoMoveToFoundation,
  awardPinballSkillShot,
  canPlaceOnTableau,
  cardMarkup,
  collideBumper,
  createSolitairePointerDrag,
  createAnimationLoop,
  createPinballState,
  dealKlondike,
  destroy,
  drainPinballBall,
  drawStock,
  feedPinballBall,
  isKlondikeWon,
  launchPinball,
  moveCardToFoundation,
  moveCardToTableau,
  moveTableauRun,
  mount,
  mountSpider,
  nudgePinball,
  pinballInputEnabled,
  pinballMissionName,
  pinballPickMission,
  pinballRankName,
  projectPinball,
  pause,
  requestSolitaireDeal,
  reflectBallFromSegment,
  resume,
  solitaireDragGhostTransform,
  showSpiderHint,
  spiderCardOffsets,
  spiderInputEnabled,
  spiderMarkup,
  selectPinballMission,
  startPinballMission,
  stepPinball,
  stopSolitaireSolver,
  tableauCardOffsets,
  updateSolitairePointerDrag,
} = require('../apps/user-web/games.js');
const spiderEngine = require('../apps/user-web/spider-solitaire.js');

const WEB_ROOT = path.join(__dirname, '..', 'apps', 'user-web');
const HTML = fs.readFileSync(path.join(WEB_ROOT, 'index.html'), 'utf8');
const GAMES_JS = fs.readFileSync(path.join(WEB_ROOT, 'games.js'), 'utf8');
// 금지어 검사는 주석을 빼고 본다 — "localStorage도 쓰지 않는다"라고 적어 둔 주석이
// localStorage를 쓴 것으로 잡히면, 규칙을 설명한 벌로 검사가 깨진다.
const GAMES_CODE = GAMES_JS.replace(/\/\/.*$/gm, '');

function card(suit, rank, faceUp = true) {
  return { id: `${suit}-${rank}`, suit, rank, faceUp };
}

function backCard() {
  return card('spades', 1, false);
}

function spiderState(overrides = {}) {
  return {
    difficulty: 1,
    tableau: Array.from({ length: 10 }, () => []),
    stock: [],
    completed: [],
    score: 500,
    moves: 0,
    history: [],
    won: false,
    ...overrides,
  };
}

function classListFixture(initial = []) {
  const values = new Set(initial);
  return {
    add: (...names) => names.forEach((name) => values.add(name)),
    remove: (...names) => names.forEach((name) => values.delete(name)),
    contains: (name) => values.has(name),
  };
}

function spiderDomFixture(engine = spiderEngine) {
  const rootListeners = new Map();
  const sectionListeners = new Map();
  const viewListeners = new Map();
  const rootStyles = new Map();
  const resizeObservers = [];
  let rootMarkup = '';
  let renderCount = 0;
  const difficultyButtons = [1, 2, 4].map((difficulty) => {
    const attributes = new Map([['aria-checked', 'false']]);
    return {
      dataset: { spiderDifficulty: String(difficulty) },
      getAttribute: (name) => attributes.get(name),
      setAttribute: (name, value) => attributes.set(name, value),
    };
  });
  const gameMenuAttributes = new Map([['aria-expanded', 'false']]);
  const gameMenuButton = {
    getAttribute: (name) => gameMenuAttributes.get(name),
    setAttribute: (name, value) => gameMenuAttributes.set(name, value),
  };
  const gameMenuPopup = { hidden: true };
  const section = {
    classList: classListFixture(['win-active']),
    addEventListener: (name, listener) => sectionListeners.set(name, listener),
    removeEventListener: (name, listener) => {
      if (sectionListeners.get(name) === listener) sectionListeners.delete(name);
    },
    querySelectorAll: (selector) => selector === '[data-spider-difficulty]' ? difficultyButtons : [],
    querySelector: (selector) => ({
      '[data-spider-menu-trigger]': gameMenuButton,
      '[data-spider-game-menu]': gameMenuPopup,
    })[selector] || null,
  };
  const view = {
    ClawadSpider: engine,
    addEventListener: (name, listener) => viewListeners.set(name, listener),
    removeEventListener: (name, listener) => {
      if (viewListeners.get(name) === listener) viewListeners.delete(name);
    },
    setTimeout: (callback) => { callback(); return 1; },
    ResizeObserver: class ResizeObserverFixture {
      constructor(callback) {
        this.callback = callback;
        this.disconnected = false;
        resizeObservers.push(this);
      }

      observe(target) {
        this.target = target;
      }

      disconnect() {
        this.disconnected = true;
      }

      trigger() {
        this.callback([{ target: this.target }]);
      }
    },
  };
  const document = {
    defaultView: view,
    elementFromPoint: () => null,
    getElementById: () => null,
    createElement: () => ({}),
    head: { appendChild: () => {} },
  };
  const root = {
    ownerDocument: document,
    clientWidth: 820,
    clientHeight: 490,
    get innerHTML() { return rootMarkup; },
    set innerHTML(value) { rootMarkup = value; renderCount += 1; },
    style: { setProperty: (name, value) => rootStyles.set(name, value) },
    addEventListener: (name, listener) => rootListeners.set(name, listener),
    removeEventListener: (name, listener) => {
      if (rootListeners.get(name) === listener) rootListeners.delete(name);
    },
    closest: () => section,
    contains: () => true,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  return {
    root, section, view, document, difficultyButtons, gameMenuButton, gameMenuPopup,
    rootStyles, resizeObservers, rootListeners, sectionListeners, viewListeners,
    renderCount: () => renderCount,
  };
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

test('공개 카드는 원화의 기본 좌상단 표기만 사용한다 (CLAW-278)', () => {
  const markup = cardMarkup(
    card('spades', 10),
    { zone: 'tableau', column: 0, index: 2 },
    32,
    null,
  );

  assert.match(markup, /class="solitaire-artwork"/,
    '공개된 카드는 CC0 영미식 카드 원화를 사용해야 한다');
  assert.doesNotMatch(markup, /solitaire-corner|>10♠</,
    '카드 원화 위에 별도의 숫자·문양을 덧씌우면 안 된다');
});

test('필드의 뒤집힌 카드는 비활성이고 왼쪽 위 덱은 계속 누를 수 있다 (CLAW-278)', () => {
  const tableau = cardMarkup(
    card('spades', 10, false),
    { zone: 'tableau', column: 2, index: 0 },
    0,
    null,
  );
  const stock = cardMarkup(
    card('hearts', 4, false),
    { zone: 'stock', index: 20 },
    0,
    null,
  );

  assert.match(tableau, / disabled(?: |>|$)/,
    '테이블에서 덮인 카드는 포인터와 키보드로 선택할 수 없어야 한다');
  assert.doesNotMatch(stock, / disabled(?: |>|$)/,
    '왼쪽 위 덱은 덮여 있어도 새 카드를 뽑을 수 있어야 한다');
  assert.doesNotMatch(tableau + stock, /draggable=/,
    '브라우저 기본 드래그를 켜면 운영체제의 복사 안내가 다시 나타난다');
});

test('카드 포인터 조작은 이동 임계값을 넘은 같은 포인터만 드래그로 판정한다 (CLAW-278)', () => {
  const source = { zone: 'tableau', column: 3, index: 2 };
  const drag = createSolitairePointerDrag(source, { pointerId: 7, clientX: 100, clientY: 80 });

  assert.strictEqual(updateSolitairePointerDrag(drag, { pointerId: 8, clientX: 140, clientY: 80 }), false,
    '다른 포인터 움직임을 현재 카드 드래그로 받으면 안 된다');
  assert.strictEqual(updateSolitairePointerDrag(drag, { pointerId: 7, clientX: 103, clientY: 83 }), false,
    '작은 손떨림은 기존 클릭 선택으로 남아야 한다');
  assert.strictEqual(updateSolitairePointerDrag(drag, { pointerId: 7, clientX: 106, clientY: 80 }), true,
    '임계값을 넘은 이동은 커스텀 드래그를 시작해야 한다');
  assert.deepStrictEqual({ x: drag.clientX, y: drag.clientY, active: drag.active },
    { x: 106, y: 80, active: true });
});

test('드래그 카드는 처음 잡은 지점을 커서 아래에 유지한다 (CLAW-278)', () => {
  const drag = createSolitairePointerDrag(
    { zone: 'tableau', column: 3, index: 2 },
    { pointerId: 7, clientX: 132, clientY: 98 },
    { left: 100, top: 80 },
  );
  assert.strictEqual(solitaireDragGhostTransform(drag), 'translate3d(100px,80px,0)');
});

test('스파이더 렌더러는 10개 열과 난이도·점수·이동·완성·재고 상태를 보여 준다 (CLAW-279)', () => {
  const state = spiderEngine.dealSpider(2, () => 0.25);
  const markup = spiderMarkup(state, null, null, '');

  assert.strictEqual((markup.match(/class="spider-column"/g) || []).length, 10);
  assert.match(markup, /난이도:\s*두 무늬/);
  assert.match(markup, /점수:\s*500/);
  assert.match(markup, /이동:\s*0/);
  assert.match(markup, /완성:\s*0\/8/);
  assert.match(markup, /재고:\s*50/);
  assert.match(markup, /class="solitaire-card face-down"[^>]+disabled/,
    '필드의 뒤집힌 카드는 조작할 수 없어야 한다');
});

test('XP 스파이더 하단은 완료 묶음·점수판·5개 재고를 좌중우로 배치한다 (CLAW-279)', () => {
  const state = spiderState({ completed: ['spades'], stock: Array(50).fill(backCard()) });
  const markup = spiderMarkup(state, null, null, '');

  assert.match(markup, /class="spider-tableau"/);
  assert.match(markup, /class="spider-foundations"/);
  assert.match(markup, /class="spider-score-panel"[^>]*>\s*점수:/);
  assert.match(markup, /완성:\s*1\/8/);
  assert.strictEqual((markup.match(/class="spider-stock-packet"/g) || []).length, 5);
  assert.strictEqual((markup.match(/role="listitem"/g) || []).length, 1,
    '완료하지 않은 빈 슬롯은 일반 게임판에 보이면 안 된다');
  assert.match(markup, /완료 묶음 1: 스페이드[^]*aria-label="스페이드 K"[^]*class="solitaire-artwork"/,
    '완료 묶음은 기존 CC0 카드 렌더러의 킹 원화를 사용해야 한다');
});

test('XP 스파이더 게임판은 축척해도 하단 좌중우 기준점과 가로 무스크롤을 유지한다 (CLAW-279)', () => {
  assert.match(GAMES_JS, /--spider-board-scale/);
  assert.match(GAMES_JS, /\.win-game\s*>\s*\.spider-shell\s*\{[^}]*overflow-x:\s*hidden/,
    '공통 game-root overflow보다 구체적인 규칙으로 가로 스크롤을 막아야 한다');
  assert.match(GAMES_JS, /\.spider-foundations\s*\{[^}]*left:\s*0/);
  assert.match(GAMES_JS, /\.spider-score-panel\s*\{[^}]*left:\s*50%/);
  assert.match(GAMES_JS, /\.spider-stock-packets\s*\{[^}]*right:\s*0/);
});

test('스파이더 창 너비가 바뀌면 게임판 축척을 다시 계산한다 (CLAW-279)', () => {
  const dom = spiderDomFixture(spiderEngine);
  mountSpider(dom.root);
  assert.strictEqual(dom.rootStyles.get('--spider-board-scale'), '1');
  const initialRenderCount = dom.renderCount();

  dom.root.clientWidth = 500;
  assert.strictEqual(dom.resizeObservers.length, 1, '게임판 크기를 감시해야 한다');
  dom.resizeObservers[0].trigger();

  const compactScale = Number(dom.rootStyles.get('--spider-board-scale'));
  assert.ok(compactScale < 1 && compactScale >= 0.34);
  assert.strictEqual(dom.renderCount(), initialRenderCount,
    '너비만 바뀌면 카드 DOM을 다시 만들지 않고 CSS 축척만 갱신해야 한다');
  assert.strictEqual((dom.root.innerHTML.match(/class="spider-column"/g) || []).length, 10);
});

test('스파이더의 긴 열은 공개 상태별 간격을 줄여 판 높이 안에 놓는다 (CLAW-279)', () => {
  const column = Array.from({ length: 30 }, (_, index) => card('spades', 13 - (index % 13), index >= 8));
  const offsets = spiderCardOffsets(column, 370);
  assert.strictEqual(offsets.length, 30);
  assert.ok(offsets.every((offset, index) => index === 0 || offset >= offsets[index - 1]));
  assert.ok(offsets.at(-1) + 96 <= 370, '아무리 긴 열도 기본 보드 높이를 넘지 않아야 한다');

  const compactOffsets = spiderCardOffsets(column, 260);
  assert.ok(compactOffsets.at(-1) + 96 <= 260,
    '낮은 창에서도 카드 간격을 다시 계산해 마지막 카드를 보여야 한다');
});

test('좁은 스파이더 창의 긴 열도 창을 넓힐 때 하단 영역을 침범하지 않는다 (CLAW-279)', () => {
  const dom = spiderDomFixture(spiderEngine);
  dom.root.clientWidth = 420;
  const instance = mountSpider(dom.root);
  instance.state = spiderState({
    tableau: [Array.from({ length: 30 }, (_, index) => card('spades', 13 - (index % 13))),
      ...Array.from({ length: 9 }, () => [])],
  });
  instance.onCommand({ target: { dataset: { gameCommand: 'help-spider' } } });
  const offsets = [...dom.root.innerHTML.matchAll(/style="top:(\d+)px;z-index:/g)].map((match) => Number(match[1]));
  assert.ok(Math.max(...offsets) + 96 <= 340,
    '세로 간격은 폭 축척과 독립적으로 높이 490px에서 하단 150px를 비워야 한다');
});

test('스파이더 UI는 CC0 카드 스프라이트와 난이도·되돌리기·힌트 명령을 연결한다 (CLAW-279)', () => {
  assert.match(GAMES_JS, /\.spider-shell[\s\S]+english-pattern-playing-cards@2x\.png/);
  for (const command of ['new-spider-1', 'new-spider-2', 'new-spider-4', 'undo-spider', 'hint-spider']) {
    assert.ok(GAMES_JS.includes(`'${command}'`), `${command} 명령 처리가 필요하다`);
  }
});

test('스파이더 컨트롤러는 mount 시점의 엔진을 쓰고 클릭 이동·재고·난이도를 처리한다 (CLAW-279)', () => {
  const dom = spiderDomFixture(spiderEngine);
  const instance = mountSpider(dom.root);
  assert.strictEqual(instance.engine, spiderEngine, '브라우저 전역은 require 후 mount할 때 해석해야 한다');
  assert.deepStrictEqual(dom.difficultyButtons.map((button) => button.getAttribute('aria-checked')),
    ['true', 'false', 'false']);
  const initialMarkup = dom.root.innerHTML;

  instance.onCommand({ target: { dataset: { gameCommand: 'new-spider-4' } } });
  assert.strictEqual(instance.state.difficulty, 4);
  assert.deepStrictEqual(dom.difficultyButtons.map((button) => button.getAttribute('aria-checked')),
    ['false', 'false', 'true']);
  instance.onCommand({ target: { dataset: { gameCommand: 'new-spider-2' } } });
  assert.strictEqual(instance.state.difficulty, 2);
  assert.deepStrictEqual(dom.difficultyButtons.map((button) => button.getAttribute('aria-checked')),
    ['false', 'true', 'false']);
  instance.onCommand({ target: { dataset: { gameCommand: 'new-spider-1' } } });
  assert.strictEqual(instance.state.difficulty, 1);
  assert.deepStrictEqual(dom.difficultyButtons.map((button) => button.getAttribute('aria-checked')),
    ['true', 'false', 'false']);
  instance.onCommand({ target: { dataset: { gameCommand: 'new-spider-4' } } });
  assert.strictEqual(instance.state.difficulty, 4);
  assert.match(initialMarkup, /난이도:\s*한 무늬/);
  assert.match(dom.root.innerHTML, /난이도:\s*네 무늬/);

  instance.state = spiderState({
    tableau: [
      [card('clubs', 10, false), card('spades', 8), card('spades', 7)],
      [card('hearts', 9)],
      ...Array.from({ length: 8 }, () => [card('clubs', 13)]),
    ],
    stock: Array.from({ length: 10 }, (_, index) => card('diamonds', index + 1, false)),
  });
  const click = (dataset) => instance.onClick({
    target: { closest: () => ({ dataset }) },
  });
  click({ zone: 'tableau', column: '0', index: '1' });
  click({ targetZone: 'tableau', column: '1' });
  assert.deepStrictEqual(instance.state.tableau[1].map((value) => value.rank), [9, 8, 7]);
  click({ zone: 'spider-stock' });
  assert.strictEqual(instance.state.stock.length, 0);
});

test('XP 스파이더 메뉴는 게임 팝업·카드 나누기·도움말 명령을 처리한다 (CLAW-279)', () => {
  const dom = spiderDomFixture(spiderEngine);
  const instance = mountSpider(dom.root);

  instance.onCommand({ target: { dataset: { gameCommand: 'toggle-spider-game-menu' } } });
  assert.strictEqual(dom.gameMenuPopup.hidden, false);
  assert.strictEqual(dom.gameMenuButton.getAttribute('aria-expanded'), 'true');

  instance.onCommand({ target: { dataset: { gameCommand: 'new-spider-2' } } });
  assert.strictEqual(instance.state.difficulty, 2);
  assert.strictEqual(dom.gameMenuPopup.hidden, true, '새 게임 뒤에는 게임 메뉴를 닫아야 한다');
  assert.strictEqual(dom.gameMenuButton.getAttribute('aria-expanded'), 'false');
  assert.deepStrictEqual(dom.difficultyButtons.map((button) => button.getAttribute('aria-checked')),
    ['false', 'true', 'false']);

  instance.state = spiderState({
    tableau: Array.from({ length: 10 }, () => [card('clubs', 13)]),
    stock: Array.from({ length: 10 }, (_, index) => card('spades', index + 1, false)),
  });
  instance.onCommand({ target: { dataset: { gameCommand: 'deal-spider' } } });
  assert.strictEqual(instance.state.stock.length, 0, '상단 카드 나누기도 게임판 재고와 같은 동작이어야 한다');

  instance.onCommand({ target: { dataset: { gameCommand: 'help-spider' } } });
  assert.match(instance.message, /같은 무늬.*내림차순/);
});

test('스파이더 키는 활성·표시·복원 상태에서만 입력을 받는다 (CLAW-279)', () => {
  assert.ok(spiderInputEnabled({ paused: false, hidden: false, minimized: false, active: true, destroyed: false }));
  assert.ok(!spiderInputEnabled({ paused: true, hidden: false, minimized: false, active: true, destroyed: false }));
  assert.ok(!spiderInputEnabled({ paused: false, hidden: true, minimized: false, active: true, destroyed: false }));
  assert.ok(!spiderInputEnabled({ paused: false, hidden: false, minimized: true, active: true, destroyed: false }));
  assert.ok(!spiderInputEnabled({ paused: false, hidden: false, minimized: false, active: false, destroyed: false }));
  assert.ok(!spiderInputEnabled({ paused: false, hidden: false, minimized: false, active: true, destroyed: true }));
});

test('스파이더 힌트는 판을 바꾸지 않고 출발·도착 열만 표시한다 (CLAW-279)', () => {
  const state = spiderState({
    tableau: [[card('clubs', 9, false), card('spades', 8)], [card('hearts', 9)], ...Array.from({ length: 8 }, () => [])],
  });
  const before = structuredClone(state);
  const source = { classList: classListFixture() };
  const target = { classList: classListFixture() };
  const instance = {
    engine: spiderEngine,
    state,
    hint: null,
    message: '',
    root: {
      querySelectorAll: () => [],
      querySelector: (selector) => selector.includes('data-index="1"') ? source : target,
    },
  };

  assert.ok(showSpiderHint(instance));
  assert.deepStrictEqual(state, before);
  assert.ok(source.classList.contains('hint-source'));
  assert.ok(target.classList.contains('hint-target'));
});

test('스파이더 재고 힌트는 하단 재고 묶음 영역을 강조한다 (CLAW-279)', () => {
  const target = { classList: classListFixture() };
  const instance = {
    engine: spiderEngine,
    state: spiderState({
      tableau: Array.from({ length: 10 }, () => [card('spades', 13)]),
      stock: Array(10).fill(backCard()),
    }),
    hint: null,
    message: '',
    root: {
      querySelectorAll: () => [],
      querySelector: (selector) => selector === '.spider-stock-packets' ? target : null,
    },
  };

  assert.ok(showSpiderHint(instance));
  assert.strictEqual(instance.hint.type, 'stock');
  assert.ok(target.classList.contains('hint-target'));
});

test('축소된 스파이더 포인터 드래그도 카드 크기와 잡은 지점을 유지해 도착 열로 옮긴다 (CLAW-279)', () => {
  const dom = spiderDomFixture(spiderEngine);
  dom.root.clientWidth = 420;
  const instance = mountSpider(dom.root);
  instance.state = spiderState({
    tableau: [
      [card('clubs', 10, false), card('spades', 8), card('spades', 7)],
      [card('hearts', 9)],
      ...Array.from({ length: 8 }, () => [card('clubs', 13)]),
    ],
  });
  const cards = [1, 2].map((index) => {
    const element = {
      dataset: { zone: 'tableau', column: '0', index: String(index) },
      style: { top: `${index * 23}px` },
      classList: classListFixture(),
      closest: () => element,
      getBoundingClientRect: () => ({ left: 100, top: 80 }),
      setPointerCapture: () => {},
      hasPointerCapture: () => true,
      releasePointerCapture: () => {},
      cloneNode: () => ({
        dataset: { index: String(index) },
        style: {},
        classList: classListFixture(),
        removeAttribute: () => {},
      }),
    };
    return element;
  });
  let ghost = null;
  dom.root.querySelectorAll = () => cards;
  dom.document.createElement = () => {
    ghost = {
      children: [],
      style: {},
      setAttribute: () => {},
      appendChild(child) { this.children.push(child); },
      remove() { this.removed = true; },
    };
    return ghost;
  };
  dom.document.body = { appendChild: () => {} };
  let hitPoint = null;
  const destination = { dataset: { column: '1' }, closest: () => destination };
  dom.document.elementFromPoint = (x, y) => { hitPoint = { x, y }; return destination; };

  instance.onPointerDown({
    target: cards[0], button: 0, isPrimary: true, pointerId: 7, clientX: 132, clientY: 98,
  });
  instance.onPointerMove({ pointerId: 7, clientX: 140, clientY: 106, preventDefault: () => {} });
  assert.strictEqual(ghost.children.length, 2, '선택한 같은 무늬 묶음만 고스트로 복제해야 한다');
  assert.strictEqual(ghost.style.transform, 'translate3d(108px,88px,0)');
  assert.strictEqual(ghost.style.width, '36px');
  assert.strictEqual(ghost.children[0].style.transform, 'scale(0.5)');
  assert.strictEqual(ghost.children[1].style.top, '11.5px');
  instance.onPointerUp({ pointerId: 7, clientX: 310, clientY: 220, preventDefault: () => {} });

  assert.deepStrictEqual(hitPoint, { x: 310, y: 220 });
  assert.deepStrictEqual(instance.state.tableau[1].map((value) => value.rank), [9, 8, 7]);
  assert.ok(ghost.removed);
});

test('스파이더는 일시 정지·복원 사이에 판을 보존하고 destroy에서 모든 청취자를 제거한다 (CLAW-279)', () => {
  const dom = spiderDomFixture(spiderEngine);
  mount('spider', dom.root, 71);
  const mountedMarkup = dom.root.innerHTML;
  assert.deepStrictEqual([...dom.rootListeners.keys()].sort(),
    ['click', 'pointercancel', 'pointerdown', 'pointermove', 'pointerup']);
  assert.ok(dom.sectionListeners.has('click'));
  assert.ok(dom.viewListeners.has('keydown'));

  resume('spider');
  pause('spider');
  resume('spider');
  assert.strictEqual(dom.root.innerHTML, mountedMarkup, '최소화를 복원해도 판을 새로 섹으면 안 된다');

  destroy('spider', 71);
  assert.strictEqual(dom.root.innerHTML, '');
  assert.strictEqual(dom.rootListeners.size, 0);
  assert.strictEqual(dom.sectionListeners.size, 0);
  assert.strictEqual(dom.viewListeners.size, 0);
  assert.ok(dom.resizeObservers.every((observer) => observer.disconnected),
    '닫은 창의 크기 감시자는 남으면 안 된다');
});

test('스파이더 Ctrl+Z와 H는 활성 창이 복원된 동안에만 명령을 수행한다 (CLAW-279)', () => {
  const dom = spiderDomFixture(spiderEngine);
  const instance = mountSpider(dom.root);
  instance.state = spiderState({
    tableau: [[card('spades', 8)], [card('hearts', 9)], ...Array.from({ length: 8 }, () => [])],
  });
  spiderEngine.moveSpiderRun(instance.state, 0, 0, 1);
  let prevented = 0;
  const undo = { key: 'z', ctrlKey: true, metaKey: false, repeat: false, preventDefault: () => { prevented += 1; } };

  instance.onKeyDown(undo);
  assert.strictEqual(instance.state.history.length, 1, '일시 정지 중에는 되돌리면 안 된다');
  instance.paused = false;
  instance.onKeyDown(undo);
  assert.strictEqual(instance.state.history.length, 0);
  assert.strictEqual(prevented, 1);

  dom.section.classList.add('win-min');
  instance.onKeyDown({ key: 'h', ctrlKey: false, metaKey: false, repeat: false, preventDefault: () => { prevented += 1; } });
  assert.strictEqual(prevented, 1, '최소화 중 H를 가로채면 안 된다');
});

test('플레이 중 Space를 누르면 양쪽 플리퍼를 함께 올리고 떼면 내린다 (CLAW-278)', () => {
  const state = createPinballState();
  state.status = 'playing';
  const controls = { left: false, right: false };

  assert.strictEqual(applyPinballKeyControl(state, controls, ' ', true), 'flippers');
  assert.deepStrictEqual({ left: controls.left, right: controls.right }, { left: true, right: true });
  assert.strictEqual(applyPinballKeyControl(state, controls, ' ', false), 'flippers');
  assert.deepStrictEqual({ left: controls.left, right: controls.right }, { left: false, right: false });

  state.status = 'awaiting';
  assert.strictEqual(applyPinballKeyControl(state, controls, ' ', true), 'plunger',
    '발사 전 Space는 기존처럼 플런저를 조작해야 한다');
});

test('다른 플리퍼 키를 누른 채 Space 플런저를 떼어도 발사 입력을 잃지 않는다 (CLAW-278)', () => {
  const state = createPinballState();
  state.status = 'awaiting';
  const controls = { left: false, right: false, leftKey: false, rightKey: false, space: false };

  applyPinballKeyControl(state, controls, 'arrowleft', true);
  assert.strictEqual(applyPinballKeyControl(state, controls, ' ', true), 'plunger');
  assert.strictEqual(applyPinballKeyControl(state, controls, ' ', false), 'plunger');
  assert.ok(controls.left, 'Space를 떼어도 따로 누른 왼쪽 키 상태는 유지돼야 한다');

  state.status = 'playing';
  applyPinballKeyControl(state, controls, ' ', true);
  applyPinballKeyControl(state, controls, ' ', false);
  assert.deepStrictEqual({ left: controls.left, right: controls.right }, { left: true, right: false },
    'Space 양쪽 플리퍼를 떼어도 별도로 누른 왼쪽 플리퍼는 내려가면 안 된다');
});

test('솔버 워커 생성 실패와 반복 실패는 오류 UI로 끝나며 기존 워커는 종료한다 (CLAW-278)', () => {
  const status = { innerHTML: '' };
  class ThrowingWorker {
    constructor() { throw new Error('worker blocked'); }
  }
  const broken = {
    root: {
      ownerDocument: { defaultView: { Worker: ThrowingWorker } },
      querySelector: () => status,
      innerHTML: '',
    },
    state: {}, selected: null, message: '', elapsedMs: 0, runningSince: null,
    paused: true, solving: false, solverWorker: null, solverRequestId: 0,
  };
  assert.doesNotThrow(() => requestSolitaireDeal(broken));
  assert.ok(!broken.solving);
  assert.match(broken.message, /사용할 수 없습니다/);

  class FakeWorker {
    constructor() {
      this.listeners = {};
      this.posts = 0;
      this.terminated = false;
      FakeWorker.latest = this;
    }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    postMessage() { this.posts += 1; }
    terminate() { this.terminated = true; }
    reply(generated) { this.listeners.message({ data: { generated } }); }
  }
  const retrying = {
    root: {
      ownerDocument: { defaultView: { Worker: FakeWorker } },
      querySelector: () => status,
      innerHTML: '',
    },
    state: {}, selected: null, message: '', elapsedMs: 0, runningSince: null,
    paused: true, solving: false, solverWorker: null, solverRequestId: 0,
  };
  requestSolitaireDeal(retrying);
  FakeWorker.latest.reply(null);
  FakeWorker.latest.reply(null);
  FakeWorker.latest.reply(null);
  assert.strictEqual(FakeWorker.latest.posts, 3, '최초 요청과 두 번의 제한된 재시도만 허용한다');
  assert.ok(FakeWorker.latest.terminated);
  assert.ok(!retrying.solving);
  assert.match(retrying.message, /확인하지 못했습니다/);

  let terminated = false;
  const instance = { solverWorker: { terminate: () => { terminated = true; } } };
  stopSolitaireSolver(instance);
  assert.ok(terminated);
  assert.strictEqual(instance.solverWorker, null);
});

test('플리퍼 중앙으로 떨어진 공은 갇히거나 임의로 튀지 않고 드레인된다 (CLAW-278)', () => {
  const state = createPinballState();
  feedPinballBall(state);
  launchPinball(state, 0.7);
  Object.assign(state.balls[0], {
    x: 190,
    y: 490,
    vx: 0,
    vy: 120,
    inLane: false,
    inChute: false,
  });

  for (let frame = 0; frame < 240 && state.status === 'playing'; frame += 1) {
    stepPinball(state, 1 / 60, {});
  }

  assert.strictEqual(state.status, 'awaiting', '중앙 드레인 뒤 다음 구슬이 발사대에 놓여야 한다');
  assert.ok(state.balls[0].inLane, '드레인된 공이 플리퍼 사이에서 다시 위로 튀면 안 된다');
});

test('핀볼 키는 활성 창이 보일 때만 가로챈다 (CLAW-255)', () => {
  assert.ok(pinballInputEnabled({ paused: false, hidden: false, minimized: false, active: true }));
  assert.ok(!pinballInputEnabled({ paused: false, hidden: false, minimized: false, active: false }));
  assert.ok(!pinballInputEnabled({ paused: false, hidden: false, minimized: true, active: true }));
  assert.ok(!pinballInputEnabled({ paused: true, hidden: false, minimized: false, active: true }));
});

test('핀볼과 두 카드놀이는 링크·해시 없는 독립 창으로 지연 로드된다 (CLAW-255, CLAW-279)', () => {
  const table = HTML.slice(HTML.indexOf('const WINDOWS = {'), HTML.indexOf('// 로그인 여부.'));
  assert.match(table, /pinball: \{ title: '[^']+', icon: 'pinball' \}/);
  assert.match(table, /solitaire: \{ title: '[^']+', icon: 'solitaire' \}/);
  assert.match(table, /spider: \{ title: '스파이더 카드놀이', icon: 'solitaire' \}/);
  assert.doesNotMatch(table, /pinball: \{[^}]+(?:href|doc):/);
  assert.doesNotMatch(table, /solitaire: \{[^}]+(?:href|doc):/);
  assert.doesNotMatch(table, /spider: \{[^}]+(?:href|doc):/);
  assert.match(HTML, /script\.src = '\.\/games\.js'/, '게임 코드는 처음 열 때 받아야 한다');
  assert.doesNotMatch(HTML, /<script src="\.\/games\.js"/, '첫 화면에서 게임 코드를 받으면 안 된다');
  const routes = HTML.match(/const HASH_ROUTES = \{([^}]+)\}/)?.[1] || '';
  assert.doesNotMatch(routes, /pinball|solitaire|spider/);
});

test('시작 메뉴에서 스파이더 카드놀이 독립 창과 XP식 게임·배포·도움말 메뉴를 연다 (CLAW-279)', () => {
  const startMenu = HTML.slice(HTML.indexOf('id="startMenu"'), HTML.indexOf('id="ctxMenu"'));
  assert.match(startMenu, /onclick="openFromStart\('spider'\)"[\s\S]*?<img[^>]+src="\.\/icons\/solitaire\.png"[^>]*>[\s\S]*?스파이더 카드놀이/,
    '시작 메뉴는 기존 카드놀이 아이콘으로 스파이더 창을 열어야 한다');

  const start = HTML.indexOf('id="spiderView"');
  const spider = HTML.slice(start, HTML.indexOf('</section>', start));
  assert.ok(start >= 0, '스파이더 전용 창이 있어야 한다');
  assert.match(spider, /class="win win-game [^"]*xp-window hidden" data-win="spider"/);
  assert.match(spider, /class="xp-titleicon" src="\.\/icons\/solitaire\.png"/);
  assert.match(spider, /data-spider-menu-trigger[^>]+aria-haspopup="menu"[^>]+aria-expanded="false"[^>]*>게임\(G\)<\/button>/);
  assert.match(spider, /class="spider-game-menu"[^>]+role="menu"[^>]+data-spider-game-menu[^>]+hidden/);
  for (const command of [
    'new-spider-1', 'new-spider-2', 'new-spider-4', 'undo-spider', 'hint-spider',
    'deal-spider', 'help-spider',
  ]) {
    assert.match(spider, new RegExp(`data-game-command="${command}"`), `${command} 메뉴 명령이 있어야 한다`);
  }
  assert.match(spider, /data-game-command="deal-spider"[^>]*>카드 나누기\(D\)<\/button>/);
  assert.match(spider, /data-game-command="help-spider"[^>]*>도움말\(H\)<\/button>/);
  for (const difficulty of [1, 2, 4]) {
    assert.match(spider, new RegExp(`role="menuitemradio"[^>]+data-game-command="new-spider-${difficulty}"[^>]+data-spider-difficulty="${difficulty}"[^>]+aria-checked="${difficulty === 1}"`),
      `${difficulty}무늬 메뉴는 현재 선택을 나타내는 체크 메뉴여야 한다`);
  }
  assert.match(GAMES_JS, /\.spider-difficulty\[aria-checked="true"\]::before\s*\{[^}]*content:\s*'✓'/,
    '현재 난이도는 XP 스타일 체크 표시가 보여야 한다');
  assert.match(spider, /class="game-root spider-shell" data-game-root="spider"/,
    '스파이더 루트는 전용 렌더러 스타일 범위를 써야 한다');
});

function createGameLoaderHarness(initialWindow = {}) {
  const lifecycleSource = HTML.slice(
    HTML.indexOf('const GAME_IDS = new Set('),
    HTML.indexOf('// 설치 안내·법률 문서는 별도 정적 페이지다.'),
  );
  const scripts = [];
  const windowStub = { ...initialWindow };
  const documentStub = {
    createElement: () => ({}),
    head: { appendChild: (script) => scripts.push(script) },
  };
  const createLoader = new Function(
    'window', 'document', 'openWindows', 'winEl', 'showToast',
    `${lifecycleSource}; return loadGamesScript;`,
  );
  const loadGamesScript = createLoader(windowStub, documentStub, [], () => null, () => {});
  return { loadGamesScript, scripts, windowStub };
}

test('첫 게임 실행은 스파이더 엔진을 받은 뒤에만 공용 게임 코드를 받는다 (CLAW-279)', async () => {
  const harness = createGameLoaderHarness();
  const loaded = harness.loadGamesScript();
  await Promise.resolve();

  assert.deepStrictEqual(harness.scripts.map((script) => script.src), ['./spider-solitaire.js']);
  harness.windowStub.ClawadSpider = {};
  harness.scripts[0].onload();
  await Promise.resolve();
  assert.deepStrictEqual(harness.scripts.map((script) => script.src), ['./spider-solitaire.js', './games.js']);

  harness.windowStub.ClawadGames = {};
  harness.scripts[1].onload();
  assert.strictEqual(await loaded, harness.windowStub.ClawadGames);
});

test('스파이더 엔진 로드 실패 뒤에는 공유 약속을 비우고 다시 시도한다 (CLAW-279)', async () => {
  const harness = createGameLoaderHarness();
  const first = harness.loadGamesScript();
  await Promise.resolve();
  harness.scripts[0].onerror();
  await assert.rejects(first, /SPIDER_MODULE_LOAD_FAILED/);

  const retry = harness.loadGamesScript();
  await Promise.resolve();
  assert.deepStrictEqual(harness.scripts.map((script) => script.src),
    ['./spider-solitaire.js', './spider-solitaire.js']);
  harness.windowStub.ClawadSpider = {};
  harness.scripts[1].onload();
  await Promise.resolve();
  harness.windowStub.ClawadGames = {};
  harness.scripts[2].onload();
  await retry;
});

test('공용 게임 코드 로드 실패 뒤에도 공유 약속을 비우고 다시 시도한다 (CLAW-279)', async () => {
  const harness = createGameLoaderHarness({ ClawadSpider: {} });
  const first = harness.loadGamesScript();
  await Promise.resolve();
  assert.strictEqual(harness.scripts[0].src, './games.js');
  harness.scripts[0].onerror();
  await assert.rejects(first, /GAME_MODULE_LOAD_FAILED/);

  const retry = harness.loadGamesScript();
  await Promise.resolve();
  assert.strictEqual(harness.scripts[1].src, './games.js');
  harness.windowStub.ClawadGames = {};
  harness.scripts[1].onload();
  await retry;
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
    HTML.indexOf('const GAME_IDS = new Set('),
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
  windowStub.ClawadSpider = {};
  if (pendingScript.src === './spider-solitaire.js') {
    pendingScript.onload();
    await Promise.resolve();
  }
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
