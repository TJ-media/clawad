'use strict';
// 클로애드 데스크톱 게임 — 지뢰찾기·3D 핀볼·카드놀이 (CLAW-255).
//
// 경계 [CRITICAL]: 이 파일은 광고·노출·리워드 경로와 아무 것도 공유하지 않는다.
// 네트워크 호출이 없고, 점수·승패가 포인트·잔액·노출 인정에 닿지 않는다. 판은 메모리에만
// 있고 창을 닫으면 사라진다(localStorage도 쓰지 않는다 — 최고 기록을 남길 이유가 없다).
//
// 규칙 계산부는 DOM을 모르는 순수 함수다 — test/games.test.js와 test/user-web-games.test.js가
// 브라우저 없이 그대로 부른다. DOM은 mount* 아래에만 있다.
//
// 그래픽(지뢰·깃발·표정·7세그먼트·카드·핀볼판)은 전부 이 파일 안에서 SVG·캔버스로 그린다.
// 남의 게임 자산을 가져다 쓰지 않는다 — 핀볼도 원작 PINBALL.DAT의 그림·소리를 한 조각도
// 쓰지 않고 좌표로 다시 그렸다. 규칙과 숫자를 옮겨 온 MIT 코드의 고지는 NOTICE.md에 있다.
//
// 창 생명주기는 셸(index.html)이 mount/pause/resume/destroy로만 건다. 게임은 창이
// 최소화되면 멈추고 복원되면 이어진다.

(function exposeGames(root, factory) {
  const games = factory();
  if (typeof module === 'object' && module.exports) module.exports = games;
  if (root) root.ClawadGames = games;
})(typeof globalThis === 'object' ? globalThis : this, function createGames() {
  const SUITS = ['spades', 'hearts', 'diamonds', 'clubs'];

  function shuffledDeck(random = Math.random) {
    const deck = [];
    for (const suit of SUITS) {
      for (let rank = 1; rank <= 13; rank += 1) {
        deck.push({ id: `${suit}-${rank}`, suit, rank, faceUp: false });
      }
    }
    for (let index = deck.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(random() * (index + 1));
      [deck[index], deck[swapIndex]] = [deck[swapIndex], deck[index]];
    }
    return deck;
  }

  function dealKlondike(random = Math.random) {
    const deck = shuffledDeck(random);
    const tableau = Array.from({ length: 7 }, () => []);
    for (let column = 0; column < tableau.length; column += 1) {
      for (let row = 0; row <= column; row += 1) {
        const card = deck.pop();
        card.faceUp = row === column;
        tableau[column].push(card);
      }
    }
    return {
      stock: deck,
      waste: [],
      foundations: Array.from({ length: 4 }, () => []),
      tableau,
      moves: 0,
      won: false,
    };
  }

  function isRed(card) {
    return card.suit === 'hearts' || card.suit === 'diamonds';
  }

  function canPlaceOnTableau(card, target) {
    if (!card || !card.faceUp) return false;
    if (!target) return card.rank === 13;
    return target.faceUp && target.rank === card.rank + 1 && isRed(target) !== isRed(card);
  }

  function isValidTableauRun(cards) {
    if (!cards.length || cards.some((card) => !card.faceUp)) return false;
    for (let index = 1; index < cards.length; index += 1) {
      if (!canPlaceOnTableau(cards[index], cards[index - 1])) return false;
    }
    return true;
  }

  function revealTableauTop(column) {
    const top = column.at(-1);
    if (top) top.faceUp = true;
  }

  function moveTableauRun(state, fromColumn, startIndex, toColumn) {
    const source = state.tableau[fromColumn];
    const target = state.tableau[toColumn];
    if (!source || !target || source === target || startIndex < 0 || startIndex >= source.length) return false;
    const moving = source.slice(startIndex);
    if (!isValidTableauRun(moving) || !canPlaceOnTableau(moving[0], target.at(-1) || null)) return false;
    source.splice(startIndex);
    target.push(...moving);
    revealTableauTop(source);
    state.moves += 1;
    return true;
  }

  function drawStock(state) {
    if (state.stock.length) {
      const card = state.stock.pop();
      card.faceUp = true;
      state.waste.push(card);
      state.moves += 1;
      return card;
    }
    if (!state.waste.length) return null;
    state.stock = state.waste.reverse();
    state.waste = [];
    for (const card of state.stock) card.faceUp = false;
    state.moves += 1;
    return null;
  }

  function foundationAccepts(pile, card) {
    if (!card || !card.faceUp) return false;
    const top = pile.at(-1);
    return top ? top.suit === card.suit && card.rank === top.rank + 1 : card.rank === 1;
  }

  function sourceTop(state, source) {
    if (source.zone === 'waste') return state.waste.at(-1) || null;
    if (source.zone === 'tableau') return state.tableau[source.column]?.at(-1) || null;
    if (source.zone === 'foundation') return state.foundations[source.column]?.at(-1) || null;
    return null;
  }

  function removeSourceTop(state, source) {
    if (source.zone === 'waste') return state.waste.pop();
    if (source.zone === 'tableau') {
      const column = state.tableau[source.column];
      const card = column.pop();
      revealTableauTop(column);
      return card;
    }
    if (source.zone === 'foundation') return state.foundations[source.column].pop();
    return null;
  }

  function moveCardToFoundation(state, source, foundationIndex) {
    const pile = state.foundations[foundationIndex];
    const card = sourceTop(state, source);
    if (!pile || !foundationAccepts(pile, card)) return false;
    pile.push(removeSourceTop(state, source));
    state.moves += 1;
    state.won = isKlondikeWon(state);
    return true;
  }

  function moveCardToTableau(state, source, columnIndex) {
    const column = state.tableau[columnIndex];
    const card = sourceTop(state, source);
    if (!column || !canPlaceOnTableau(card, column.at(-1) || null)) return false;
    column.push(removeSourceTop(state, source));
    state.moves += 1;
    return true;
  }

  function autoMoveToFoundation(state, source) {
    if (source.zone === 'foundation') return false;
    const card = sourceTop(state, source);
    const foundationIndex = state.foundations.findIndex((pile) => foundationAccepts(pile, card));
    return foundationIndex >= 0 && moveCardToFoundation(state, source, foundationIndex);
  }

  function isKlondikeWon(state) {
    return state.foundations.reduce((total, pile) => total + pile.length, 0) === 52;
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // 3D 핀볼 — 우주 비행 훈련 (Space Cadet)
  //
  // 점수·임무·계급·보너스 규칙은 리버스 엔지니어링 구현
  //   k4zmu2a/SpaceCadetPinball (MIT, (c) 2020-2021 Andrey Muzychenko)
  // 의 control.cpp·TPinballTable.cpp를 읽고 옮겼다. 원문 고지는 저장소 루트 NOTICE.md.
  //
  // 원작의 그림·소리 자산(PINBALL.DAT)은 쓰지 않는다 — 판은 아래 좌표 데이터로 직접
  // 그린다. 화면에 보이는 사다리꼴 원근은 원작이 쓰던 투영 행렬 그대로다(proj.cpp에
  // 주석으로 남아 있는 값).
  //
  // 이 절은 DOM을 모른다. 규칙과 물리는 순수 함수고, 캔버스·창은 drawPinball 아래에만 있다.
  // ══════════════════════════════════════════════════════════════════════════════

  // ── 판 좌표계 ──
  // 물리는 위에서 내려다본 평면(테이블 좌표)에서 돈다. 원근은 그릴 때만 씌운다.
  const PINBALL_WIDTH = 380;
  const PINBALL_HEIGHT = 560;
  const PINBALL_BALL_RADIUS = 8;

  // 원작 투영 행렬(SpaceCadetPinball proj.cpp에 적힌 값). z=0(판 평면)에서
  //   y1 = A·y + F,  z1 = G − B·y,  화면 = (x/z1, y1/z1)·D
  const PROJ_A = -0.913545;
  const PROJ_B = 0.406737;
  const PROJ_F = 3.791398;
  const PROJ_G = 24.675402;
  const PROJ_UNIT = 11.62 / PINBALL_HEIGHT; // 테이블 1칸 = 원작 단위
  const PROJ_D = 900;

  const PROJ_CENTER_X = 190;
  // 판 맨 위(ty=0)가 화면 y=10에 오도록 맞춘 값.
  const PROJ_CENTER_Y = 10 + (PROJ_F / PROJ_G) * PROJ_D;

  // 판 좌표 → 화면 좌표. scale은 그 깊이에서의 배율(공·글자 크기에 쓴다).
  function projectPinball(tx, ty) {
    const y0 = ty * PROJ_UNIT;
    const scale = PROJ_D / (PROJ_G - PROJ_B * y0);
    return {
      x: PROJ_CENTER_X + (tx - PINBALL_WIDTH / 2) * PROJ_UNIT * scale,
      y: PROJ_CENTER_Y - (PROJ_A * y0 + PROJ_F) * scale,
      scale: PROJ_UNIT * scale,
    };
  }


  // 그려질 캔버스 크기 — 위 투영으로 판 네 귀퉁이를 찍어 얻은 값이다.
  const PINBALL_VIEW_WIDTH = 380;
  const PINBALL_VIEW_HEIGHT = 468;

  // ── 물리 상수 ──
  // 원작 표: 기울기 벡터 25·경사 0.5rad → 아래 방향 가속 11.98(원작 단위/s²).
  // 테이블 좌표로 환산하면 11.98 / PROJ_UNIT ≈ 515.
  const PINBALL_GRAVITY = 11.98 / PROJ_UNIT;
  const PINBALL_DRAG = 0.2;      // 원작 GraityMult
  const PINBALL_MAX_SPEED = 2600;
  const PINBALL_JITTER = 0.35;   // 원작이 X축에 섞던 미세한 흔들림

  // ── 판 배치 ──
  // 원작 판을 같은 구역·같은 개수로 다시 세운 값이다. 위쪽 큰 호가 함대 배치 슈트,
  // 오른쪽 세로 통로가 구슬 쏘기 레인, 가운데 원이 계급 원판이다.
  const ARC_CX = 190;
  const ARC_CY = 186;
  const ARC_OUTER = 168;             // 바깥 레일
  const ARC_INNER = 140;             // 슈트 안쪽 턱
  const ARC_OUTER_END = 2.88;        // 165° — 바깥 레일이 끝나는 각
  const ARC_INNER_END = 2.62;        // 150° — 여기서 공이 판으로 떨어진다
  const LANE_LEFT = ARC_CX + ARC_INNER;    // 330 — 쏘기 레인 왼쪽 벽
  const LANE_RIGHT = ARC_CX + ARC_OUTER;   // 358 — 쏘기 레인 오른쪽 벽
  const DRAIN_Y = PINBALL_HEIGHT - 4;

  const FLIPPER_LENGTH = 62;
  const FLIPPER_RADIUS = 7;
  const FLIPPER_REST = 0.5236;    // 30°, 아래로 벌어진 각
  const FLIPPER_LIFT = 0.4363;    // 25°, 올라간 각
  const FLIPPER_EXTEND = 0.055;   // 올라가는 데 걸리는 시간(초)
  const FLIPPER_RETRACT = 0.13;

  const PINBALL_FLIPPERS = [
    { id: 'flipL', side: 'left', x: 126, y: 470, down: FLIPPER_REST, up: -FLIPPER_LIFT },
    { id: 'flipR', side: 'right', x: 254, y: 470, down: Math.PI - FLIPPER_REST, up: Math.PI + FLIPPER_LIFT },
  ];

  // 범퍼 — 왼쪽 셋이 공격 범퍼(원작 a_bump1~3), 오른쪽 셋이 발사 범퍼(a_bump5~7).
  const PINBALL_BUMPERS = [
    { id: 'attack1', group: 'attack', x: 96, y: 276, radius: 19 },
    { id: 'attack2', group: 'attack', x: 146, y: 244, radius: 19 },
    { id: 'attack3', group: 'attack', x: 144, y: 310, radius: 19 },
    { id: 'launch1', group: 'launch', x: 286, y: 244, radius: 17 },
    { id: 'launch2', group: 'launch', x: 306, y: 292, radius: 17 },
    { id: 'launch3', group: 'launch', x: 268, y: 330, radius: 17 },
  ];

  // 웜홀 셋(노랑·빨강·초록) — 원작 sink1~3. 슈트에서 떨어진 공이 지나는 자리에 있다.
  const PINBALL_WORMHOLES = [
    { id: 'sink1', color: 'yellow', x: 70, y: 232, radius: 12 },
    { id: 'sink2', color: 'red', x: 110, y: 200, radius: 12 },
    { id: 'sink3', color: 'green', x: 156, y: 178, radius: 12 },
  ];

  // 공을 삼켰다 되쏘는 구멍. hyper=하이퍼스페이스 슈트, blackhole=블랙홀,
  // gravitywell=중력의 중심(하이퍼스페이스를 다섯 번 채워야 열린다).
  const PINBALL_HOLES = [
    { id: 'hyper', x: 64, y: 352, radius: 13, ejectAngle: -0.5, ejectSpeed: 780, hold: 0.9 },
    { id: 'blackhole', x: 312, y: 208, radius: 13, ejectAngle: Math.PI + 0.75, ejectSpeed: 660, hold: 0.9 },
    { id: 'gravitywell', x: 190, y: 392, radius: 13, ejectAngle: -Math.PI / 2, ejectSpeed: 700, hold: 1.1 },
  ];

  // 낙하 표적(팝업) 아홉 — 원작 target1~9. 셋이 한 뱅크다.
  //  booster(1~3)    깃발 → 잭팟 → 보너스 → 추가 보너스
  //  medal(4~6)      1·2·3단계 보너스, 마지막은 보너스 구슬
  //  multiplier(7~9) 공격 점수 2·3·5·10배
  const PINBALL_DROP_TARGETS = [
    { id: 'target1', bank: 'booster', x: 100, y: 416, angle: 1.2 },
    { id: 'target2', bank: 'booster', x: 92, y: 394, angle: 1.2 },
    { id: 'target3', bank: 'booster', x: 84, y: 372, angle: 1.2 },
    { id: 'target4', bank: 'medal', x: 312, y: 416, angle: -1.2 },
    { id: 'target5', bank: 'medal', x: 306, y: 394, angle: -1.2 },
    { id: 'target6', bank: 'medal', x: 298, y: 372, angle: -1.2 },
    { id: 'target7', bank: 'multiplier', x: 236, y: 156, angle: 0.35 },
    { id: 'target8', bank: 'multiplier', x: 266, y: 170, angle: 0.35 },
    { id: 'target9', bank: 'multiplier', x: 294, y: 188, angle: 0.35 },
  ];

  // 고정 표적 열셋 — 원작 target10~22.
  const PINBALL_SPOT_TARGETS = [
    { id: 'target10', bank: 'fuel', x: 124, y: 346, angle: 1.3 },
    { id: 'target11', bank: 'fuel', x: 122, y: 368, angle: 1.3 },
    { id: 'target12', bank: 'fuel', x: 122, y: 390, angle: 1.3 },
    { id: 'target13', bank: 'mission', x: 196, y: 196, angle: 0.5 },
    { id: 'target14', bank: 'mission', x: 221, y: 207, angle: 0.5 },
    { id: 'target15', bank: 'mission', x: 246, y: 218, angle: 0.5 },
    { id: 'target16', bank: 'hazardL', x: 52, y: 286, angle: 1.45 },
    { id: 'target17', bank: 'hazardL', x: 52, y: 308, angle: 1.45 },
    { id: 'target18', bank: 'hazardL', x: 54, y: 330, angle: 1.45 },
    { id: 'target19', bank: 'hazardR', x: 322, y: 290, angle: -1.45 },
    { id: 'target20', bank: 'hazardR', x: 322, y: 312, angle: -1.45 },
    { id: 'target21', bank: 'hazardR', x: 322, y: 334, angle: -1.45 },
    { id: 'target22', bank: 'destination', x: 196, y: 152, angle: 0.15 },
  ];

  // 통과 라인(롤오버).
  const PINBALL_ROLLOVERS = [
    // 재돌입 레인 셋 — 슈트에서 떨어진 공이 지난다. 다 켜면 공격 범퍼가 강해진다.
    { id: 'roll1', kind: 'reentry', x: 52, y: 194, radius: 11 },
    { id: 'roll2', kind: 'reentry', x: 76, y: 172, radius: 11 },
    { id: 'roll3', kind: 'reentry', x: 106, y: 154, radius: 11 },
    // 발사 레인 셋 — 오른쪽 위. 다 켜면 발사 범퍼가 강해진다.
    { id: 'roll110', kind: 'launchlane', x: 308, y: 218, radius: 11 },
    { id: 'roll111', kind: 'launchlane', x: 320, y: 258, radius: 11 },
    { id: 'roll112', kind: 'launchlane', x: 302, y: 340, radius: 11 },
    // 바깥 레인·리턴 레인·보너스 레인.
    { id: 'roll4', kind: 'outlane', side: 'left', x: 68, y: 476, radius: 12 },
    { id: 'roll8', kind: 'outlane', side: 'right', x: 312, y: 476, radius: 12 },
    { id: 'roll6', kind: 'returnlane', side: 'left', x: 102, y: 452, radius: 12 },
    { id: 'roll7', kind: 'returnlane', side: 'right', x: 278, y: 452, radius: 12 },
    { id: 'roll5', kind: 'bonuslane', x: 190, y: 432, radius: 13 },
    // 공간 이동 통로.
    { id: 'roll9', kind: 'spacewarp', x: 190, y: 300, radius: 12 },
    // 연료 레인 여섯.
    { id: 'roll179', kind: 'fuel', x: 86, y: 300, radius: 9 },
    { id: 'roll180', kind: 'fuel', x: 86, y: 326, radius: 9 },
    { id: 'roll181', kind: 'fuel', x: 240, y: 300, radius: 9 },
    { id: 'roll182', kind: 'fuel', x: 234, y: 326, radius: 9 },
    { id: 'roll183', kind: 'fuel', x: 138, y: 424, radius: 9 },
    { id: 'roll184', kind: 'fuel', x: 242, y: 424, radius: 9 },
  ];

  // 깃발(회전자) 둘 — 지날 때마다 돌면서 점수를 준다.
  const PINBALL_FLAGS = [
    { id: 'flag1', x: 62, y: 258, radius: 12 },
    { id: 'flag2', x: 316, y: 168, radius: 12 },
  ];

  // 리바운드 넷 — 플리퍼 위 삼각 튕김판 둘과 옆벽 튕김판 둘(원작 rebo1~4).
  const PINBALL_REBOUNDERS = [
    { id: 'rebo1', ax: 104, ay: 412, bx: 118, by: 444 },
    { id: 'rebo2', ax: 276, ay: 412, bx: 262, by: 444 },
    { id: 'rebo3', ax: 44, ay: 356, bx: 45, by: 396 },
    { id: 'rebo4', ax: 330, ay: 356, bx: 330, by: 396 },
  ];

  // 킥백 — 위험물 뱅크를 채우면 바깥 레인에서 공을 되쏜다.
  const PINBALL_KICKERS = [
    { id: 'kick1', side: 'left', x: 74, y: 520 },
    { id: 'kick2', side: 'right', x: 306, y: 520 },
  ];

  // 벽. seg=선분, arc=원호(inside면 공이 원 안쪽에 있다).
  const PINBALL_WALLS = buildPinballWalls();

  function buildPinballWalls() {
    const walls = [];
    const seg = (ax, ay, bx, by, bounce) => walls.push({ kind: 'seg', ax, ay, bx, by, bounce: bounce ?? 0.42 });
    const arc = (cx, cy, radius, from, to, inside, bounce) =>
      walls.push({ kind: 'arc', cx, cy, radius, from, to, inside, bounce: bounce ?? 0.42 });

    // 위쪽 함대 배치 슈트 — 바깥 레일과 안쪽 턱.
    arc(ARC_CX, ARC_CY, ARC_OUTER, 0, ARC_OUTER_END, true);
    arc(ARC_CX, ARC_CY, ARC_INNER, 0, ARC_INNER_END, false);

    // 구슬 쏘기 레인.
    seg(LANE_RIGHT, ARC_CY, LANE_RIGHT, PINBALL_HEIGHT);
    seg(LANE_LEFT, ARC_CY, LANE_LEFT, PINBALL_HEIGHT);

    // 판 왼쪽 벽 — 슈트 바깥 레일이 끝나는 자리에서 이어받는다.
    seg(28, 143, 34, 240);
    seg(34, 240, 42, 330);
    seg(42, 330, 46, 430);
    seg(46, 430, 56, 502);
    seg(56, 502, 78, DRAIN_Y);

    // 판 오른쪽 아래 깔때기.
    seg(330, 430, 324, 502);
    seg(324, 502, 302, DRAIN_Y);

    // 바깥 레인과 리턴 레인을 가르는 칸막이(바깥쪽 면).
    seg(88, 436, 80, 492);
    seg(80, 492, 104, DRAIN_Y);
    seg(292, 436, 300, 492);
    seg(300, 492, 276, DRAIN_Y);

    // 리턴 레인 바닥 — 공을 플리퍼 위로 흘려 준다. 이게 없으면 리턴 레인이
    // 플리퍼 옆을 지나 그대로 드레인으로 이어진다.
    seg(86, 456, 120, 468);
    seg(294, 456, 260, 468);

    // 가운데 계급 원판 둘레 — 공이 걸리지 않게 벽은 두지 않는다(원작도 인쇄만 돼 있다).
    return walls;
  }

  // ── 점수표 ──
  // 값은 전부 원작 control.cpp의 control_*_score 배열 그대로다.
  const PINBALL_SCORES = {
    attackBumper: [500, 1000, 1500, 2000],      // 무기 보강 단계별
    launchBumper: [1500, 2500, 3500, 4500],     // 엔진 강화 단계별
    reentryLane: 2000,
    launchLane: 500,
    rebounder: 500,
    skillShot: [15000, 30000, 75000, 30000, 15000, 7500],
    ramp: 5000,
    outLane: 20000,
    returnLane: [5000, 25000],
    bonusLane: 10000,
    fuelLane: 500,
    flag: [500, 2500],
    hyperspace: [10000, 0, 20000, 50000, 150000],
    wormhole: [2500, 5000, 7500],
    boosterTarget: [500, 5000],
    medalTarget: [1500, 10000, 50000],
    multiplierTarget: [500, 1500],
    fuelTarget: 750,
    missionTarget: 1000,
    hazardTarget: 750,
    destinationTarget: 750,
    spaceWarp: 10000,
    blackHole: 20000,
    gravityWell: 50000,
  };

  const PINBALL_MULTIPLIERS = [1, 2, 3, 5, 10];   // 원작 score_multipliers
  const PINBALL_MAX_BALLS = 3;                    // 원작 MaxBallCount
  const PINBALL_RANK_STEPS = 16;                  // 계급 원판 바깥 고리 칸 수
  const PINBALL_FUEL_MAX = 12;                    // 연료 막대 칸 수
  const PINBALL_FUEL_SECONDS = 8;                 // 한 칸이 줄어드는 데 걸리는 시간

  // 계급 아홉 — 원작 STRING185~193의 한국어 표기.
  const PINBALL_RANKS = ['후보생', '소위', '중위', '대위', '소령', '중령', '부함장', '함장', '제독'];

  // 임무 열일곱 — 이름은 원작 STRING161~177의 한국어 표기.
  // stage.goal: 무엇을 해야 넘어가는가. need: 필요한 횟수(0이면 한 번).
  const PINBALL_MISSIONS = {
    2: {
      name: '사격 연습', select: 10000, score: 500000, rank: 6, done: '사격 훈련 통과',
      stages: [{ goal: 'attackBumper', need: 8, text: '공격 범퍼 맞히기' }],
    },
    3: {
      name: '발사 훈련', select: 10000, score: 500000, rank: 6, done: '발사 훈련 통과',
      stages: [{ goal: 'ramp', need: 3, text: '남은 발사 횟수' }],
    },
    4: {
      name: '재돌입 훈련', select: 10000, score: 500000, rank: 6, done: '재돌입 훈련 통과',
      stages: [{ goal: 'reentryLane', need: 3, text: '남은 재돌입 횟수' }],
    },
    5: {
      name: '과학', select: 10000, score: 750000, rank: 9, done: '과학 임무 완료',
      stages: [{ goal: 'dropTarget', need: 9, text: '낙하 표적 수' }],
    },
    6: {
      name: '궤도 이탈 혜성', select: 20000, score: 1000000, rank: 8, done: '혜성 파괴',
      stages: [
        { goal: 'hazardR', need: 0, text: '오른쪽 위험물 뱅크 채우기' },
        { goal: 'hyperspace', need: 0, text: '하이퍼스페이스 작동' },
      ],
    },
    7: {
      name: '블랙홀', select: 20000, score: 1000000, rank: 8, done: '블랙홀 제거',
      stages: [
        { goal: 'launchBumperUpgrade', need: 0, text: '발사 범퍼 치기' },
        { goal: 'blackhole', need: 0, text: '블랙홀에 들어감' },
      ],
    },
    8: {
      name: '우주 방사선', select: 20000, score: 1000000, rank: 8, done: '방사선 제거',
      stages: [
        { goal: 'hazardL', need: 0, text: '왼쪽 위험물 뱅크 채우기' },
        { goal: 'wormhole', need: 0, text: '웜홀에 들어감' },
      ],
    },
    9: {
      name: '우주 바이러스 퇴치', select: 20000, score: 750000, rank: 7, done: '우주 괴물 격퇴',
      stages: [{ goal: 'anyTarget', need: 15, text: '표적' }],
    },
    10: {
      name: '외계인 출현', select: 20000, score: 750000, rank: 7, done: '외계인 격퇴',
      stages: [
        { goal: 'attackBumperUpgrade', need: 0, text: '공격 범퍼 치기' },
        { goal: 'attackBumper', need: 8, text: '공격 범퍼 맞히기' },
      ],
    },
    11: {
      name: '구출', select: 20000, score: 750000, rank: 7, done: '구출된 생존자',
      stages: [
        { goal: 'flagUpgrade', need: 0, text: '깃발 업그레이드' },
        { goal: 'hyperspace', need: 0, text: '하이퍼스페이스 작동' },
      ],
    },
    12: {
      name: '위성 되찾기', select: 20000, score: 1250000, rank: 9, done: '위성 복구',
      stages: [{ goal: 'attackBumper', need: 3, text: '원거리 공격 범퍼 맞히기' }],
    },
    13: {
      name: '정찰', select: 20000, score: 1250000, rank: 9, done: '탐사 완료',
      stages: [{ goal: 'lane', need: 15, text: '레인 통과 수' }],
    },
    14: {
      name: '핵무기', select: 20000, score: 1250000, rank: 9, done: '핵무기 파괴',
      stages: [{ goal: 'outLane', need: 3, text: '외부 레인 통과' }],
    },
    15: {
      name: '우주 재앙', select: 30000, score: 1750000, rank: 11, done: '우주 재앙 격퇴',
      stages: [
        { goal: 'flag', need: 75, text: '깃발 회전 수' },
        { goal: 'spaceWarp', need: 0, text: '공간 이동 통로 맞히기' },
      ],
    },
    16: {
      name: '비밀', select: 30000, score: 1500000, rank: 10, done: '설계도 복구',
      stages: [
        { goal: 'wormholeYellow', need: 0, text: '노란 웜홀 맞히기' },
        { goal: 'wormholeRed', need: 0, text: '빨간 웜홀 맞히기' },
        { goal: 'wormholeGreen', need: 0, text: '녹색 웜홀 맞히기' },
      ],
    },
    17: {
      name: '시간 이동', select: 30000, score: 2000000, rank: 12, done: '시간 이동',
      stages: [
        { goal: 'rebounder', need: 25, text: '리바운드 맞히기' },
        { goal: 'timeWarp', need: 0, text: '하이퍼스페이스 슈트 또는 발사대 맞히기' },
      ],
    },
    18: {
      name: '대혼란', select: 30000, score: 5000000, rank: 18, done: '대혼란',
      stages: [
        { goal: 'dropTarget', need: 3, text: '낙하 표적 맞히기' },
        { goal: 'spotTarget', need: 3, text: '지정한 표적 맞히기' },
        { goal: 'lane', need: 5, text: '레인 통과 수' },
        { goal: 'bonusLane', need: 0, text: '연료 슈트에 구슬 집어넣기' },
        { goal: 'ramp', need: 0, text: '발사대 맞히기' },
        { goal: 'flag', need: 0, text: '깃발 맞히기' },
        { goal: 'wormhole', need: 0, text: '웜홀 맞히기' },
        { goal: 'hyperspace', need: 0, text: '하이퍼스페이스 슈트를 맞혀 소용돌이 제거' },
      ],
    },
  };

  // 임무 표적을 맞힌 조합과 계급으로 어떤 임무가 걸리는지 — 원작 SelectMissionController.
  // 열쇠는 계급(가운데 원판에 켜진 라이트 수), 값은 [표적1, 표적2, 표적3, 셋 다]의 임무 번호.
  const PINBALL_MISSION_TABLE = [
    { upTo: 1, ids: [3, 4, 2, 5] },
    { upTo: 3, ids: [9, 11, 10, 16] },
    { upTo: 5, ids: [6, 8, 7, 15] },
    { upTo: 7, ids: [12, 13, 14, 17] },
    { upTo: 9, ids: [15, 16, 17, 18] },
  ];

  function pinballMissionName(id) {
    return PINBALL_MISSIONS[id] ? PINBALL_MISSIONS[id].name : '';
  }

  function pinballRankName(rank) {
    return PINBALL_RANKS[Math.max(0, Math.min(PINBALL_RANKS.length - 1, rank - 1))];
  }

  // 계급과 맞힌 표적으로 임무 번호를 고른다. level 1~3은 표적 하나, 4는 셋 다 맞힌 경우.
  function pinballPickMission(rank, level) {
    if (level < 1 || level > 4) return 0;
    for (const row of PINBALL_MISSION_TABLE) {
      if (rank <= row.upTo) return row.ids[level - 1];
    }
    return 0;
  }

  // ── 판 상태 ──
  function createPinballState() {
    return {
      width: PINBALL_WIDTH,
      height: PINBALL_HEIGHT,
      time: 0,
      balls: [],
      ballsLeft: PINBALL_MAX_BALLS,
      extraBalls: 0,
      score: 0,
      gameOver: false,
      // awaiting=배치 대기, charging=플런저 당기는 중, playing=진행, drained=구슬 빠짐
      status: 'awaiting',
      plunger: 0,               // 0~1, 당긴 정도
      tilt: 0,                  // 흔든 누적치. 1을 넘기면 반칙.
      tiltLock: false,

      // 점수 보정 — 원작 TPinballTable의 같은 이름 필드들.
      bonusScore: 10000,
      bonusFlag: false,
      jackpotScore: 20000,
      jackpotFlag: false,
      reflexShotScore: 25000,
      multiplier: 0,            // PINBALL_MULTIPLIERS의 색인

      // 계급.
      rank: 1,                  // 가운데 원판에 켜진 라이트 수(1~9)
      rankProgress: 0,          // 바깥 고리(0~PINBALL_RANK_STEPS)

      // 임무.
      mission: 0,               // 0=배치 대기, 1=임무 선택, 2~18=진행 중
      missionPick: 0,           // 발사대를 맞히면 시작할 임무 번호
      missionStage: 0,
      missionCount: 0,
      missionText: '함대 배치 준비',
      infoText: '',
      infoUntil: 0,

      // 연료(막대 12칸). 0이 되면 진행 중인 임무가 취소된다.
      fuel: PINBALL_FUEL_MAX,
      fuelTimer: 0,

      // 램프·구멍·표적 상태.
      dropped: {},              // 낙하 표적 id → true
      spotLit: {},              // 고정 표적 id → true
      lanes: {},                // 롤오버 id → 켜짐
      bumperLevel: { attack: 0, launch: 0 },
      bumperTimer: { attack: 0, launch: 0 },
      medalStage: 0,            // 포상 표적 단계(0~2)
      boosterStage: 0,          // 깃발→잭팟→보너스→추가 보너스
      wormholeTarget: 0,        // 0=꺼짐, 1~3=열린 웜홀 번호
      hyperCount: 0,            // 하이퍼스페이스 연속 진입 횟수
      centerPost: 0,            // 중앙 고지(가운데 막대) 남은 시간
      gravityWell: false,       // 중력의 중심이 열렸는가
      extraBallLit: 0,          // 보너스 구슬 라이트 남은 시간
      flagsLit: 0,              // 깃발 업그레이드 남은 시간
      rampBonus: 0,             // 연속 맞히기(발사대 보너스) 남은 시간
      skillShot: 0,             // 쏘기 기술 라이트(0=꺼짐, 1~6)
      skillShotArmed: false,
      shootAgain: false,        // 다시 쏘기(재배치) 라이트
      kickback: { left: false, right: false },
      // 플리퍼 회전 상태. 각도와 각속도를 들고 있어야 “쓸어 올리는” 힘이 실린다.
      flippers: {
        flipL: { angle: PINBALL_FLIPPERS[0].down, omega: 0 },
        flipR: { angle: PINBALL_FLIPPERS[1].down, omega: 0 },
      },
      events: [],               // 이번 스텝에 생긴 사건(소리·효과용)
    };
  }

  // 점수를 더한다. 원작 TPinballTable::AddScore — 배수·보너스·잭팟이 함께 붙는다.
  function addPinballScore(state, points) {
    if (!points) return 0;
    if (state.jackpotFlag) state.jackpotScore = Math.min(state.jackpotScore + points, 20000000);
    if (state.bonusFlag) state.bonusScore = Math.min(state.bonusScore + points, 5000000);
    const added = points * PINBALL_MULTIPLIERS[state.multiplier];
    state.score += added;
    return added;
  }

  // 보너스·잭팟을 건드리지 않고 한 번만 얹는 점수(임무 완료·보너스 지급 등).
  // 원작 control::SpecialAddScore.
  function addPinballSpecialScore(state, points) {
    const bonus = state.bonusFlag;
    const jackpot = state.jackpotFlag;
    const multiplier = state.multiplier;
    state.bonusFlag = false;
    state.jackpotFlag = false;
    state.multiplier = 0;
    const added = addPinballScore(state, points);
    state.bonusFlag = bonus;
    state.jackpotFlag = jackpot;
    state.multiplier = multiplier;
    return added;
  }

  function pinballInfo(state, text, seconds = 2) {
    state.infoText = text;
    state.infoUntil = state.time + seconds;
  }

  function pinballEvent(state, name, detail) {
    state.events.push(detail === undefined ? { name } : { name, detail });
    if (state.events.length > 32) state.events.shift();
  }

  // 계급 진행. 원작 control::AddRankProgress — 바깥 고리를 채우면 한 계급 오른다.
  function addPinballRankProgress(state, steps) {
    state.rankProgress = Math.min(PINBALL_RANK_STEPS, state.rankProgress + steps);
    if (state.rankProgress < PINBALL_RANK_STEPS) return false;
    state.rankProgress = 0;
    if (state.rank >= PINBALL_RANKS.length) return false;
    state.rank += 1;
    state.missionText = `${pinballRankName(state.rank)}(으)로 수준 올리기`;
    pinballEvent(state, 'promotion', state.rank);
    return true;
  }

  function demotePinballRank(state) {
    if (state.rank <= 1) return false;
    state.rank -= 1;
    state.missionText = `${pinballRankName(state.rank)}로 강등`;
    pinballEvent(state, 'demotion', state.rank);
    return true;
  }
  // ── 임무 진행 ──
  // 원작은 임무마다 컨트롤러 함수를 따로 뒀다. 여기서는 단계 목록으로 같은 흐름을 만든다.
  function pinballStage(state) {
    const mission = PINBALL_MISSIONS[state.mission];
    return mission ? mission.stages[state.missionStage] : null;
  }

  // 화면 위쪽 임무 창에 뜰 문구. 남은 횟수가 있는 단계는 숫자를 함께 보여 준다.
  function pinballMissionPrompt(state) {
    if (state.mission === 0) return '함대 배치 준비';
    if (state.mission === 1) {
      if (!state.fuel) return '배에 연료 공급';
      if (state.missionPick) return `발사대를 맞혀 ${pinballMissionName(state.missionPick)} 임무 시작`;
      return '임무 표적을 맞혀 임무 선택';
    }
    const stage = pinballStage(state);
    if (!stage) return '';
    if (!stage.need) return stage.text;
    return `${stage.text}\n남은 횟수: ${state.missionCount}`;
  }

  function refreshPinballMission(state) {
    state.missionText = pinballMissionPrompt(state);
  }

  // 임무 표적을 맞혔다. 셋 다 맞히면 숨은 임무(level 4)가 걸린다.
  function selectPinballMission(state, level) {
    if (state.mission !== 1) return 0;
    const id = pinballPickMission(state.rank, level);
    if (!id) return 0;
    state.missionPick = id;
    refreshPinballMission(state);
    pinballEvent(state, 'mission-armed', id);
    return id;
  }

  // 발사대를 맞혀 걸어 둔 임무를 실제로 시작한다. 연료가 없으면 시작되지 않는다.
  function startPinballMission(state) {
    const id = state.missionPick;
    if (state.mission !== 1 || !id || !state.fuel) return false;
    const mission = PINBALL_MISSIONS[id];
    state.mission = id;
    state.missionPick = 0;
    state.missionStage = 0;
    state.missionCount = mission.stages[0].need;
    const added = addPinballSpecialScore(state, mission.select);
    state.missionText = `임무 시작\n${added}`;
    pinballEvent(state, 'mission-start', id);
    return true;
  }

  // 연료가 떨어지면 임무가 취소된다 — 원작 MissionControl의 TLightGroupCountdownEnded.
  function abortPinballMission(state) {
    if (state.mission <= 1) return false;
    state.mission = 1;
    state.missionStage = 0;
    state.missionCount = 0;
    state.missionPick = 0;
    state.missionText = '임무 취소';
    pinballEvent(state, 'mission-abort');
    return true;
  }

  function completePinballMission(state) {
    const mission = PINBALL_MISSIONS[state.mission];
    if (!mission) return false;
    const added = addPinballSpecialScore(state, mission.score);
    state.mission = 1;
    state.missionStage = 0;
    state.missionCount = 0;
    state.missionPick = 0;
    pinballEvent(state, 'mission-complete', mission.name);
    // 승급 문구가 있으면 그쪽이 임무 창을 가져간다 — 원작도 같은 순서다.
    if (!addPinballRankProgress(state, mission.rank)) {
      state.missionText = `${mission.done}\n임무 완료 ${added}`;
    }
    return true;
  }

  // 임무 목표 하나가 이뤄졌다. goal이 지금 단계와 맞으면 횟수를 깎고, 다 깎이면 다음 단계로.
  function advancePinballMission(state, goal, amount = 1) {
    const stage = pinballStage(state);
    if (!stage || stage.goal !== goal) return false;
    if (stage.need) {
      state.missionCount = Math.max(0, state.missionCount - amount);
      if (state.missionCount > 0) {
        refreshPinballMission(state);
        return true;
      }
    }
    const mission = PINBALL_MISSIONS[state.mission];
    if (state.missionStage + 1 < mission.stages.length) {
      state.missionStage += 1;
      state.missionCount = mission.stages[state.missionStage].need;
      refreshPinballMission(state);
      pinballEvent(state, 'mission-stage', state.missionStage);
      return true;
    }
    completePinballMission(state);
    return true;
  }

  // 여러 목표에 함께 걸리는 사건을 한 번에 흘려 준다(표적 하나는 anyTarget이기도 하다).
  function pinballGoal(state, ...goals) {
    for (const goal of goals) {
      if (advancePinballMission(state, goal)) return true;
    }
    return false;
  }

  // ── 판 장치별 처리 ──
  // 아래 함수들은 원작 control.cpp의 같은 이름 컨트롤러를 옮긴 것이다.

  function pinballRefuel(state, cells = 1) {
    if (state.fuel >= PINBALL_FUEL_MAX) return;
    state.fuel = Math.min(PINBALL_FUEL_MAX, state.fuel + cells);
    state.fuelTimer = 0;
    pinballInfo(state, '배에 연료 공급');
  }

  function pinballAddExtraBall(state) {
    state.extraBalls += 1;
    pinballInfo(state, '보너스 구슬');
    pinballEvent(state, 'extra-ball');
  }

  // 범퍼. 단계가 오를수록 점수가 커진다(무기 보강·엔진 강화).
  function hitPinballBumper(state, bumper) {
    const level = state.bumperLevel[bumper.group];
    const table = bumper.group === 'attack' ? PINBALL_SCORES.attackBumper : PINBALL_SCORES.launchBumper;
    addPinballScore(state, table[level]);
    pinballEvent(state, 'bumper', bumper.id);
    if (bumper.group === 'attack') pinballGoal(state, 'attackBumper');
    else pinballGoal(state, 'launchBumper');
  }

  // 범퍼 단계를 올린다. 60초가 지나면 한 단계 내려간다 — 원작 BumperGroupControl.
  function upgradePinballBumpers(state, group) {
    if (state.bumperLevel[group] < 3) {
      state.bumperLevel[group] += 1;
      pinballInfo(state, group === 'attack' ? '무기 보강' : '엔진 강화');
    }
    state.bumperTimer[group] = 60;
    pinballGoal(state, group === 'attack' ? 'attackBumperUpgrade' : 'launchBumperUpgrade');
  }

  // 롤오버(레인 통과).
  function hitPinballRollover(state, rollover) {
    const id = rollover.id;
    switch (rollover.kind) {
      case 'reentry': {
        addPinballScore(state, PINBALL_SCORES.reentryLane);
        state.lanes[id] = !state.lanes[id];
        if (PINBALL_ROLLOVERS.filter((r) => r.kind === 'reentry').every((r) => state.lanes[r.id])) {
          for (const r of PINBALL_ROLLOVERS) if (r.kind === 'reentry') state.lanes[r.id] = false;
          upgradePinballBumpers(state, 'attack');
        }
        pinballGoal(state, 'reentryLane', 'lane');
        break;
      }
      case 'launchlane': {
        addPinballScore(state, PINBALL_SCORES.launchLane);
        state.lanes[id] = !state.lanes[id];
        if (PINBALL_ROLLOVERS.filter((r) => r.kind === 'launchlane').every((r) => state.lanes[r.id])) {
          for (const r of PINBALL_ROLLOVERS) if (r.kind === 'launchlane') state.lanes[r.id] = false;
          upgradePinballBumpers(state, 'launch');
        }
        pinballGoal(state, 'launchLane', 'lane');
        break;
      }
      case 'outlane': {
        if (state.extraBallLit > 0) {
          pinballAddExtraBall(state);
          state.extraBallLit = 0;
        }
        // 킥백이 열려 있으면 공을 되쏜다 — 위쪽 물리에서 처리한다.
        addPinballScore(state, PINBALL_SCORES.outLane);
        pinballGoal(state, 'outLane', 'lane');
        break;
      }
      case 'returnlane': {
        const lit = rollover.side === 'left' ? state.lanes.warpLeft : state.lanes.warpRight;
        addPinballScore(state, PINBALL_SCORES.returnLane[lit ? 1 : 0]);
        if (lit) {
          if (rollover.side === 'left') state.lanes.warpLeft = false;
          else state.lanes.warpRight = false;
          state.bonusFlag = false;
        }
        pinballGoal(state, 'returnLane', 'lane');
        break;
      }
      case 'bonuslane': {
        if (state.lanes.bonusLit) {
          const added = addPinballSpecialScore(state, state.bonusScore);
          pinballInfo(state, `보너스!\n${added}`);
          state.lanes.bonusLit = false;
        } else {
          addPinballScore(state, PINBALL_SCORES.bonusLane);
          pinballInfo(state, '배에 연료 공급');
        }
        pinballRefuel(state, PINBALL_FUEL_MAX);
        pinballGoal(state, 'bonusLane', 'lane');
        break;
      }
      case 'spacewarp': {
        addPinballScore(state, PINBALL_SCORES.spaceWarp);
        state.lanes.warpLeft = true;
        state.lanes.warpRight = true;
        pinballGoal(state, 'spaceWarp', 'lane');
        break;
      }
      case 'fuel': {
        addPinballScore(state, PINBALL_SCORES.fuelLane);
        pinballRefuel(state, 2);
        pinballGoal(state, 'lane');
        break;
      }
      default:
        break;
    }
    pinballEvent(state, 'rollover', id);
  }

  // 낙하 표적 아홉 — 뱅크(셋)를 다 눕히면 뱅크마다 다른 상이 나온다.
  function hitPinballDropTarget(state, target) {
    if (state.dropped[target.id]) return;
    state.dropped[target.id] = true;
    const bank = PINBALL_DROP_TARGETS.filter((t) => t.bank === target.bank);
    const complete = bank.every((t) => state.dropped[t.id]);
    if (target.bank === 'booster') {
      addPinballScore(state, PINBALL_SCORES.boosterTarget[complete ? 1 : 0]);
      if (complete) awardPinballBooster(state);
    } else if (target.bank === 'medal') {
      if (complete) {
        const stage = Math.min(2, state.medalStage);
        addPinballScore(state, PINBALL_SCORES.medalTarget[stage === 2 ? 2 : stage + 1]);
        pinballInfo(state, ['1단계 보너스', '2단계 보너스', '3단계 보너스'][stage]);
        if (stage === 2) pinballAddExtraBall(state);
        state.medalStage = Math.min(2, state.medalStage + 1);
      } else {
        addPinballScore(state, PINBALL_SCORES.medalTarget[0]);
      }
    } else {
      addPinballScore(state, PINBALL_SCORES.multiplierTarget[complete ? 1 : 0]);
      if (complete) {
        state.multiplier = Math.min(4, state.multiplier + 1);
        pinballInfo(state, `공격 점수 ${PINBALL_MULTIPLIERS[state.multiplier]}배`);
      }
    }
    if (complete) for (const t of bank) state.dropped[t.id] = false;
    pinballEvent(state, 'drop-target', target.id);
    pinballGoal(state, 'dropTarget', 'anyTarget');
  }

  // 증폭 표적 뱅크의 상 — 깃발 → 잭팟 → 보너스 → 추가 보너스 순서.
  function awardPinballBooster(state) {
    switch (state.boosterStage) {
      case 0:
        state.flagsLit = 60;
        pinballInfo(state, '깃발 업그레이드');
        pinballGoal(state, 'flagUpgrade');
        break;
      case 1:
        state.jackpotFlag = true;
        pinballInfo(state, '잭팟 기회');
        break;
      case 2:
        state.bonusFlag = true;
        state.lanes.bonusLit = true;
        pinballInfo(state, '보너스 기회');
        break;
      default:
        pinballInfo(state, '추가 보너스 없음');
        break;
    }
    state.boosterStage = Math.min(3, state.boosterStage + 1);
  }

  // 고정 표적 열셋.
  function hitPinballSpotTarget(state, target) {
    if (state.spotLit[target.id]) return;
    state.spotLit[target.id] = true;
    const bank = PINBALL_SPOT_TARGETS.filter((t) => t.bank === target.bank);
    const complete = bank.every((t) => state.spotLit[t.id]);
    switch (target.bank) {
      case 'fuel':
        addPinballScore(state, PINBALL_SCORES.fuelTarget);
        if (complete) pinballRefuel(state, PINBALL_FUEL_MAX);
        break;
      case 'mission': {
        addPinballScore(state, PINBALL_SCORES.missionTarget);
        const level = bank.findIndex((t) => t.id === target.id) + 1;
        selectPinballMission(state, complete ? 4 : level);
        break;
      }
      case 'hazardL':
        addPinballScore(state, PINBALL_SCORES.hazardTarget);
        if (complete) {
          state.kickback.left = true;
          pinballInfo(state, '왼쪽 위험물 뱅크 채우기');
          pinballGoal(state, 'hazardL');
        }
        break;
      case 'hazardR':
        addPinballScore(state, PINBALL_SCORES.hazardTarget);
        if (complete) {
          state.kickback.right = true;
          pinballInfo(state, '오른쪽 위험물 뱅크 채우기');
          pinballGoal(state, 'hazardR');
        }
        break;
      default:
        addPinballScore(state, PINBALL_SCORES.destinationTarget);
        state.wormholeTarget = (state.wormholeTarget % 3) + 1;
        pinballInfo(state, '웜홀이 열림');
        break;
    }
    if (complete && target.bank !== 'destination') for (const t of bank) state.spotLit[t.id] = false;
    pinballEvent(state, 'spot-target', target.id);
    pinballGoal(state, 'spotTarget', 'anyTarget');
  }

  // 깃발(회전자). 업그레이드 중이면 점수가 다섯 배다.
  function hitPinballFlag(state, flag) {
    addPinballScore(state, PINBALL_SCORES.flag[state.flagsLit > 0 ? 1 : 0]);
    pinballEvent(state, 'flag', flag.id);
    pinballGoal(state, 'flag');
  }

  function hitPinballRebounder(state, rebounder) {
    addPinballScore(state, PINBALL_SCORES.rebounder);
    pinballEvent(state, 'rebounder', rebounder.id);
    pinballGoal(state, 'rebounder');
  }

  // 발사대(램프). 연속 맞히기 라이트가 켜져 있으면 큰 점수가 붙는다.
  function hitPinballRamp(state) {
    if (state.rampBonus > 0) {
      const added = addPinballSpecialScore(state, state.reflexShotScore);
      pinballInfo(state, `연속 맞히기 보너스\n${added}`);
      state.rampBonus = 0;
    } else {
      addPinballScore(state, PINBALL_SCORES.ramp);
    }
    pinballEvent(state, 'ramp');
    if (state.mission === 1 && state.missionPick) {
      startPinballMission(state);
      return;
    }
    // 시간 이동 2단계에서 발사대는 “앞으로 시간 이동” — 계급이 오른다.
    if (state.mission === 17 && state.missionStage === 1) {
      pinballInfo(state, '앞으로 시간 이동');
      if (state.rank < PINBALL_RANKS.length) state.rank += 1;
      pinballGoal(state, 'timeWarp');
      return;
    }
    pinballGoal(state, 'ramp');
  }

  // 하이퍼스페이스 구멍. 연속으로 넣을수록 상이 커진다 — 원작 HyperspaceKickOutControl.
  function enterPinballHyperspace(state) {
    const step = Math.min(4, state.hyperCount);
    switch (step) {
      case 0: {
        const added = addPinballScore(state, PINBALL_SCORES.hyperspace[0]);
        pinballInfo(state, `하이퍼스페이스 보너스\n${added}`);
        break;
      }
      case 1: {
        const added = addPinballSpecialScore(state, state.jackpotScore);
        pinballInfo(state, `잭팟\n${added}`);
        state.jackpotScore = 20000;
        break;
      }
      case 2: {
        state.centerPost = 20;
        const added = addPinballScore(state, PINBALL_SCORES.hyperspace[2]);
        pinballInfo(state, `중앙 고지\n${added}`);
        break;
      }
      case 3: {
        state.extraBallLit = 55;
        const added = addPinballScore(state, PINBALL_SCORES.hyperspace[3]);
        pinballInfo(state, `남아 있는 보너스 구슬\n${added}`);
        break;
      }
      default: {
        state.gravityWell = true;
        const added = addPinballScore(state, PINBALL_SCORES.hyperspace[4]);
        pinballInfo(state, `중력의 중심\n${added}`);
        state.hyperCount = -1;
        break;
      }
    }
    state.hyperCount += 1;
    pinballEvent(state, 'hyperspace', step);
    // 시간 이동 2단계에서 하이퍼스페이스는 “뒤로 시간 이동” — 계급이 내려간다.
    if (state.mission === 17 && state.missionStage === 1) {
      pinballInfo(state, '뒤로 시간 이동');
      demotePinballRank(state);
      pinballGoal(state, 'timeWarp');
      return;
    }
    pinballGoal(state, 'hyperspace');
  }

  // 웜홀 셋. 열린 웜홀에 넣으면 다시 쏘기가 붙고, 멀티볼 중에는 구슬이 갇힌다.
  function enterPinballWormhole(state, sink) {
    const index = PINBALL_WORMHOLES.findIndex((w) => w.id === sink.id);
    const open = state.wormholeTarget === index + 1;
    if (open) {
      state.wormholeTarget = 0;
      state.shootAgain = true;
      addPinballScore(state, PINBALL_SCORES.wormhole[1]);
      pinballInfo(state, '보너스 게임');
    } else {
      addPinballScore(state, PINBALL_SCORES.wormhole[state.wormholeTarget ? 2 : 0]);
      pinballInfo(state, '웜홀');
    }
    pinballEvent(state, 'wormhole', sink.color);
    const goals = ['wormhole'];
    if (sink.color === 'yellow') goals.push('wormholeYellow');
    if (sink.color === 'red') goals.push('wormholeRed');
    if (sink.color === 'green') goals.push('wormholeGreen');
    pinballGoal(state, ...goals);
  }

  function enterPinballBlackHole(state) {
    const added = addPinballScore(state, PINBALL_SCORES.blackHole);
    pinballInfo(state, `블랙홀\n${added}`);
    pinballEvent(state, 'blackhole');
    pinballGoal(state, 'blackhole');
  }

  function enterPinballGravityWell(state) {
    const added = addPinballScore(state, PINBALL_SCORES.gravityWell);
    pinballInfo(state, `중력 정상화\n${added}`);
    state.gravityWell = false;
    pinballEvent(state, 'gravitywell');
  }

  // 쏘기 기술 점수 — 슈트를 몇 칸이나 돌았는지로 값이 갈린다.
  function awardPinballSkillShot(state) {
    if (!state.skillShotArmed || state.skillShot < 1) return 0;
    const added = addPinballScore(state, PINBALL_SCORES.skillShot[Math.min(5, state.skillShot - 1)]);
    pinballInfo(state, `쏘기 기술 점수\n${added}`);
    state.skillShotArmed = false;
    pinballEvent(state, 'skill-shot', state.skillShot);
    return added;
  }
  // ── 물리 ──
  // 판을 위에서 내려다본 평면에서 푼다. 벽은 선분과 원호, 장치는 원이다.

  function createPinballBall(x, y) {
    return {
      x, y, vx: 0, vy: 0, radius: PINBALL_BALL_RADIUS,
      contacts: new Set(), inLane: true, inChute: false, hold: null, holeCooldown: 0, stuck: 0, angle: 0,
    };
  }

  // 선분에 부딪히면 튕긴다. 이미 멀어지는 공은 건드리지 않는다(같은 벽에 두 번 잡히면
  // 속도가 이상하게 커진다).
  function reflectBallFromSegment(ball, segment, restitution = 0.86) {
    const dx = segment.bx - segment.ax;
    const dy = segment.by - segment.ay;
    const lengthSquared = dx * dx + dy * dy;
    if (!lengthSquared) return false;
    const projection = ((ball.x - segment.ax) * dx + (ball.y - segment.ay) * dy) / lengthSquared;
    const amount = Math.max(0, Math.min(1, projection));
    const closestX = segment.ax + dx * amount;
    const closestY = segment.ay + dy * amount;
    const offsetX = ball.x - closestX;
    const offsetY = ball.y - closestY;
    const distance = Math.hypot(offsetX, offsetY);
    if (distance >= ball.radius) return false;
    const segmentLength = Math.sqrt(lengthSquared);
    const normalX = distance ? offsetX / distance : -dy / segmentLength;
    const normalY = distance ? offsetY / distance : dx / segmentLength;
    const incoming = ball.vx * normalX + ball.vy * normalY;
    if (incoming >= 0) return false;
    const push = ball.radius - distance;
    ball.x += normalX * push;
    ball.y += normalY * push;
    ball.vx -= (1 + restitution) * incoming * normalX;
    ball.vy -= (1 + restitution) * incoming * normalY;
    return true;
  }

  // 원(기둥·범퍼)과의 충돌. kick을 주면 튕긴 뒤 바깥으로 한 번 더 민다.
  function reflectBallFromCircle(ball, cx, cy, radius, restitution, kick = 0) {
    const offsetX = ball.x - cx;
    const offsetY = ball.y - cy;
    const distance = Math.hypot(offsetX, offsetY);
    const contact = ball.radius + radius;
    if (distance >= contact) return false;
    const normalX = distance ? offsetX / distance : 0;
    const normalY = distance ? offsetY / distance : -1;
    ball.x = cx + normalX * contact;
    ball.y = cy + normalY * contact;
    const incoming = ball.vx * normalX + ball.vy * normalY;
    if (incoming < 0) {
      ball.vx -= (1 + restitution) * incoming * normalX;
      ball.vy -= (1 + restitution) * incoming * normalY;
    }
    if (kick) {
      ball.vx += normalX * kick;
      ball.vy += normalY * kick;
    }
    return true;
  }

  // 원호 벽. inside면 공이 원 안쪽에 있고 바깥으로 나가지 못한다.
  function reflectBallFromArc(ball, arc) {
    const offsetX = ball.x - arc.cx;
    const offsetY = ball.y - arc.cy;
    const distance = Math.hypot(offsetX, offsetY);
    if (!distance) return false;
    const angle = Math.atan2(arc.cy - ball.y, ball.x - arc.cx);
    const normalized = angle < 0 ? angle + Math.PI * 2 : angle;
    if (normalized < arc.from || normalized > arc.to) return false;
    const overlap = arc.inside
      ? distance + ball.radius - arc.radius
      : arc.radius + ball.radius - distance;
    if (overlap <= 0) return false;
    const sign = arc.inside ? -1 : 1;
    const normalX = (offsetX / distance) * sign;
    const normalY = (offsetY / distance) * sign;
    const incoming = ball.vx * normalX + ball.vy * normalY;
    ball.x += normalX * overlap;
    ball.y += normalY * overlap;
    if (incoming < 0) {
      ball.vx -= (1 + arc.bounce) * incoming * normalX;
      ball.vy -= (1 + arc.bounce) * incoming * normalY;
    }
    return true;
  }

  // 플리퍼는 회전한다. 접점의 회전 속도까지 넣어야 “쳐 올리는” 느낌이 난다.
  //
  // 막대는 판 위에 붙어 있어서 공이 “아래로 빠져나갈” 자리가 없다. 2차원으로 풀면 공이
  // 막대 반대쪽으로 새서 그대로 드레인으로 떨어지는데, 원작에서는 일어나지 않는 일이다.
  // 그래서 닿은 공은 언제나 윗면으로 밀어낸다.
  function collidePinballFlipper(ball, flipper, motion) {
    const tipX = flipper.x + Math.cos(motion.angle) * FLIPPER_LENGTH;
    const tipY = flipper.y + Math.sin(motion.angle) * FLIPPER_LENGTH;
    const dx = tipX - flipper.x;
    const dy = tipY - flipper.y;
    const lengthSquared = dx * dx + dy * dy;
    const projection = ((ball.x - flipper.x) * dx + (ball.y - flipper.y) * dy) / lengthSquared;
    const amount = Math.max(0, Math.min(1, projection));
    const contactX = flipper.x + dx * amount;
    const contactY = flipper.y + dy * amount;
    const offsetX = ball.x - contactX;
    const offsetY = ball.y - contactY;
    const distance = Math.hypot(offsetX, offsetY);
    const contact = ball.radius + FLIPPER_RADIUS;
    if (distance >= contact) return false;
    // 막대 선을 기준으로 어느 쪽에 있는가. 왼쪽 막대는 음수, 오른쪽 막대는 양수가 윗면이다.
    const length = Math.sqrt(lengthSquared);
    const cross = (dx * offsetY - dy * offsetX) / length;
    const above = flipper.side === 'left' ? cross < 0 : cross > 0;
    let normalX;
    let normalY;
    if (!above || !distance) {
      // 아랫면으로 샌 공은 윗면으로 되돌린다.
      const sign = flipper.side === 'left' ? -1 : 1;
      normalX = (sign * -dy) / length;
      normalY = (sign * dx) / length;
    } else {
      normalX = offsetX / distance;
      normalY = offsetY / distance;
    }
    ball.x = contactX + normalX * contact;
    ball.y = contactY + normalY * contact;
    // 접점이 도는 속도 = ω × r.
    const armX = contactX - flipper.x;
    const armY = contactY - flipper.y;
    const surfaceX = -motion.omega * armY;
    const surfaceY = motion.omega * armX;
    const relativeX = ball.vx - surfaceX;
    const relativeY = ball.vy - surfaceY;
    const incoming = relativeX * normalX + relativeY * normalY;
    if (incoming >= 0) return true;
    const restitution = Math.abs(motion.omega) > 1 ? 0.55 : 0.32;
    ball.vx -= (1 + restitution) * incoming * normalX;
    ball.vy -= (1 + restitution) * incoming * normalY;
    return true;
  }

  // 원 안에 들어왔는지(롤오버·표적·구멍 판정). 같은 접촉 중에는 한 번만 걸린다.
  function ballEntered(ball, id, x, y, radius) {
    const inside = Math.hypot(ball.x - x, ball.y - y) < radius + ball.radius * 0.4;
    if (!inside) {
      ball.contacts.delete(id);
      return false;
    }
    if (ball.contacts.has(id)) return false;
    ball.contacts.add(id);
    return true;
  }

  // 원작 판에서는 범퍼가 진입할 때 한 번만 점수를 준다.
  function collideBumper(state, bumper) {
    const ball = state.balls[0];
    if (!ball) return false;
    if (!(ball.contacts instanceof Set)) ball.contacts = new Set();
    const touching = reflectBallFromCircle(ball, bumper.x, bumper.y, bumper.radius, 0.5, 260);
    if (!touching) {
      ball.contacts.delete(bumper.id);
      return false;
    }
    if (ball.contacts.has(bumper.id)) return false;
    ball.contacts.add(bumper.id);
    hitPinballBumper(state, bumper);
    return true;
  }

  // ── 구슬 공급과 발사 ──
  function pinballPlungerRest(state) {
    return { x: (LANE_LEFT + LANE_RIGHT) / 2, y: PINBALL_HEIGHT - 22 - state.plunger * 26 };
  }

  // 쏘기 레인에 새 구슬을 올린다.
  function feedPinballBall(state) {
    if (state.gameOver || state.balls.length) return false;
    const rest = pinballPlungerRest(state);
    state.balls.push(createPinballBall(rest.x, rest.y));
    state.skillShot = 0;
    state.skillShotArmed = true;
    state.reflexShotScore = 25000;
    state.rampBonus = 0;
    state.fuel = PINBALL_FUEL_MAX;
    state.fuelTimer = 0;
    if (state.mission === 0) {
      state.mission = 1;
      state.rank = Math.max(1, state.rank);
    }
    refreshPinballMission(state);
    state.status = 'awaiting';
    pinballEvent(state, 'ball-feed');
    return true;
  }

  // Space를 떼면 공이 나간다. power 0~1.
  function launchPinball(state, power = 0.7) {
    if (state.gameOver) return false;
    if (!state.balls.length && !feedPinballBall(state)) return false;
    const ball = state.balls[0];
    if (!ball.inLane) return false;
    const strength = Math.max(0.05, Math.min(1, Number(power) || 0));
    ball.vy = -(640 + strength * 380);
    ball.vx = 0;
    state.plunger = 0;
    state.status = 'playing';
    pinballEvent(state, 'plunge', strength);
    return true;
  }

  // ── 구슬이 빠졌을 때 ──
  // 원작 BallDrainControl: 멀티볼이면 개수만 줄이고, 마지막 구슬이면 추락 보너스를
  // 준 뒤 남은 구슬을 하나 깎는다.
  function drainPinballBall(state, ball) {
    // 우주 비행 훈련 판에는 멀티볼이 없다 — 원작에서도 멀티볼은 Full Tilt 전용이라
    // 웜홀에 넣으면 구슬을 가두는 대신 “다시 쏘기”가 붙는다.
    const index = state.balls.indexOf(ball);
    if (index >= 0) state.balls.splice(index, 1);
    if (state.balls.length) return;

    if (state.shootAgain) {
      state.shootAgain = false;
      pinballInfo(state, '다시 쏘기');
      resetPinballBallState(state, false);
      state.status = 'awaiting';
      feedPinballBall(state);
      return;
    }
    if (!state.tiltLock) {
      const added = addPinballSpecialScore(state, state.bonusScore);
      pinballInfo(state, `추락 보너스\n${added}`);
    }
    if (state.extraBalls > 0) {
      state.extraBalls -= 1;
      pinballInfo(state, '비행사 1 - 다시 쏘기');
      resetPinballBallState(state, false);
      state.status = 'awaiting';
      feedPinballBall(state);
      return;
    }
    state.ballsLeft -= 1;
    resetPinballBallState(state, true);
    if (state.ballsLeft <= 0) {
      state.ballsLeft = 0;
      state.gameOver = true;
      state.status = 'over';
      state.mission = 0;
      state.missionText = '게임 끝';
      pinballEvent(state, 'game-over', state.score);
      return;
    }
    state.status = 'awaiting';
    feedPinballBall(state);
  }

  // 구슬이 바뀔 때 꺼지는 것들 — 원작 BallDrainControl의 긴 초기화 목록과 같은 범위다.
  function resetPinballBallState(state, fullReset) {
    state.lanes = {};
    state.dropped = {};
    state.spotLit = {};
    state.bumperLevel = { attack: 0, launch: 0 };
    state.bumperTimer = { attack: 0, launch: 0 };
    state.hyperCount = 0;
    state.centerPost = 0;
    state.gravityWell = false;
    state.extraBallLit = 0;
    state.flagsLit = 0;
    state.rampBonus = 0;
    state.wormholeTarget = 0;
    state.kickback = { left: false, right: false };
    state.multiplier = 0;
    state.jackpotFlag = false;
    state.bonusFlag = false;
    state.tilt = 0;
    state.tiltLock = false;
    if (!fullReset) return;
    state.boosterStage = 0;
    state.medalStage = 0;
    state.rankProgress = 0;
    state.bonusScore = 25000;
    state.mission = 1;
    state.missionStage = 0;
    state.missionCount = 0;
    state.missionPick = 0;
    refreshPinballMission(state);
  }

  // ── 시간에 따라 꺼지는 것들 ──
  function tickPinballTimers(state, dt) {
    for (const group of ['attack', 'launch']) {
      if (state.bumperTimer[group] > 0) {
        state.bumperTimer[group] -= dt;
        if (state.bumperTimer[group] <= 0 && state.bumperLevel[group] > 0) {
          state.bumperLevel[group] -= 1;
          state.bumperTimer[group] = state.bumperLevel[group] > 0 ? 60 : 0;
        }
      }
    }
    for (const key of ['centerPost', 'extraBallLit', 'flagsLit', 'rampBonus']) {
      if (state[key] > 0) state[key] = Math.max(0, state[key] - dt);
    }
    if (state.infoText && state.time > state.infoUntil) state.infoText = '';

    // 연료는 임무 중에만 준다. 다 쓰면 임무가 취소된다.
    if (state.mission > 1 && state.balls.length) {
      state.fuelTimer += dt;
      while (state.fuelTimer >= PINBALL_FUEL_SECONDS && state.fuel > 0) {
        state.fuelTimer -= PINBALL_FUEL_SECONDS;
        state.fuel -= 1;
        if (state.fuel === 1) pinballInfo(state, '경고 - 연료가 거의 없음', 4);
        if (state.fuel === 0) abortPinballMission(state);
      }
    }
  }

  // 판을 흔든다. 너무 흔들면 반칙(TILT)이라 플리퍼가 죽는다.
  function nudgePinball(state, dirX, dirY = 0) {
    if (state.tiltLock || !state.balls.length) return false;
    for (const ball of state.balls) {
      ball.vx += dirX * 130;
      ball.vy += dirY * 130;
    }
    state.tilt += 1;
    if (state.tilt >= 4) {
      state.tiltLock = true;
      state.missionText = '반칙!';
      pinballEvent(state, 'tilt');
    } else {
      pinballInfo(state, '조심하세요...');
    }
    return true;
  }

  // ── 한 스텝 ──
  function stepPinball(state, seconds, controls = {}) {
    state.events.length = 0;
    const dt = Math.max(0, Math.min(1 / 30, seconds));
    if (!dt) return;
    state.time += dt;
    tickPinballTimers(state, dt);
    stepPinballFlippers(state, dt, controls);
    if (!state.balls.length || state.gameOver) return;

    let fastest = 0;
    for (const ball of state.balls) fastest = Math.max(fastest, Math.hypot(ball.vx, ball.vy));
    const substeps = Math.max(1, Math.min(16, Math.ceil((fastest * dt) / (PINBALL_BALL_RADIUS * 0.7))));
    const step = dt / substeps;
    for (let index = 0; index < substeps; index += 1) {
      for (const ball of state.balls.slice()) stepPinballBall(state, ball, step);
    }
  }

  function pinballFlipperMotion(state, flipper) {
    return state.flippers[flipper.id];
  }

  function stepPinballFlippers(state, dt, controls) {
    for (const flipper of PINBALL_FLIPPERS) {
      const motion = pinballFlipperMotion(state, flipper);
      const held = !state.tiltLock && (flipper.side === 'left' ? controls.left : controls.right);
      const target = held ? flipper.up : flipper.down;
      const duration = held ? FLIPPER_EXTEND : FLIPPER_RETRACT;
      const span = flipper.up - flipper.down;
      const speed = Math.abs(span) / duration;
      const delta = target - motion.angle;
      const move = Math.sign(delta) * Math.min(Math.abs(delta), speed * dt);
      motion.angle += move;
      motion.omega = dt > 0 ? move / dt : 0;
    }
  }

  function stepPinballBall(state, ball, dt) {
    // 구멍에 잡혀 있는 동안은 굴리지 않는다.
    if (ball.hold) {
      ball.hold.left -= dt;
      if (ball.hold.left > 0) return;
      // 구멍 한가운데서 그대로 놓으면 다음 칸에서 바로 다시 삼킨다 — 입구 밖으로 밀어낸다.
      const hole = ball.hold.hole;
      const dirX = Math.cos(hole.ejectAngle);
      const dirY = Math.sin(hole.ejectAngle);
      const clear = (hole.radius || 12) + ball.radius + 3;
      ball.x = hole.x + dirX * clear;
      ball.y = hole.y + dirY * clear;
      ball.vx = dirX * hole.ejectSpeed;
      ball.vy = dirY * hole.ejectSpeed;
      ball.hold = null;
      ball.holeCooldown = 0.6;
      ball.contacts.clear();
      return;
    }

    // 레인 안이면 플런저가 잡고 있는 동안 움직이지 않는다.
    if (ball.inLane && state.status !== 'playing') {
      const rest = pinballPlungerRest(state);
      ball.x = rest.x;
      ball.y = rest.y;
      ball.vx = 0;
      ball.vy = 0;
      return;
    }

    if (ball.holeCooldown > 0) ball.holeCooldown = Math.max(0, ball.holeCooldown - dt);
    // 원작 control::UnstuckBall — 어딘가에 껴서 안 움직이면 위로 한 번 밀어 준다.
    if (Math.hypot(ball.vx, ball.vy) < 26) {
      ball.stuck = (ball.stuck || 0) + dt;
      if (ball.stuck > 2.5) {
        ball.stuck = 0;
        ball.vy -= 260;
        ball.vx += (Math.random() - 0.5) * 160;
      }
    } else {
      ball.stuck = 0;
    }
    const speed = Math.hypot(ball.vx, ball.vy);
    // 원작 TTableLayer::FieldEffect — 중력에 아주 약한 저항과 흔들림을 섞는다.
    const jitter = (Math.random() - 0.5) * PINBALL_JITTER;
    ball.vx += (jitter * speed * PINBALL_DRAG - ball.vx * PINBALL_DRAG) * dt;
    ball.vy += (PINBALL_GRAVITY - ball.vy * PINBALL_DRAG) * dt;
    if (speed > PINBALL_MAX_SPEED) {
      ball.vx *= PINBALL_MAX_SPEED / speed;
      ball.vy *= PINBALL_MAX_SPEED / speed;
    }
    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;
    ball.angle += (speed * dt) / (ball.radius * Math.PI * 2);

    collidePinballWorld(state, ball);

    // 레인 바닥은 플런저다 — 약하게 쏴 되돌아온 공은 다시 얹고 쏠 수 있다.
    if (ball.x > LANE_LEFT && ball.y > PINBALL_HEIGHT - 44 && ball.vy >= 0) {
      const rest = pinballPlungerRest(state);
      ball.inLane = true;
      ball.inChute = false;
      ball.x = rest.x;
      ball.y = rest.y;
      ball.vx = 0;
      ball.vy = 0;
      ball.contacts.clear();
      state.skillShot = 0;
      if (state.status === 'playing') {
        state.status = 'awaiting';
        state.plunger = 0;
      }
      return;
    }

    if (ball.y > DRAIN_Y + ball.radius) drainPinballBall(state, ball);
  }
  // 슈트를 도는 동안 지나는 여섯 관문. 몇 개를 지났는지가 쏘기 기술 점수를 가른다.
  const PINBALL_SKILL_GATES = [0.25, 0.55, 0.85, 1.15, 1.45, 2.30];
  // 이 속도보다 느려지면 공이 슈트 안쪽 턱을 넘어 판으로 떨어진다.
  const PINBALL_CHUTE_HOLD = 300;
  // 발사대 입구 — 위로 충분히 빠르게 들어와야 램프를 탄다.
  const PINBALL_RAMP = { id: 'ramp', x: 240, y: 258, radius: 21, minSpeed: 220 };

  function pinballChuteAngle(ball) {
    const angle = Math.atan2(ARC_CY - ball.y, ball.x - ARC_CX);
    return angle < 0 ? angle + Math.PI * 2 : angle;
  }

  function collidePinballWorld(state, ball) {
    // ── 위쪽 슈트 ──
    const radial = Math.hypot(ball.x - ARC_CX, ball.y - ARC_CY);
    const inChuteBand = ball.y <= ARC_CY && radial > ARC_INNER - ball.radius && radial < ARC_OUTER + ball.radius;
    if (inChuteBand) {
      const angle = pinballChuteAngle(ball);
      // 지나온 관문 수를 센다.
      if (state.skillShotArmed) {
        let passed = 0;
        for (const gate of PINBALL_SKILL_GATES) if (angle >= gate) passed += 1;
        if (passed > state.skillShot) state.skillShot = passed;
      }
      ball.inLane = false;
      ball.inChute = true;
    } else if (ball.inChute) {
      ball.inChute = false;
      awardPinballSkillShot(state);
    }

    for (const wall of PINBALL_WALLS) {
      if (wall.kind === 'seg') {
        reflectBallFromSegment(ball, wall, wall.bounce);
      } else if (wall.kind === 'arc') {
        // 슈트 안쪽 벽은 턱일 뿐이다 — 느려진 공은 그대로 판 안으로 떨어진다.
        if (!wall.inside && wall.radius === ARC_INNER) {
          const tangential = Math.hypot(ball.vx, ball.vy);
          if (tangential < PINBALL_CHUTE_HOLD) continue;
        }
        reflectBallFromArc(ball, wall);
      }
    }

    // 반칙이 아니면 플리퍼가 공을 친다.
    for (const flipper of PINBALL_FLIPPERS) {
      collidePinballFlipper(ball, flipper, pinballFlipperMotion(state, flipper));
    }

    // 중앙 고지 — 하이퍼스페이스로 얻으면 플리퍼 사이를 잠시 막아 준다.
    if (state.centerPost > 0) {
      reflectBallFromCircle(ball, 190, PINBALL_HEIGHT - 34, 7, 0.5);
    }

    // 범퍼.
    for (const bumper of PINBALL_BUMPERS) {
      const touching = reflectBallFromCircle(ball, bumper.x, bumper.y, bumper.radius, 0.5, 300);
      if (!touching) {
        ball.contacts.delete(bumper.id);
        continue;
      }
      if (ball.contacts.has(bumper.id)) continue;
      ball.contacts.add(bumper.id);
      hitPinballBumper(state, bumper);
    }

    // 리바운드(플리퍼 위 튕김판).
    for (const rebounder of PINBALL_REBOUNDERS) {
      if (!reflectBallFromSegment(ball, rebounder, 1.15)) {
        ball.contacts.delete(rebounder.id);
        continue;
      }
      if (ball.contacts.has(rebounder.id)) continue;
      ball.contacts.add(rebounder.id);
      hitPinballRebounder(state, rebounder);
    }

    // 깃발(회전자) — 부딪히면 돌면서 공을 살짝 늦춘다.
    for (const flag of PINBALL_FLAGS) {
      if (!ballEntered(ball, flag.id, flag.x, flag.y, flag.radius)) continue;
      ball.vx *= 0.86;
      ball.vy *= 0.86;
      hitPinballFlag(state, flag);
    }

    // 낙하 표적 — 누워 있으면 그냥 지나간다.
    for (const target of PINBALL_DROP_TARGETS) {
      if (state.dropped[target.id]) continue;
      if (!collidePinballTarget(ball, target, 0.35)) {
        ball.contacts.delete(target.id);
        continue;
      }
      if (ball.contacts.has(target.id)) continue;
      ball.contacts.add(target.id);
      hitPinballDropTarget(state, target);
    }

    // 고정 표적 — 늘 서 있다.
    for (const target of PINBALL_SPOT_TARGETS) {
      if (!collidePinballTarget(ball, target, 0.55)) {
        ball.contacts.delete(target.id);
        continue;
      }
      if (ball.contacts.has(target.id)) continue;
      ball.contacts.add(target.id);
      hitPinballSpotTarget(state, target);
    }

    // 롤오버.
    for (const rollover of PINBALL_ROLLOVERS) {
      if (!ballEntered(ball, rollover.id, rollover.x, rollover.y, rollover.radius)) continue;
      hitPinballRollover(state, rollover);
      // 위험물 뱅크를 채워 둔 쪽 바깥 레인은 킥백이 공을 되쏜다.
      if (rollover.kind === 'outlane') {
        const side = rollover.side;
        if (state.kickback[side]) {
          state.kickback[side] = false;
          ball.vy = -980;
          ball.vx = side === 'left' ? 40 : -40;
          pinballEvent(state, 'kickback', side);
        }
      }
    }

    // 발사대 — 위로 빠르게 들어오면 램프를 타고 슈트 입구로 되돌아간다.
    if (ball.vy < -PINBALL_RAMP.minSpeed
        && Math.hypot(ball.x - PINBALL_RAMP.x, ball.y - PINBALL_RAMP.y) < PINBALL_RAMP.radius) {
      hitPinballRamp(state);
      ball.x = ARC_CX + (ARC_INNER + ARC_OUTER) / 2;
      ball.y = ARC_CY - 6;
      ball.vx = 0;
      ball.vy = -940;
      ball.contacts.clear();
      ball.holeCooldown = 0.4;
      state.rampBonus = 5;
      return;
    }

    if (ball.holeCooldown > 0) return;

    // 웜홀 셋.
    for (const sink of PINBALL_WORMHOLES) {
      if (Math.hypot(ball.x - sink.x, ball.y - sink.y) > sink.radius) continue;
      enterPinballWormhole(state, sink);
      ball.hold = {
        hole: { x: sink.x, y: sink.y, radius: sink.radius, ejectAngle: 1.25, ejectSpeed: 480 },
        left: 0.7,
      };
      ball.vx = 0;
      ball.vy = 0;
      return;
    }

    // 구멍 셋(하이퍼스페이스·블랙홀·중력의 중심).
    for (const hole of PINBALL_HOLES) {
      if (hole.id === 'gravitywell' && !state.gravityWell) continue;
      if (Math.hypot(ball.x - hole.x, ball.y - hole.y) > hole.radius) continue;
      if (hole.id === 'hyper') enterPinballHyperspace(state);
      else if (hole.id === 'blackhole') enterPinballBlackHole(state);
      else enterPinballGravityWell(state);
      ball.hold = { hole, left: hole.hold };
      ball.vx = 0;
      ball.vy = 0;
      return;
    }

  }

  // 표적은 짧은 선분이다. angle은 표적이 놓인 방향.
  function collidePinballTarget(ball, target, restitution) {
    const half = 11;
    const dx = Math.cos(target.angle) * half;
    const dy = Math.sin(target.angle) * half;
    return reflectBallFromSegment(ball, {
      ax: target.x - dx, ay: target.y - dy, bx: target.x + dx, by: target.y + dy,
    }, restitution);
  }

  function pinballInputEnabled(state) {
    return !state.paused && !state.hidden && !state.minimized && state.active;
  }

  function createAnimationLoop(onFrame, schedule, cancel) {
    let running = false;
    let requestId = null;
    let previousTime = null;
    function tick(time) {
      if (!running) return;
      if (previousTime !== null) onFrame(Math.max(0, Math.min(0.05, (time - previousTime) / 1000)));
      previousTime = time;
      requestId = schedule(tick);
    }
    return {
      start() {
        if (running) return;
        running = true;
        previousTime = null;
        requestId = schedule(tick);
      },
      stop() {
        running = false;
        previousTime = null;
        if (requestId !== null) cancel(requestId);
        requestId = null;
      },
      isRunning() { return running; },
    };
  }

  // ── 규칙 ──
  const CLOSED = 0;
  const OPEN = 1;
  const FLAG = 2;

  const BEGINNER = Object.freeze({ cols: 9, rows: 9, mines: 10 });

  function createBoard(preset) {
    const { cols, rows, mines } = preset || BEGINNER;
    const count = cols * rows;
    return {
      cols,
      rows,
      mines,
      mine: new Uint8Array(count),   // 지뢰 여부
      near: new Uint8Array(count),   // 인접 지뢰 수
      cell: new Uint8Array(count),   // CLOSED / OPEN / FLAG
      planted: false,
      status: 'ready',               // ready → playing → won | lost
      opened: 0,
      hit: -1,                       // 밟은 지뢰
    };
  }

  function neighbors(board, index) {
    const out = [];
    const x = index % board.cols;
    const y = Math.floor(index / board.cols);
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= board.cols || ny >= board.rows) continue;
        out.push(ny * board.cols + nx);
      }
    }
    return out;
  }

  /**
   * 첫 클릭은 지뢰가 아니다. 누른 칸과 그 이웃까지 비워 첫 수가 늘 넓게 열리게 한다 —
   * 한 칸만 열리고 끝나면 다음 수가 순전히 찍기가 된다. 빈 칸이 모자랄 만큼 지뢰가 많으면
   * 누른 칸 하나만 지킨다.
   */
  function plantMines(board, safeIndex, random) {
    const roll = random || Math.random;
    const count = board.cols * board.rows;
    let safe = new Set([safeIndex].concat(neighbors(board, safeIndex)));
    if (count - safe.size < board.mines) safe = new Set([safeIndex]);
    const pool = [];
    for (let i = 0; i < count; i += 1) if (!safe.has(i)) pool.push(i);
    const planted = Math.min(board.mines, pool.length);
    // Fisher-Yates를 앞에서 planted개만 돌린다.
    for (let i = 0; i < planted; i += 1) {
      const j = Math.min(pool.length - 1, i + Math.floor(roll() * (pool.length - i)));
      const swap = pool[i];
      pool[i] = pool[j];
      pool[j] = swap;
      board.mine[pool[i]] = 1;
    }
    for (let i = 0; i < count; i += 1) {
      let sum = 0;
      for (const n of neighbors(board, i)) sum += board.mine[n];
      board.near[i] = sum;
    }
    board.planted = true;
    return board;
  }

  function finished(board) {
    return board.status === 'won' || board.status === 'lost';
  }

  function reveal(board, index, random) {
    if (finished(board)) return board;
    if (board.cell[index] !== CLOSED) return board;
    if (!board.planted) {
      plantMines(board, index, random);
      board.status = 'playing';
    }
    if (board.mine[index]) {
      board.cell[index] = OPEN;
      board.hit = index;
      board.status = 'lost';
      return board;
    }
    // 0칸은 이웃까지 연쇄로 열린다. 재귀 대신 스택을 쓴다 — 큰 판에서 호출 스택이 터진다.
    // 깃발을 꽂아 둔 칸은 연쇄가 건너뛴다(CLOSED가 아니다).
    const stack = [index];
    while (stack.length) {
      const at = stack.pop();
      if (board.cell[at] !== CLOSED) continue;
      board.cell[at] = OPEN;
      board.opened += 1;
      if (board.near[at] === 0) {
        for (const n of neighbors(board, at)) if (board.cell[n] === CLOSED) stack.push(n);
      }
    }
    if (board.opened === board.cols * board.rows - board.mines) {
      board.status = 'won';
      // 이기면 남은 지뢰에 깃발이 저절로 꽂힌다. 남은 지뢰 표시가 0으로 떨어져야 판이
      // 끝난 것으로 보인다 — 다 찾았는데 카운터가 10에 멈춰 있으면 진 것처럼 읽힌다.
      for (let i = 0; i < board.cell.length; i += 1) if (board.mine[i]) board.cell[i] = FLAG;
    }
    return board;
  }

  function toggleFlag(board, index) {
    if (finished(board)) return board;
    if (board.cell[index] === OPEN) return board;
    board.cell[index] = board.cell[index] === FLAG ? CLOSED : FLAG;
    return board;
  }

  function flagCount(board) {
    let n = 0;
    for (const cell of board.cell) if (cell === FLAG) n += 1;
    return n;
  }

  // 화면의 왼쪽 카운터. 깃발을 지뢰 수보다 많이 꽂으면 음수가 된다 — 고전과 같다.
  function remainingMines(board) {
    return board.mines - flagCount(board);
  }

  /**
   * 열린 숫자 칸 주변에 깃발을 숫자만큼 꽂았으면 나머지 이웃을 한 번에 연다(코딩).
   * 깃발이 틀렸으면 그대로 지뢰를 밟는다 — 편의 기능이지 안전 장치가 아니다.
   */
  function chord(board, index, random) {
    if (finished(board)) return board;
    if (board.cell[index] !== OPEN || board.near[index] === 0) return board;
    const around = neighbors(board, index);
    let flags = 0;
    for (const n of around) if (board.cell[n] === FLAG) flags += 1;
    if (flags !== board.near[index]) return board;
    for (const n of around) if (board.cell[n] === CLOSED) reveal(board, n, random);
    return board;
  }

  // ── 그래픽 ──
  // 표정은 4가지다: 평소·누르는 중·승리·패배.
  const FACE_BODY = '<circle cx="10" cy="10" r="8.6" fill="#FFD93B" stroke="#000" stroke-width="1"/>';
  const FACE_EYES = '<circle cx="7" cy="7.6" r="1.15" fill="#000"/><circle cx="13" cy="7.6" r="1.15" fill="#000"/>';
  // 입은 2차 베지에로 그린다 — 호(arc)의 sweep 플래그보다 어느 쪽으로 휘는지가 눈에 보인다.
  const MOUTH_SMILE = '<path d="M5.9 10.9Q10 15 14.1 10.9" fill="none" stroke="#000" stroke-width="1.3" stroke-linecap="round"/>';
  const MOUTH_FROWN = '<path d="M5.9 14.2Q10 10.1 14.1 14.2" fill="none" stroke="#000" stroke-width="1.3" stroke-linecap="round"/>';
  const FACES = {
    smile: FACE_BODY + FACE_EYES + MOUTH_SMILE,
    press: FACE_BODY + FACE_EYES + '<circle cx="10" cy="12.4" r="2.1" fill="#000"/>',
    won: FACE_BODY
      + '<path d="M3.9 6.9h5.2v2.2a2.6 2.6 0 0 1-5.2 0zM10.9 6.9h5.2v2.2a2.6 2.6 0 0 1-5.2 0zM9.1 7.5h1.8v1H9.1z" fill="#000"/>'
      + MOUTH_SMILE,
    lost: FACE_BODY
      + '<path d="M5.4 6.1l2.6 2.6M8 6.1L5.4 8.7M12 6.1l2.6 2.6M14.6 6.1L12 8.7" stroke="#000" stroke-width="1.2" stroke-linecap="round"/>'
      + MOUTH_FROWN,
  };

  function faceSvg(state) {
    return `<svg viewBox="0 0 20 20" aria-hidden="true">${FACES[state] || FACES.smile}</svg>`;
  }

  // 지뢰: 스파이크 8개 위에 검은 공, 왼쪽 위에 반사광 한 점.
  const MINE_BODY = '<path d="M8 1.6v12.8M1.6 8h12.8M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="#000" stroke-width="1.5"/>'
    + '<circle cx="8" cy="8" r="4.5" fill="#000"/>'
    + '<rect x="5.7" y="5.7" width="1.8" height="1.8" fill="#fff"/>';
  const MINE_SVG = `<svg viewBox="0 0 16 16" aria-hidden="true">${MINE_BODY}</svg>`;

  // 깃발: 붉은 삼각기 + 검은 장대와 받침. 22px 칸 안에서도 형태가 읽히도록 두껍게 그린다.
  const FLAG_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true">'
    + '<path d="M8.5 1.7v6.4L2.2 4.9z" fill="#D41E1E"/>'
    + '<path d="M8.5 1.4v10.3" stroke="#000" stroke-width="1.8"/>'
    + '<path d="M6.1 11.3h4.8v1.6H6.1zM4 12.9h9v1.8H4z" fill="#000"/></svg>';

  // 잘못 꽂은 깃발: 패배 후에만 보인다. 지뢰가 아니었다는 뜻이므로 지뢰를 그대로 그리고
  // 그 위에 빨간 가위표를 친다 — 가위표만 있으면 무엇이 틀렸는지 알 수 없다.
  const WRONG_SVG = `<svg viewBox="0 0 16 16" aria-hidden="true">${MINE_BODY}`
    + '<path d="M2.2 2.2l11.6 11.6M13.8 2.2L2.2 13.8" stroke="#D41E1E" stroke-width="2.1" stroke-linecap="round"/></svg>';

  // 7세그먼트 카운터. 획 하나가 폴리곤 하나이고, 켜진 획만 class="on"을 받는다.
  const SEGMENT_POINTS = {
    a: '2,2.5 3.5,1 9.5,1 11,2.5 9.5,4 3.5,4',
    b: '11,2.5 12.5,4 12.5,10 11,11.5 9.5,10 9.5,4',
    c: '11,11.5 12.5,13 12.5,19 11,20.5 9.5,19 9.5,13',
    d: '2,20.5 3.5,19 9.5,19 11,20.5 9.5,22 3.5,22',
    e: '2,11.5 3.5,13 3.5,19 2,20.5 0.5,19 0.5,13',
    f: '2,2.5 3.5,4 3.5,10 2,11.5 0.5,10 0.5,4',
    g: '2,11.5 3.5,10 9.5,10 11,11.5 9.5,13 3.5,13',
  };
  const DIGIT_SEGMENTS = {
    0: 'abcdef', 1: 'bc', 2: 'abdeg', 3: 'abcdg', 4: 'bcfg',
    5: 'acdfg', 6: 'acdefg', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg', '-': 'g',
  };

  function digitSvg(ch) {
    const on = DIGIT_SEGMENTS[ch] || '';
    let polygons = '';
    for (const key of Object.keys(SEGMENT_POINTS)) {
      polygons += `<polygon points="${SEGMENT_POINTS[key]}" class="mine-seg${on.indexOf(key) >= 0 ? ' on' : ''}"/>`;
    }
    return `<svg class="mine-digit" viewBox="0 0 13 23" aria-hidden="true">${polygons}</svg>`;
  }

  // 세 자리 고정. 음수는 앞에 빼기표를 두고 두 자리만 보인다.
  function counterDigits(value) {
    if (value < 0) return `-${String(Math.min(99, -value)).padStart(2, '0')}`;
    return String(Math.min(999, value)).padStart(3, '0');
  }

  function counterHtml(value) {
    let html = '';
    for (const ch of counterDigits(value)) html += digitSvg(ch);
    return html;
  }

  const instances = new Map();
  const RANK_LABELS = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' };
  const SUIT_LABELS = { spades: '♠', hearts: '♥', diamonds: '♦', clubs: '♣' };
  const SUIT_NAMES = { spades: '스페이드', hearts: '하트', diamonds: '다이아몬드', clubs: '클럽' };

  function installGameStyles(doc) {
    if (doc.getElementById('clawadGameStyles')) return;
    const style = doc.createElement('style');
    style.id = 'clawadGameStyles';
    style.textContent = `
      .game-menu { display:flex; gap:0; min-height:25px; padding:1px 5px; align-items:center;
        background:#ece9d8; border-bottom:1px solid #aca899; box-shadow:inset 0 1px #fff; }
      .game-menu button { min-height:20px; padding:2px 8px; border:1px solid transparent;
        border-radius:0; background:transparent; box-shadow:none; }
      .game-menu button:hover { color:#fff; background:#316ac5; border-color:#316ac5; box-shadow:none; }
      /* 핀볼 — 왼쪽이 판, 오른쪽이 원작과 같은 계기판(백박스)이다. */
      .pinball-shell { display:grid; grid-template-columns:380px minmax(196px, 216px); justify-content:center;
        gap:6px; padding:8px; background:#05060f; overflow:auto; }
      .pinball-shell canvas { display:block; width:380px; max-width:100%; height:auto; align-self:start;
        border:2px ridge #b9c7d9; background:#05060f; outline:none; image-rendering:auto; }
      .pinball-shell canvas:focus { border-color:#f9c776; box-shadow:0 0 0 2px #003c74; }
      .pinball-panel { display:flex; flex-direction:column; gap:6px; min-width:190px; padding:7px;
        color:#e8eef8; background:linear-gradient(180deg,#2b3040,#171a24);
        border:2px ridge #8c9bad; font-family:Tahoma,'Malgun Gothic',sans-serif; }
      .pinball-brand { position:relative; padding:9px 8px 7px; text-align:center; border:2px inset #8391a4;
        background:radial-gradient(120% 120% at 30% 10%,#3d2b7a 0%,#1a1140 55%,#090616 100%); }
      .pinball-brand b { display:block; color:#cdb6ff; font-size:10px; letter-spacing:.18em; }
      .pinball-brand strong { display:block; margin-top:1px; color:#fff; font-size:19px; line-height:1.15;
        text-shadow:0 0 8px #8f6bff, 1px 1px 0 #3a2170; }
      .pinball-brand span { display:block; margin-top:2px; color:#9ef4ff; font-size:10px; letter-spacing:.1em; }
      .pinball-ballno { display:flex; align-items:center; justify-content:center; gap:6px; margin-top:7px;
        color:#ff6d5a; font-size:11px; font-weight:700; letter-spacing:.12em; }
      .pinball-ballno b { min-width:20px; padding:0 5px; color:#fff; background:#c02a22;
        border:1px solid #ff9d8f; font:700 14px/1.4 'Courier New',monospace; }
      .pinball-display { display:flex; align-items:baseline; justify-content:space-between; gap:6px;
        padding:6px 7px; color:#ffdc67; background:#020405; border:2px inset #8391a4;
        text-shadow:0 0 5px #e99c16; }
      .pinball-display small { color:#9eafbd; font-size:10px; }
      .pinball-display strong { font:700 19px/1.2 'Courier New',monospace; letter-spacing:1px; }
      .pinball-display [data-pinball-multiplier] { color:#7ef0ff; font-size:10px; font-weight:700; }
      .pinball-panel [data-pinball-info] { min-height:30px; padding:5px 7px; color:#ffd166; background:#08111d;
        border:1px inset #72839a; font-size:10.5px; line-height:1.45; white-space:pre-line; }
      .pinball-panel [data-pinball-status] { flex:1; min-height:54px; padding:6px 7px; color:#9ef4ff;
        background:#08111d; border:1px inset #72839a; font-size:11.5px; line-height:1.5; white-space:pre-line; }
      .pinball-launch { width:100%; margin:0; padding:5px 4px; }
      .pinball-keys { margin:0; font-size:10px; line-height:1.35; }
      .pinball-keys div { display:flex; justify-content:space-between; gap:6px; padding:3px 0;
        border-top:1px solid #40516a; }
      .pinball-keys dt { color:#9eafbd; }
      .pinball-keys dd { margin:0; color:#fff; font-weight:700; }
      .pinball-keyboard-note { display:none; margin:12px; padding:14px; color:#000; background:#ffffe1;
        border:1px solid #000; border-radius:5px; }
      .solitaire-shell { position:relative; min-width:700px; min-height:520px; padding:12px 14px 30px;
        overflow:auto; color:#fff; background:#087b38; border-top:1px solid #0b4f29;
        box-shadow:inset 0 0 55px rgba(0,0,0,.16); user-select:none; }
      .solitaire-top { display:grid; grid-template-columns:72px 72px 1fr repeat(4,72px); gap:15px; margin-bottom:20px; }
      .solitaire-top > div { position:relative; width:72px; height:96px; }
      .solitaire-columns { display:grid; grid-template-columns:repeat(7,72px); justify-content:space-between; gap:15px; }
      .solitaire-column { position:relative; min-height:360px; border-radius:5px; }
      .solitaire-slot { position:relative; width:72px; height:96px; padding:0; border:2px solid rgba(220,255,225,.52);
        border-radius:5px; background:rgba(0,70,25,.2); color:rgba(235,255,235,.7); font:700 32px/90px Georgia,serif;
        text-align:center; box-shadow:inset 1px 1px 3px rgba(0,0,0,.25); }
      button.solitaire-slot:hover { box-shadow:inset 0 0 0 2px rgba(255,255,255,.6); }
      .solitaire-card { position:absolute; left:0; width:72px; height:96px; min-height:0; padding:4px 5px;
        overflow:hidden; border:1px solid #222; border-radius:5px; background:#fffdf4; color:#111;
        box-shadow:1px 2px 3px rgba(0,0,0,.38); font:700 17px/1 Georgia,'Times New Roman',serif; text-align:left; }
      .solitaire-card.red { color:#c71824; }
      .solitaire-card.face-down { color:transparent; border:3px double #f7f8ff;
        background-color:#123f9b; background-image:repeating-linear-gradient(45deg,rgba(255,255,255,.32) 0 2px,transparent 2px 7px),
          repeating-linear-gradient(-45deg,rgba(80,165,255,.45) 0 2px,transparent 2px 7px); }
      .solitaire-card:hover { z-index:60!important; box-shadow:0 0 0 2px #f9c776,2px 3px 4px rgba(0,0,0,.45); }
      .solitaire-card.selected { z-index:70!important; box-shadow:0 0 0 3px #ffd24a,2px 4px 5px rgba(0,0,0,.5); transform:translateY(-2px); }
      .solitaire-rank { display:block; }
      .solitaire-suit { display:block; margin-top:2px; font-size:21px; }
      .solitaire-status { position:absolute; left:0; right:0; bottom:0; height:23px; display:flex;
        align-items:center; justify-content:space-between; gap:12px; padding:2px 8px; color:#000; background:#ece9d8;
        border-top:2px ridge #fff; font-size:11px; }
      .solitaire-win { position:absolute; inset:0; z-index:100; display:grid; place-items:center; pointer-events:none;
        color:#fff; background:rgba(0,60,20,.28); font-size:30px; font-weight:700; text-shadow:2px 2px #003c1b; }
      .solitaire-win span { padding:18px 28px; border:3px double #fff; background:#0a823d;
        box-shadow:3px 4px 10px rgba(0,0,0,.45); animation:solitaire-win-bounce .8s ease-in-out infinite alternate; }
      @keyframes solitaire-win-bounce { to { transform:translateY(-12px) scale(1.03); } }
      @media (max-width:640px) {
        .win-pinball .pinball-shell { display:block; background:#ece9d8; }
        .win-pinball .pinball-shell canvas, .win-pinball .pinball-panel > :not(.pinball-keyboard-note) { display:none; }
        .win-pinball .pinball-panel { min-height:120px; color:#000; background:#ece9d8; border:0; }
        .win-pinball .pinball-keyboard-note { display:block; }
      }
      @media (prefers-reduced-motion: reduce) {
        .solitaire-win span { animation:none; }
      }
    `;
    doc.head.appendChild(style);
  }

  function cardLabel(card) {
    const rank = RANK_LABELS[card.rank] || String(card.rank);
    return `${SUIT_NAMES[card.suit]} ${rank}`;
  }

  function sameSource(first, second) {
    return Boolean(first && second && first.zone === second.zone && first.column === second.column && first.index === second.index);
  }

  function sourceFromElement(element) {
    if (!element?.dataset.zone || element.dataset.zone === 'stock') return null;
    const source = { zone: element.dataset.zone };
    if (element.dataset.column !== undefined) source.column = Number(element.dataset.column);
    if (element.dataset.index !== undefined) source.index = Number(element.dataset.index);
    return source;
  }

  function cardMarkup(card, source, top, selected) {
    const classes = ['solitaire-card'];
    if (!card.faceUp) classes.push('face-down');
    else if (isRed(card)) classes.push('red');
    if (sameSource(source, selected)) classes.push('selected');
    const attributes = [
      `data-zone="${source.zone}"`,
      source.column === undefined ? '' : `data-column="${source.column}"`,
      source.index === undefined ? '' : `data-index="${source.index}"`,
      card.faceUp ? 'draggable="true"' : 'draggable="false"',
      `aria-label="${card.faceUp ? cardLabel(card) : '뒤집힌 카드'}"`,
      `style="top:${top}px;z-index:${10 + (source.index || 0)}"`,
    ].filter(Boolean).join(' ');
    const face = card.faceUp
      ? `<span class="solitaire-rank">${RANK_LABELS[card.rank] || card.rank}</span><span class="solitaire-suit">${SUIT_LABELS[card.suit]}</span>`
      : '<span aria-hidden="true">◆</span>';
    return `<button type="button" class="${classes.join(' ')}" ${attributes}>${face}</button>`;
  }

  function solitaireElapsed(instance) {
    const active = instance.runningSince === null ? 0 : Date.now() - instance.runningSince;
    return Math.floor((instance.elapsedMs + active) / 1000);
  }

  function updateSolitaireStatus(instance) {
    const status = instance.root.querySelector('.solitaire-status');
    if (!status) return;
    const seconds = solitaireElapsed(instance);
    const time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    status.innerHTML = `<span>${instance.message || '카드를 선택한 뒤 목적지를 누르세요.'}</span><span>이동: ${instance.state.moves}　시간: ${time}</span>`;
  }

  function tableauCardOffsets(column) {
    let top = 0;
    return column.map((card, index) => {
      const offset = top;
      if (index < column.length - 1) top += card.faceUp ? 27 : 16;
      return offset;
    });
  }

  function renderSolitaire(instance) {
    const { state, selected } = instance;
    const stock = state.stock.at(-1);
    const waste = state.waste.at(-1);
    const foundations = state.foundations.map((pile, column) => {
      const card = pile.at(-1);
      return `<div>${card
        ? cardMarkup(card, { zone: 'foundation', column, index: pile.length - 1 }, 0, selected)
        : `<button type="button" class="solitaire-slot" data-target-zone="foundation" data-column="${column}" aria-label="빈 파운데이션">A</button>`}</div>`;
    }).join('');
    const columns = state.tableau.map((column, columnIndex) => {
      const offsets = tableauCardOffsets(column);
      const cards = column.map((card, index) => cardMarkup(
        card,
        { zone: 'tableau', column: columnIndex, index },
        offsets[index],
        selected,
      )).join('');
      return `<div class="solitaire-column" data-target-zone="tableau" data-column="${columnIndex}" aria-label="테이블 ${columnIndex + 1}열">
        ${cards || `<button type="button" class="solitaire-slot solitaire-empty-column" data-target-zone="tableau" data-column="${columnIndex}" aria-label="빈 테이블 ${columnIndex + 1}열, 킹을 놓을 수 있습니다">K</button>`}
      </div>`;
    }).join('');
    instance.root.innerHTML = `
      <div class="solitaire-top">
        <div>${stock
          ? cardMarkup(stock, { zone: 'stock', index: state.stock.length - 1 }, 0, null)
          : '<button type="button" class="solitaire-slot" data-zone="stock" aria-label="웨이스트 다시 덮기">↺</button>'}</div>
        <div>${waste
          ? cardMarkup(waste, { zone: 'waste', index: state.waste.length - 1 }, 0, selected)
          : '<span class="solitaire-slot" aria-label="빈 웨이스트"></span>'}</div>
        <span></span>${foundations}
      </div>
      <div class="solitaire-columns">${columns}</div>
      <div class="solitaire-status" role="status" aria-live="polite"></div>
      ${state.won ? '<div class="solitaire-win" role="status"><span>게임 성공!</span></div>' : ''}`;
    updateSolitaireStatus(instance);
  }

  function solitaireSourceSelectable(instance, source) {
    if (!source) return false;
    if (source.zone === 'waste') return source.index === instance.state.waste.length - 1;
    if (source.zone === 'foundation') return source.index === instance.state.foundations[source.column].length - 1;
    if (source.zone === 'tableau') return Boolean(instance.state.tableau[source.column]?.[source.index]?.faceUp);
    return false;
  }

  function moveSolitaireSelection(instance, targetZone, targetColumn) {
    const source = instance.selected;
    if (!source) return false;
    if (targetZone === 'foundation') {
      if (source.zone === 'tableau' && source.index !== instance.state.tableau[source.column].length - 1) return false;
      return moveCardToFoundation(instance.state, source, targetColumn);
    }
    if (targetZone !== 'tableau') return false;
    if (source.zone === 'tableau') {
      return moveTableauRun(instance.state, source.column, source.index, targetColumn);
    }
    return moveCardToTableau(instance.state, source, targetColumn);
  }

  function handleSolitaireClick(instance, event) {
    const target = event.target.closest('[data-zone], [data-target-zone]');
    if (!target || !instance.root.contains(target)) return;
    if (target.dataset.zone === 'stock') {
      drawStock(instance.state);
      instance.selected = null;
      instance.message = '';
      renderSolitaire(instance);
      return;
    }
    const source = sourceFromElement(target);
    const targetZone = target.dataset.targetZone || target.dataset.zone;
    const targetColumn = Number(target.dataset.column);
    if (instance.selected && !sameSource(instance.selected, source)
        && (targetZone === 'tableau' || targetZone === 'foundation')) {
      if (moveSolitaireSelection(instance, targetZone, targetColumn)) {
        instance.selected = null;
        instance.message = '';
        renderSolitaire(instance);
        return;
      }
      instance.message = '규칙에 맞지 않는 이동입니다.';
    }
    if (solitaireSourceSelectable(instance, source)) instance.selected = source;
    renderSolitaire(instance);
  }

  function handleSolitaireDoubleClick(instance, event) {
    const target = event.target.closest('.solitaire-card');
    const source = sourceFromElement(target);
    if (!solitaireSourceSelectable(instance, source)) return;
    if (source.zone === 'tableau' && source.index !== instance.state.tableau[source.column].length - 1) return;
    if (!autoMoveToFoundation(instance.state, source)) return;
    instance.selected = null;
    instance.message = '';
    renderSolitaire(instance);
  }

  function handleSolitaireDragStart(instance, event) {
    const source = sourceFromElement(event.target.closest('.solitaire-card'));
    if (!solitaireSourceSelectable(instance, source)) { event.preventDefault(); return; }
    instance.selected = source;
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', 'solitaire-card');
    }
  }

  function handleSolitaireDrop(instance, event) {
    const target = event.target.closest('[data-target-zone], [data-zone="foundation"]');
    if (!target) return;
    event.preventDefault();
    if (moveSolitaireSelection(instance, target.dataset.targetZone || target.dataset.zone, Number(target.dataset.column))) {
      instance.selected = null;
      instance.message = '';
    } else {
      instance.message = '그곳에는 놓을 수 없습니다.';
    }
    renderSolitaire(instance);
  }

  function resetSolitaire(instance) {
    instance.state = dealKlondike();
    instance.selected = null;
    instance.message = '';
    instance.elapsedMs = 0;
    instance.runningSince = instance.paused ? null : Date.now();
    renderSolitaire(instance);
  }

  function mountSolitaire(root) {
    const instance = {
      type: 'solitaire', root, state: dealKlondike(), selected: null, message: '',
      elapsedMs: 0, runningSince: null, timerId: null, paused: true,
    };
    instance.onClick = (event) => handleSolitaireClick(instance, event);
    instance.onDoubleClick = (event) => handleSolitaireDoubleClick(instance, event);
    instance.onDragStart = (event) => handleSolitaireDragStart(instance, event);
    instance.onDragOver = (event) => { if (instance.selected) event.preventDefault(); };
    instance.onDrop = (event) => handleSolitaireDrop(instance, event);
    instance.onCommand = (event) => {
      const command = event.target.dataset.gameCommand;
      if (command === 'new-solitaire') resetSolitaire(instance);
      if (command === 'help-solitaire') {
        instance.message = '검정·빨강을 번갈아 내림차순으로 놓고, A부터 같은 무늬를 올리세요.';
        updateSolitaireStatus(instance);
      }
    };
    root.addEventListener('click', instance.onClick);
    root.addEventListener('dblclick', instance.onDoubleClick);
    root.addEventListener('dragstart', instance.onDragStart);
    root.addEventListener('dragover', instance.onDragOver);
    root.addEventListener('drop', instance.onDrop);
    instance.section = root.closest('.win');
    instance.section.addEventListener('click', instance.onCommand);
    renderSolitaire(instance);
    return instance;
  }

  // ══ 판 그리기 ══
  // 원작은 미리 그려 둔 비트맵을 깔았다. 우리는 같은 배치를 좌표로 들고 있으니 매 프레임
  // 캔버스에 그린다. 바닥·레일처럼 안 변하는 것은 한 번 그려 캐시에 담아 두고, 공·불빛만
  // 새로 얹는다.

  const PB_INK = {
    rail: '#8f9fc4',
    railLight: '#cfd9f2',
    magenta: '#b8318f',
    amber: '#ffc63f',
    red: '#e8443a',
    green: '#3fc45f',
    steel: '#9aa4bd',
  };

  // 원근을 씌운 점.
  function pbPoint(tx, ty) {
    return projectPinball(tx, ty);
  }

  function pbMoveTo(ctx, tx, ty) {
    const point = pbPoint(tx, ty);
    ctx.moveTo(point.x, point.y);
  }

  function pbLineTo(ctx, tx, ty) {
    const point = pbPoint(tx, ty);
    ctx.lineTo(point.x, point.y);
  }

  // 판 좌표의 원은 화면에서 살짝 눌린 타원이 된다.
  function pbEllipse(ctx, tx, ty, radius) {
    const center = pbPoint(tx, ty);
    const top = pbPoint(tx, ty - radius);
    const bottom = pbPoint(tx, ty + radius);
    ctx.ellipse(center.x, center.y, radius * center.scale, Math.abs(bottom.y - top.y) / 2, 0, 0, Math.PI * 2);
  }

  function pbFillCircle(ctx, tx, ty, radius, fill) {
    ctx.beginPath();
    pbEllipse(ctx, tx, ty, radius);
    ctx.fillStyle = fill;
    ctx.fill();
  }

  function pbStrokeArc(ctx, cx, cy, radius, from, to, steps = 48) {
    ctx.beginPath();
    for (let index = 0; index <= steps; index += 1) {
      const angle = from + ((to - from) * index) / steps;
      const tx = cx + Math.cos(angle) * radius;
      const ty = cy - Math.sin(angle) * radius;
      if (index === 0) pbMoveTo(ctx, tx, ty); else pbLineTo(ctx, tx, ty);
    }
    ctx.stroke();
  }

  // 판 바깥 테두리(바닥 채우기용 경로).
  function pinballOutlinePath(ctx) {
    ctx.beginPath();
    for (let index = 0; index <= 72; index += 1) {
      const angle = Math.PI - (Math.PI * index) / 72;
      pbLineToArc(ctx, angle, ARC_OUTER, index === 0);
    }
    pbLineTo(ctx, ARC_CX + ARC_OUTER, PINBALL_HEIGHT);
    pbLineTo(ctx, ARC_CX - ARC_OUTER, PINBALL_HEIGHT);
    ctx.closePath();
  }

  function pbLineToArc(ctx, angle, radius, move) {
    const tx = ARC_CX + Math.cos(angle) * radius;
    const ty = ARC_CY - Math.sin(angle) * radius;
    if (move) pbMoveTo(ctx, tx, ty); else pbLineTo(ctx, tx, ty);
  }

  // ── 안 변하는 바닥 ──
  function paintPinballField(ctx) {
    ctx.save();
    ctx.clearRect(0, 0, PINBALL_VIEW_WIDTH, PINBALL_VIEW_HEIGHT);
    ctx.fillStyle = '#04050c';
    ctx.fillRect(0, 0, PINBALL_VIEW_WIDTH, PINBALL_VIEW_HEIGHT);

    pinballOutlinePath(ctx);
    ctx.save();
    ctx.clip();
    const felt = ctx.createLinearGradient(0, 0, 0, PINBALL_VIEW_HEIGHT);
    felt.addColorStop(0, '#332561');
    felt.addColorStop(0.42, '#20184a');
    felt.addColorStop(1, '#0c0a22');
    ctx.fillStyle = felt;
    ctx.fillRect(0, 0, PINBALL_VIEW_WIDTH, PINBALL_VIEW_HEIGHT);
    paintPinballArtwork(ctx);
    ctx.restore();

    // 판 테두리 금속 레일.
    pinballOutlinePath(ctx);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#2b3350';
    ctx.lineWidth = 9;
    ctx.stroke();
    ctx.strokeStyle = PB_INK.rail;
    ctx.lineWidth = 3.4;
    ctx.stroke();
    ctx.strokeStyle = PB_INK.railLight;
    ctx.lineWidth = 1;
    ctx.stroke();

    paintPinballChute(ctx);
    paintPinballRails(ctx);
    ctx.restore();
  }

  // 위쪽 함대 배치 슈트와 오른쪽 구슬 쏘기 레인 — 공이 지나는 골이다.
  function paintPinballChute(ctx) {
    const mid = (ARC_INNER + ARC_OUTER) / 2;
    ctx.save();
    // 골 바닥.
    ctx.beginPath();
    for (let index = 0; index <= 60; index += 1) {
      pbLineToArc(ctx, (ARC_OUTER_END * index) / 60, ARC_OUTER, index === 0);
    }
    for (let index = 60; index >= 0; index -= 1) {
      pbLineToArc(ctx, (ARC_INNER_END * index) / 60, ARC_INNER, false);
    }
    ctx.closePath();
    const ramp = ctx.createLinearGradient(0, 0, PINBALL_VIEW_WIDTH, 0);
    ramp.addColorStop(0, '#2c3557');
    ramp.addColorStop(0.5, '#454f74');
    ramp.addColorStop(1, '#2c3557');
    ctx.fillStyle = ramp;
    ctx.fill();

    // 쏘기 레인.
    ctx.beginPath();
    pbMoveTo(ctx, LANE_LEFT, ARC_CY);
    pbLineTo(ctx, LANE_RIGHT, ARC_CY);
    pbLineTo(ctx, LANE_RIGHT, PINBALL_HEIGHT);
    pbLineTo(ctx, LANE_LEFT, PINBALL_HEIGHT);
    ctx.closePath();
    ctx.fillStyle = '#333c5e';
    ctx.fill();

    // 골 양쪽 레일.
    ctx.lineCap = 'round';
    for (const pass of [{ width: 5, color: '#1c2138' }, { width: 2, color: PB_INK.rail }]) {
      ctx.strokeStyle = pass.color;
      ctx.lineWidth = pass.width;
      pbStrokeArc(ctx, ARC_CX, ARC_CY, ARC_OUTER, 0, ARC_OUTER_END);
      pbStrokeArc(ctx, ARC_CX, ARC_CY, ARC_INNER, 0, ARC_INNER_END);
      ctx.beginPath();
      pbMoveTo(ctx, LANE_LEFT, ARC_CY);
      pbLineTo(ctx, LANE_LEFT, PINBALL_HEIGHT);
      ctx.stroke();
      ctx.beginPath();
      pbMoveTo(ctx, LANE_RIGHT, ARC_CY);
      pbLineTo(ctx, LANE_RIGHT, PINBALL_HEIGHT);
      ctx.stroke();
    }
    // 슈트 진행 방향 화살표.
    ctx.fillStyle = 'rgba(158,244,255,.35)';
    for (const angle of [0.2, 0.9, 1.6, 2.3]) {
      const point = pbPoint(ARC_CX + Math.cos(angle) * mid, ARC_CY - Math.sin(angle) * mid);
      ctx.save();
      ctx.translate(point.x, point.y);
      ctx.rotate(-angle - Math.PI / 2);
      ctx.beginPath();
      ctx.moveTo(0, -5);
      ctx.lineTo(4, 3);
      ctx.lineTo(-4, 3);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }

  // 판에 인쇄된 그림 — 별, 좌우 날개, 가운데 계급 원판, 레인 안내.
  function paintPinballArtwork(ctx) {
    let seed = 20250824;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let index = 0; index < 190; index += 1) {
      const point = pbPoint(random() * PINBALL_WIDTH, random() * PINBALL_HEIGHT);
      const size = random() < 0.14 ? 1.9 : 0.9;
      ctx.fillStyle = `rgba(214,232,255,${0.2 + random() * 0.55})`;
      ctx.fillRect(point.x, point.y, size, size);
    }

    // 왼쪽 보라 엔진 날개.
    pbPolygon(ctx, [[34, 244], [126, 300], [116, 424], [46, 432]], 'rgba(112,58,168,.6)');
    pbPolygon(ctx, [[44, 262], [112, 306], [104, 410], [52, 416]], 'rgba(147,86,208,.34)');
    // 오른쪽 자홍 날개.
    pbPolygon(ctx, [[330, 262], [252, 312], [262, 424], [330, 432]], 'rgba(184,49,143,.5)');
    pbPolygon(ctx, [[320, 280], [264, 320], [272, 412], [320, 418]], 'rgba(220,84,178,.28)');
    // 위쪽 청록 삼각(임무 표적 자리).
    pbPolygon(ctx, [[182, 178], [262, 226], [190, 240]], 'rgba(19,169,189,.35)');
    // 플리퍼 위 자홍 삼각.
    pbPolygon(ctx, [[100, 406], [122, 448], [92, 452]], 'rgba(198,52,152,.75)');
    pbPolygon(ctx, [[280, 406], [258, 448], [288, 452]], 'rgba(198,52,152,.75)');

    // 가운데 계급 원판.
    const glow = pbPoint(190, 392);
    const halo = ctx.createRadialGradient(glow.x, glow.y, 3, glow.x, glow.y, 78);
    halo.addColorStop(0, 'rgba(64,232,248,.68)');
    halo.addColorStop(0.5, 'rgba(19,169,189,.3)');
    halo.addColorStop(1, 'rgba(10,95,109,0)');
    ctx.fillStyle = halo;
    ctx.beginPath();
    pbEllipse(ctx, 190, 392, 80);
    ctx.fill();
    ctx.strokeStyle = 'rgba(140,236,248,.55)';
    for (const radius of [64, 50, 30, 16]) {
      ctx.lineWidth = radius === 64 ? 1.8 : 1;
      ctx.beginPath();
      pbEllipse(ctx, 190, 392, radius);
      ctx.stroke();
    }
    // 눈금.
    ctx.strokeStyle = 'rgba(140,236,248,.35)';
    ctx.lineWidth = 1;
    for (let index = 0; index < 24; index += 1) {
      const angle = (index / 24) * Math.PI * 2;
      ctx.beginPath();
      pbMoveTo(ctx, 190 + Math.cos(angle) * 50, 392 + Math.sin(angle) * 50);
      pbLineTo(ctx, 190 + Math.cos(angle) * 64, 392 + Math.sin(angle) * 64);
      ctx.stroke();
    }

    // 레인 자리에 깔린 색판(인서트). 원작 판에도 라이트마다 색판이 깔려 있다.
    for (const [tx, ty, w, h, angle, fill] of [
      [76, 174, 78, 30, -0.62, 'rgba(19,169,189,.3)'],     // 재돌입 레인
      [310, 238, 40, 60, 0, 'rgba(255,198,63,.22)'],        // 발사 레인
      [68, 476, 26, 76, 0, 'rgba(232,68,58,.26)'],          // 왼쪽 바깥 레인
      [312, 476, 26, 76, 0, 'rgba(232,68,58,.26)'],         // 오른쪽 바깥 레인
      [102, 452, 26, 52, 0, 'rgba(19,169,189,.26)'],        // 왼쪽 리턴 레인
      [278, 452, 26, 52, 0, 'rgba(19,169,189,.26)'],        // 오른쪽 리턴 레인
      [190, 430, 34, 34, 0, 'rgba(63,196,95,.26)'],         // 보너스(연료 슈트) 레인
      [86, 312, 26, 60, 0, 'rgba(63,196,95,.24)'],          // 왼쪽 연료 레인
      [237, 312, 26, 60, 0, 'rgba(63,196,95,.24)'],         // 오른쪽 연료 레인
      [92, 392, 44, 68, 0.2, 'rgba(255,198,63,.2)'],        // 증폭 표적 뱅크
      [302, 392, 44, 68, -0.2, 'rgba(255,198,63,.2)'],      // 포상 표적 뱅크
      [265, 172, 76, 44, 0.35, 'rgba(184,49,143,.28)'],     // 배수 표적 뱅크
      [122, 368, 30, 62, 0, 'rgba(19,169,189,.24)'],        // 연료 표적
    ]) {
      ctx.save();
      const center = pbPoint(tx, ty);
      ctx.translate(center.x, center.y);
      ctx.rotate(angle);
      ctx.fillStyle = fill;
      const halfW = (w / 2) * center.scale;
      const halfH = (h / 2) * center.scale * 0.92;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(-halfW, -halfH, halfW * 2, halfH * 2, 6);
      else ctx.rect(-halfW, -halfH, halfW * 2, halfH * 2);
      ctx.fill();
      ctx.restore();
    }

    // 드레인 통로 — 플리퍼 사이로 빠진 공이 지나는 길.
    pbPolygon(ctx, [[120, 500], [260, 500], [280, PINBALL_HEIGHT], [100, PINBALL_HEIGHT]], 'rgba(6,8,20,.72)');

    // 아래쪽 레인 안내 화살표.
    for (const [tx, ty, up] of [[102, 466, true], [278, 466, true], [190, 448, true]]) {
      const point = pbPoint(tx, ty);
      ctx.fillStyle = 'rgba(158,244,255,.32)';
      ctx.beginPath();
      ctx.moveTo(point.x, point.y + (up ? -7 : 7));
      ctx.lineTo(point.x + 5, point.y);
      ctx.lineTo(point.x - 5, point.y);
      ctx.closePath();
      ctx.fill();
    }

    // 판 이름.
    for (const [tx, ty, text] of [[104, 526, 'CINEMATRONICS'], [278, 526, 'MAXIS']]) {
      const point = pbPoint(tx, ty);
      ctx.save();
      ctx.translate(point.x, point.y);
      ctx.fillStyle = 'rgba(176,192,232,.45)';
      ctx.font = '700 8px Tahoma, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(text, 0, 0);
      ctx.restore();
    }
  }

  function pbPolygon(ctx, points, fill) {
    ctx.beginPath();
    points.forEach(([tx, ty], index) => (index === 0 ? pbMoveTo(ctx, tx, ty) : pbLineTo(ctx, tx, ty)));
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  }

  // 벽을 금속 레일로 그린다(슈트는 따로 그렸으니 뺀다).
  function paintPinballRails(ctx) {
    ctx.lineCap = 'round';
    for (const pass of [{ width: 6, color: '#1c2138' }, { width: 2.4, color: PB_INK.rail },
      { width: 0.8, color: PB_INK.railLight }]) {
      ctx.strokeStyle = pass.color;
      ctx.lineWidth = pass.width;
      for (const wall of PINBALL_WALLS) {
        if (wall.kind !== 'seg') continue;
        if (wall.ax === LANE_LEFT || wall.ax === LANE_RIGHT) continue;
        ctx.beginPath();
        pbMoveTo(ctx, wall.ax, wall.ay);
        pbLineTo(ctx, wall.bx, wall.by);
        ctx.stroke();
      }
    }
    ctx.lineCap = 'butt';
  }

  // ── 매 프레임 얹는 것 ──
  function drawPinballLight(ctx, tx, ty, radius, on, color) {
    const point = pbPoint(tx, ty);
    if (on) {
      const glow = ctx.createRadialGradient(point.x, point.y, 0, point.x, point.y, radius * point.scale * 3);
      glow.addColorStop(0, color);
      glow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius * point.scale * 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.beginPath();
    pbEllipse(ctx, tx, ty, radius);
    ctx.fillStyle = on ? color : 'rgba(30,36,64,.85)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(160,178,220,.45)';
    ctx.lineWidth = 0.7;
    ctx.stroke();
  }

  function drawPinball(instance) {
    const ctx = instance.context;
    const state = instance.state;
    ctx.drawImage(instance.field, 0, 0);

    // 계급 원판 — 바깥 고리는 진행도, 안 고리는 계급.
    for (let index = 0; index < PINBALL_RANK_STEPS; index += 1) {
      const angle = (index / PINBALL_RANK_STEPS) * Math.PI * 2 - Math.PI / 2;
      drawPinballLight(ctx, 190 + Math.cos(angle) * 58, 372 + Math.sin(angle) * 58, 3.4,
        index < state.rankProgress, PB_INK.amber);
    }
    for (let index = 0; index < PINBALL_RANKS.length; index += 1) {
      const angle = (index / PINBALL_RANKS.length) * Math.PI * 2 - Math.PI / 2;
      drawPinballLight(ctx, 190 + Math.cos(angle) * 40, 372 + Math.sin(angle) * 40, 3.4,
        index < state.rank, PB_INK.green);
    }
    // 중력의 중심.
    drawPinballLight(ctx, 190, 372, 8, state.gravityWell, '#7ef0ff');

    // 연료 막대.
    for (let index = 0; index < PINBALL_FUEL_MAX; index += 1) {
      drawPinballLight(ctx, 152 + index * 6.6, 452, 2.4, index < state.fuel,
        state.fuel <= 2 ? PB_INK.red : PB_INK.green);
    }

    // 슈트 관문(쏘기 기술).
    for (let index = 0; index < PINBALL_SKILL_GATES.length; index += 1) {
      const angle = PINBALL_SKILL_GATES[index];
      const radius = (ARC_INNER + ARC_OUTER) / 2;
      drawPinballLight(ctx, ARC_CX + Math.cos(angle) * radius, ARC_CY - Math.sin(angle) * radius, 3.2,
        index < state.skillShot, PB_INK.amber);
    }

    // 롤오버 라이트.
    for (const rollover of PINBALL_ROLLOVERS) {
      let on = Boolean(state.lanes[rollover.id]);
      let color = PB_INK.amber;
      if (rollover.kind === 'outlane') { on = state.extraBallLit > 0; color = PB_INK.red; }
      if (rollover.kind === 'returnlane') {
        on = rollover.side === 'left' ? Boolean(state.lanes.warpLeft) : Boolean(state.lanes.warpRight);
        color = '#7ef0ff';
      }
      if (rollover.kind === 'bonuslane') { on = Boolean(state.lanes.bonusLit); color = PB_INK.green; }
      if (rollover.kind === 'fuel') { on = state.fuel > 0; color = PB_INK.green; }
      if (rollover.kind === 'spacewarp') { on = state.mission === 15; color = '#7ef0ff'; }
      const point = pbPoint(rollover.x, rollover.y);
      ctx.save();
      ctx.strokeStyle = on ? color : 'rgba(150,168,210,.35)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.ellipse(point.x, point.y, rollover.radius * point.scale, rollover.radius * point.scale * 0.42, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // 킥백 문 — 위험물 뱅크를 채우면 켜지고, 바깥 레인에 빠진 공을 한 번 되쏜다.
    for (const kicker of PINBALL_KICKERS) {
      drawPinballLight(ctx, kicker.x, kicker.y - 24, 4, state.kickback[kicker.side], PB_INK.red);
    }
    // 다시 쏘기·반칙 라이트.
    drawPinballLight(ctx, 168, 526, 4.4, state.shootAgain, PB_INK.green);
    drawPinballLight(ctx, 212, 526, 4.4, state.tiltLock, PB_INK.red);

    // 고정 표적.
    for (const target of PINBALL_SPOT_TARGETS) {
      drawPinballTarget(ctx, target, Boolean(state.spotLit[target.id]), false);
    }
    // 낙하 표적.
    for (const target of PINBALL_DROP_TARGETS) {
      drawPinballTarget(ctx, target, false, Boolean(state.dropped[target.id]));
    }

    // 웜홀 셋 — 색 고리가 목적지를 알린다.
    for (let index = 0; index < PINBALL_WORMHOLES.length; index += 1) {
      const sink = PINBALL_WORMHOLES[index];
      const open = state.wormholeTarget === index + 1;
      const color = sink.color === 'yellow' ? PB_INK.amber : sink.color === 'red' ? PB_INK.red : PB_INK.green;
      ctx.beginPath();
      pbEllipse(ctx, sink.x, sink.y, sink.radius + 4);
      ctx.strokeStyle = open ? color : 'rgba(150,168,210,.42)';
      ctx.lineWidth = open ? 3 : 1.6;
      ctx.stroke();
      pbFillCircle(ctx, sink.x, sink.y, sink.radius, '#05060f');
      ctx.beginPath();
      pbEllipse(ctx, sink.x, sink.y, sink.radius);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
      if (open) drawPinballLight(ctx, sink.x, sink.y, 3.6, true, color);
    }

    // 구멍 셋 — 하이퍼스페이스·블랙홀·중력의 중심.
    for (const hole of PINBALL_HOLES) {
      const lit = hole.id === 'gravitywell' ? state.gravityWell : true;
      if (hole.id === 'gravitywell' && !state.gravityWell) {
        ctx.beginPath();
        pbEllipse(ctx, hole.x, hole.y, hole.radius);
        ctx.strokeStyle = 'rgba(140,236,248,.4)';
        ctx.lineWidth = 1.2;
        ctx.stroke();
        continue;
      }
      pbFillCircle(ctx, hole.x, hole.y, hole.radius, '#04050c');
      ctx.beginPath();
      pbEllipse(ctx, hole.x, hole.y, hole.radius);
      ctx.strokeStyle = lit ? '#7ef0ff' : 'rgba(150,168,210,.45)';
      ctx.lineWidth = 1.8;
      ctx.stroke();
    }

    // 발사대 입구.
    const ramp = pbPoint(PINBALL_RAMP.x, PINBALL_RAMP.y);
    ctx.save();
    ctx.strokeStyle = state.rampBonus > 0 ? PB_INK.amber : 'rgba(200,214,246,.6)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(ramp.x, ramp.y, PINBALL_RAMP.radius * ramp.scale, PINBALL_RAMP.radius * ramp.scale * 0.5, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // 깃발.
    for (const flag of PINBALL_FLAGS) {
      const point = pbPoint(flag.x, flag.y);
      ctx.save();
      ctx.translate(point.x, point.y);
      ctx.fillStyle = state.flagsLit > 0 ? PB_INK.amber : PB_INK.steel;
      ctx.beginPath();
      ctx.moveTo(-flag.radius * point.scale, -flag.radius * point.scale);
      ctx.lineTo(flag.radius * point.scale, -flag.radius * point.scale * 0.3);
      ctx.lineTo(-flag.radius * point.scale, flag.radius * point.scale * 0.4);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // 범퍼.
    for (const bumper of PINBALL_BUMPERS) {
      const level = state.bumperLevel[bumper.group];
      const point = pbPoint(bumper.x, bumper.y);
      const outer = bumper.radius * point.scale;
      // 받침과 그림자 — 판 위에 얹힌 것처럼 보이게.
      ctx.beginPath();
      pbEllipse(ctx, bumper.x, bumper.y + 4, bumper.radius * 1.18);
      ctx.fillStyle = 'rgba(4,6,16,.55)';
      ctx.fill();
      ctx.beginPath();
      pbEllipse(ctx, bumper.x, bumper.y, bumper.radius * 1.16);
      ctx.strokeStyle = level >= 1 ? 'rgba(255,214,120,.85)' : 'rgba(180,196,232,.5)';
      ctx.lineWidth = 1.6;
      ctx.stroke();
      const cap = ctx.createRadialGradient(point.x - outer * 0.3, point.y - outer * 0.4, outer * 0.1, point.x, point.y, outer);
      cap.addColorStop(0, '#fff6d8');
      cap.addColorStop(0.45, level >= 2 ? '#ff9d2f' : '#ffd06a');
      cap.addColorStop(1, level >= 3 ? '#c0202a' : '#8d3a1c');
      ctx.beginPath();
      pbEllipse(ctx, bumper.x, bumper.y, bumper.radius);
      ctx.fillStyle = cap;
      ctx.fill();
      ctx.strokeStyle = '#f2f7ff';
      ctx.lineWidth = 2.2;
      ctx.stroke();
      ctx.beginPath();
      pbEllipse(ctx, bumper.x, bumper.y, bumper.radius * 0.45);
      ctx.fillStyle = level >= 1 ? '#fff2b4' : '#5a3a2a';
      ctx.fill();
    }

    // 리바운드.
    ctx.strokeStyle = PB_INK.magenta;
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    for (const rebounder of PINBALL_REBOUNDERS) {
      ctx.beginPath();
      pbMoveTo(ctx, rebounder.ax, rebounder.ay);
      pbLineTo(ctx, rebounder.bx, rebounder.by);
      ctx.stroke();
    }
    ctx.lineCap = 'butt';

    // 중앙 고지.
    if (state.centerPost > 0) {
      pbFillCircle(ctx, 190, PINBALL_HEIGHT - 34, 7, '#e8e2ff');
    }

    // 플리퍼.
    for (const flipper of PINBALL_FLIPPERS) {
      const motion = pinballFlipperMotion(state, flipper);
      const pivot = pbPoint(flipper.x, flipper.y);
      const tipX = flipper.x + Math.cos(motion.angle) * FLIPPER_LENGTH;
      const tipY = flipper.y + Math.sin(motion.angle) * FLIPPER_LENGTH;
      const tip = pbPoint(tipX, tipY);
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#3a1030';
      ctx.lineWidth = FLIPPER_RADIUS * 2.4 * pivot.scale;
      ctx.beginPath();
      ctx.moveTo(pivot.x, pivot.y);
      ctx.lineTo(tip.x, tip.y);
      ctx.stroke();
      ctx.strokeStyle = state.tiltLock ? '#6b5570' : '#e0559f';
      ctx.lineWidth = FLIPPER_RADIUS * 1.8 * pivot.scale;
      ctx.beginPath();
      ctx.moveTo(pivot.x, pivot.y);
      ctx.lineTo(tip.x, tip.y);
      ctx.stroke();
      ctx.lineCap = 'butt';
    }

    // 플런저.
    const plungerTop = pbPoint((LANE_LEFT + LANE_RIGHT) / 2, PINBALL_HEIGHT - 12 + state.plunger * 26);
    const plungerBase = pbPoint((LANE_LEFT + LANE_RIGHT) / 2, PINBALL_HEIGHT);
    ctx.strokeStyle = '#b9c4dd';
    ctx.lineWidth = 8 * plungerTop.scale;
    ctx.beginPath();
    ctx.moveTo(plungerTop.x, plungerTop.y);
    ctx.lineTo(plungerBase.x, plungerBase.y);
    ctx.stroke();

    // 공.
    for (const ball of state.balls) {
      if (ball.hold) continue;
      const point = pbPoint(ball.x, ball.y);
      const radius = ball.radius * point.scale;
      const shadow = pbPoint(ball.x + 3, ball.y + 3);
      ctx.fillStyle = 'rgba(0,0,0,.45)';
      ctx.beginPath();
      ctx.ellipse(shadow.x, shadow.y, radius, radius * 0.7, 0, 0, Math.PI * 2);
      ctx.fill();
      const shine = ctx.createRadialGradient(
        point.x - radius * 0.35, point.y - radius * 0.45, radius * 0.1,
        point.x, point.y, radius,
      );
      shine.addColorStop(0, '#ffffff');
      shine.addColorStop(0.35, '#dbe6f5');
      shine.addColorStop(0.75, '#8b98ae');
      shine.addColorStop(1, '#414c63');
      ctx.fillStyle = shine;
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
      ctx.fill();
    }

    if (state.tiltLock) {
      ctx.fillStyle = 'rgba(232,68,58,.28)';
      ctx.fillRect(0, 0, PINBALL_VIEW_WIDTH, PINBALL_VIEW_HEIGHT);
    }
    updatePinballPanel(instance);
  }

  function drawPinballTarget(ctx, target, lit, dropped) {
    const point = pbPoint(target.x, target.y);
    const half = 11 * point.scale;
    ctx.save();
    ctx.translate(point.x, point.y);
    ctx.rotate(target.angle * 0.55);
    if (dropped) {
      ctx.fillStyle = 'rgba(90,102,140,.5)';
      ctx.fillRect(-half, -1.2, half * 2, 2.4);
    } else {
      ctx.fillStyle = lit ? PB_INK.amber : '#c9d3ea';
      ctx.fillRect(-half, -3.4, half * 2, 6.8);
      ctx.fillStyle = 'rgba(0,0,0,.35)';
      ctx.fillRect(-half, 1.6, half * 2, 1.8);
    }
    ctx.restore();
  }

  // ── 오른쪽 계기판 ──
  function pinballScoreText(value) {
    return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function updatePinballPanel(instance) {
    const state = instance.state;
    const root = instance.root;
    root.querySelector('[data-pinball-score]').textContent = pinballScoreText(state.score);
    const ballNumber = Math.max(1, PINBALL_MAX_BALLS - state.ballsLeft + 1);
    root.querySelector('[data-pinball-balls]').textContent = state.gameOver ? '-' : String(ballNumber);
    root.querySelector('[data-pinball-rank]').textContent = pinballRankName(state.rank);
    const missionText = state.gameOver
      ? `게임 끝\n최종 점수 ${pinballScoreText(state.score)}`
      : state.missionText;
    const mission = root.querySelector('[data-pinball-status]');
    if (mission.textContent !== missionText) mission.textContent = missionText;
    const info = root.querySelector('[data-pinball-info]');
    const infoText = state.infoText || (state.status === 'awaiting' && !state.gameOver ? 'Space를 누르고 떼어 쏘기' : '');
    if (info.textContent !== infoText) info.textContent = infoText;
    const multiplier = root.querySelector('[data-pinball-multiplier]');
    multiplier.textContent = `${PINBALL_MULTIPLIERS[state.multiplier]}배`;
    multiplier.hidden = state.multiplier === 0;
  }

  function resetPinball(instance) {
    instance.loop.stop();
    instance.state = createPinballState();
    instance.controls.left = false;
    instance.controls.right = false;
    instance.chargeStarted = null;
    feedPinballBall(instance.state);
    drawPinball(instance);
    if (!instance.paused) instance.loop.start();
  }

  function pinballAvailable(instance) {
    return !instance.paused && !instance.section.classList.contains('hidden')
      && !instance.section.classList.contains('win-min');
  }

  function pinballCanHandleKeys(instance) {
    return pinballInputEnabled({
      paused: instance.paused,
      hidden: instance.section.classList.contains('hidden'),
      minimized: instance.section.classList.contains('win-min'),
      active: instance.section.classList.contains('win-active'),
    });
  }

  // Space를 누르고 있는 동안 플런저를 당긴다.
  function beginPinballCharge(instance, event) {
    const state = instance.state;
    if (!pinballAvailable(instance) || state.gameOver || instance.chargeStarted !== null) return;
    if (!state.balls.length) feedPinballBall(state);
    const ball = state.balls[0];
    if (!ball || !ball.inLane || state.status === 'playing') return;
    if (event) event.preventDefault();
    instance.chargeStarted = instance.now();
    instance.loop.start();
  }

  function releasePinballCharge(instance, event) {
    if (instance.chargeStarted === null) return;
    if (event) event.preventDefault();
    const power = Math.max(0.05, Math.min(1, (instance.now() - instance.chargeStarted) / 1100));
    instance.chargeStarted = null;
    launchPinball(instance.state, power);
    instance.loop.start();
    if (instance.canvas.focus) instance.canvas.focus({ preventScroll: true });
  }

  const PINBALL_LEFT_KEYS = new Set(['arrowleft', 'z']);
  const PINBALL_RIGHT_KEYS = new Set(['arrowright', 'm', '/']);
  const PINBALL_NUDGE_KEYS = { x: [-1, 0], '.': [1, 0], arrowup: [0, -1] };

  function mountPinball(root) {
    const canvas = root.querySelector('canvas');
    const document_ = root.ownerDocument;
    const view = document_.defaultView;
    canvas.width = PINBALL_VIEW_WIDTH;
    canvas.height = PINBALL_VIEW_HEIGHT;

    // 안 변하는 바닥은 한 번만 그려 캐시에 담는다.
    const field = document_.createElement('canvas');
    field.width = PINBALL_VIEW_WIDTH;
    field.height = PINBALL_VIEW_HEIGHT;
    paintPinballField(field.getContext('2d'));

    const instance = {
      type: 'pinball',
      root,
      section: root.closest('.win'),
      canvas,
      context: canvas.getContext('2d'),
      field,
      state: createPinballState(),
      controls: { left: false, right: false },
      paused: true,
      chargeStarted: null,
      now: () => view.performance.now(),
    };
    feedPinballBall(instance.state);

    instance.loop = createAnimationLoop((seconds) => {
      const state = instance.state;
      if (instance.chargeStarted !== null) {
        state.plunger = Math.max(0, Math.min(1, (instance.now() - instance.chargeStarted) / 1100));
      }
      stepPinball(state, seconds, instance.controls);
      drawPinball(instance);
    }, (callback) => view.requestAnimationFrame(callback), (requestId) => view.cancelAnimationFrame(requestId));

    instance.onKeyDown = (event) => {
      if (!pinballCanHandleKeys(instance)) return;
      const key = event.key.toLowerCase();
      if (PINBALL_LEFT_KEYS.has(key)) { event.preventDefault(); instance.controls.left = true; }
      if (PINBALL_RIGHT_KEYS.has(key)) { event.preventDefault(); instance.controls.right = true; }
      if (PINBALL_NUDGE_KEYS[key] && !event.repeat) {
        event.preventDefault();
        nudgePinball(instance.state, PINBALL_NUDGE_KEYS[key][0], PINBALL_NUDGE_KEYS[key][1]);
      }
      if (key === ' ' && !event.repeat) beginPinballCharge(instance, event);
      if (event.key === 'F2') { event.preventDefault(); resetPinball(instance); }
      if (!instance.loop.isRunning()) drawPinball(instance);
    };
    instance.onKeyUp = (event) => {
      const key = event.key.toLowerCase();
      if (PINBALL_LEFT_KEYS.has(key)) { event.preventDefault(); instance.controls.left = false; }
      if (PINBALL_RIGHT_KEYS.has(key)) { event.preventDefault(); instance.controls.right = false; }
      if (key === ' ') releasePinballCharge(instance, event);
    };
    instance.onCommand = (event) => {
      const command = event.target.dataset ? event.target.dataset.gameCommand : null;
      if (command === 'new-pinball') resetPinball(instance);
      if (command === 'help-pinball') {
        pinballInfo(instance.state, '←/Z·→/M 플리퍼, Space 쏘기, X/. 흔들기', 6);
        drawPinball(instance);
      }
    };
    instance.onLaunchDown = (event) => {
      if (typeof event.currentTarget.setPointerCapture === 'function') {
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      beginPinballCharge(instance, event);
    };
    instance.onLaunchUp = (event) => {
      releasePinballCharge(instance, event);
      if (typeof event.currentTarget.hasPointerCapture === 'function'
          && event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    };
    instance.onCanvasPointer = () => canvas.focus({ preventScroll: true });

    view.addEventListener('keydown', instance.onKeyDown);
    view.addEventListener('keyup', instance.onKeyUp);
    instance.section.addEventListener('click', instance.onCommand);
    instance.launchButton = root.querySelector('.pinball-launch');
    instance.launchButton.addEventListener('pointerdown', instance.onLaunchDown);
    instance.launchButton.addEventListener('pointerup', instance.onLaunchUp);
    instance.launchButton.addEventListener('pointercancel', instance.onLaunchUp);
    canvas.addEventListener('pointerdown', instance.onCanvasPointer);
    drawPinball(instance);
    return instance;
  }

  // ── 지뢰찾기 화면 ──
  // 시간은 카드놀이와 같은 방식으로 센다(elapsedMs + runningSince) — 창을 최소화하면 멈추고
  // 복원하면 이어져야 하는데, 흘러간 시각만 들고 있으면 멈춘 동안도 함께 흐른다.
  const MINE_MAX_SECONDS = 999;
  const CELL_STATE_LABEL = { [CLOSED]: '닫힘', [FLAG]: '깃발' };

  function mineElapsed(instance) {
    const running = instance.runningSince === null ? 0 : Date.now() - instance.runningSince;
    return Math.min(MINE_MAX_SECONDS, Math.floor((instance.elapsedMs + running) / 1000));
  }

  function renderMineClock(instance) {
    const seconds = mineElapsed(instance);
    instance.clockEl.innerHTML = counterHtml(seconds);
    instance.clockEl.setAttribute('aria-label', `경과 ${seconds}초`);
  }

  function renderMinePanel(instance) {
    const left = remainingMines(instance.board);
    instance.minesEl.innerHTML = counterHtml(left);
    instance.minesEl.setAttribute('aria-label', `남은 지뢰 표시 ${left}`);
    const status = instance.board.status;
    const face = status === 'won' ? 'won' : status === 'lost' ? 'lost' : instance.pressing ? 'press' : 'smile';
    instance.faceEl.innerHTML = faceSvg(face);
    instance.faceEl.classList.toggle('won', status === 'won');
    renderMineClock(instance);
  }

  // 패배하면 못 찾은 지뢰를 모두 드러내고, 잘못 꽂은 깃발에 가위표를 친다.
  function paintMineCell(instance, index) {
    const board = instance.board;
    const cell = instance.cells[index];
    const state = board.cell[index];
    const lost = board.status === 'lost';
    const isMine = board.mine[index] === 1;
    const row = Math.floor(index / board.cols) + 1;
    const col = (index % board.cols) + 1;
    let html = '';
    let label = CELL_STATE_LABEL[state] || '';
    cell.className = 'mine-cell';
    cell.classList.toggle('open', state === OPEN);

    if (state === FLAG) {
      if (lost && !isMine) { html = WRONG_SVG; label = '깃발, 지뢰 아님'; } else html = FLAG_SVG;
    } else if (state === OPEN && isMine) {
      html = MINE_SVG;
      label = '지뢰';
      if (index === board.hit) cell.classList.add('hit');
    } else if (state === OPEN) {
      if (board.near[index] > 0) {
        html = String(board.near[index]);
        cell.classList.add(`n${board.near[index]}`);
        label = `지뢰 ${board.near[index]}개`;
      } else {
        label = '빈 칸';
      }
    } else if (lost && isMine) {
      html = MINE_SVG;
      label = '지뢰';
      cell.classList.add('open');
    }

    cell.innerHTML = html;
    cell.setAttribute('aria-label', `${row}행 ${col}열, ${label}`);
    // 끝난 판의 칸을 disabled로 막지 않는다 — 보조기술이 결과판을 훑어볼 수 있어야 한다.
    // 입력은 규칙 쪽에서 이미 무시한다(finished).
    cell.tabIndex = index === instance.cursor ? 0 : -1;
  }

  function renderMine(instance) {
    for (let i = 0; i < instance.cells.length; i += 1) paintMineCell(instance, i);
    renderMinePanel(instance);
  }

  function announceMine(instance) {
    const board = instance.board;
    if (board.status === 'won') {
      instance.liveEl.textContent = `이겼습니다. 지뢰 ${board.mines}개를 ${mineElapsed(instance)}초에 모두 찾았습니다.`;
    } else if (board.status === 'lost') {
      instance.liveEl.textContent = '지뢰를 밟았습니다. 얼굴 버튼을 눌러 새 판을 시작하세요.';
    } else {
      instance.liveEl.textContent = '';
    }
  }

  function startMineTimer(instance) {
    if (instance.timerId !== null || instance.paused) return;
    instance.timerId = setInterval(() => {
      renderMineClock(instance);
      if (mineElapsed(instance) >= MINE_MAX_SECONDS) stopMineTimer(instance);
    }, 1000);
  }

  function stopMineTimer(instance) {
    if (instance.timerId === null) return;
    clearInterval(instance.timerId);
    instance.timerId = null;
  }

  function afterMineMove(instance) {
    const board = instance.board;
    if (board.status === 'playing' && instance.runningSince === null && instance.elapsedMs === 0) {
      instance.runningSince = Date.now();
      startMineTimer(instance);
    }
    if (finished(board)) {
      if (instance.runningSince !== null) instance.elapsedMs += Date.now() - instance.runningSince;
      instance.runningSince = null;
      stopMineTimer(instance);
    }
    renderMine(instance);
    announceMine(instance);
  }

  function resetMine(instance) {
    instance.board = createBoard(instance.preset);
    instance.elapsedMs = 0;
    instance.runningSince = null;
    instance.pressing = false;
    stopMineTimer(instance);
    renderMine(instance);
    announceMine(instance);
  }

  function moveMineCursor(instance, next) {
    if (next < 0 || next >= instance.cells.length) return;
    instance.cursor = next;
    for (let i = 0; i < instance.cells.length; i += 1) {
      instance.cells[i].tabIndex = i === instance.cursor ? 0 : -1;
    }
    instance.cells[instance.cursor].focus();
  }

  const MINE_ARROWS = {
    ArrowUp: (i, cols) => i - cols,
    ArrowDown: (i, cols) => i + cols,
    ArrowLeft: (i, cols) => (i % cols === 0 ? i : i - 1),
    ArrowRight: (i, cols) => ((i + 1) % cols === 0 ? i : i + 1),
    Home: (i, cols) => Math.floor(i / cols) * cols,
    End: (i, cols) => Math.floor(i / cols) * cols + cols - 1,
  };

  function mountMinesweeper(root, options) {
    const preset = (options && options.preset) || BEGINNER;
    const random = options && options.random;
    const doc = root.ownerDocument;
    root.innerHTML = `
      <div class="mine-shell">
        <div class="mine-panel">
          <div class="mine-counter" data-role="mines" role="img"></div>
          <button type="button" class="mine-face" data-role="face" aria-label="새 게임 시작"></button>
          <div class="mine-counter" data-role="clock" role="img"></div>
        </div>
        <div class="mine-board" data-role="board" role="group" aria-label="지뢰찾기 판"></div>
      </div>
      <p class="mine-help">좌클릭 열기 · 우클릭 깃발 · 숫자 칸을 다시 누르면 주변을 한 번에 엽니다.<br />
        키보드: 화살표로 이동, Enter·Space로 열기, F로 깃발.</p>
      <p class="mine-note">재미로 하는 게임입니다. 점수는 리워드 포인트와 아무 관계가 없습니다.</p>
      <p class="mine-live" role="status" aria-live="polite" data-role="live"></p>`;

    const instance = {
      type: 'mine', root, section: root.closest('.win'), preset, random,
      board: createBoard(preset),
      cursor: Math.floor(preset.rows / 2) * preset.cols + Math.floor(preset.cols / 2),
      cells: [],
      elapsedMs: 0, runningSince: null, timerId: null,
      paused: true, pressing: false,
      boardEl: root.querySelector('[data-role="board"]'),
      faceEl: root.querySelector('[data-role="face"]'),
      minesEl: root.querySelector('[data-role="mines"]'),
      clockEl: root.querySelector('[data-role="clock"]'),
      liveEl: root.querySelector('[data-role="live"]'),
    };

    // 열 수는 판뿐 아니라 안내 문구 폭도 정한다 — 판만이 아니라 root에 건다.
    root.style.setProperty('--mine-cols', String(preset.cols));
    for (let i = 0; i < preset.cols * preset.rows; i += 1) {
      const cell = doc.createElement('button');
      cell.type = 'button';
      cell.className = 'mine-cell';
      cell.dataset.index = String(i);
      cell.tabIndex = -1;
      instance.boardEl.appendChild(cell);
      instance.cells.push(cell);
    }

    instance.onClick = (event) => {
      const cell = event.target.closest('.mine-cell');
      if (!cell) return;
      const index = Number(cell.dataset.index);
      instance.cursor = index;
      // 이미 열린 숫자 칸을 다시 누르면 코딩이다. 그 외에는 그냥 연다.
      if (instance.board.cell[index] === OPEN) chord(instance.board, index, instance.random);
      else reveal(instance.board, index, instance.random);
      afterMineMove(instance);
    };
    instance.onContextMenu = (event) => {
      const cell = event.target.closest('.mine-cell');
      if (!cell) return;
      event.preventDefault();
      toggleFlag(instance.board, Number(cell.dataset.index));
      afterMineMove(instance);
    };
    // 누르는 동안 표정이 바뀐다. 판이 끝난 뒤에는 바뀌지 않는다.
    instance.onPointerDown = (event) => {
      if (event.button !== 0 || finished(instance.board)) return;
      instance.pressing = true;
      renderMinePanel(instance);
    };
    instance.onRelease = () => {
      if (!instance.pressing) return;
      instance.pressing = false;
      renderMinePanel(instance);
    };
    // 화살표로 칸 사이를 옮긴다. 포커스는 한 번에 한 칸만 받는다(roving tabindex).
    instance.onKeyDown = (event) => {
      // 한글 자판에서도 F가 깃발이어야 한다 — 글자(key)가 아니라 자리(code)를 본다.
      if (event.code === 'KeyF') {
        event.preventDefault();
        toggleFlag(instance.board, instance.cursor);
        afterMineMove(instance);
        if (instance.cells[instance.cursor]) instance.cells[instance.cursor].focus();
        return;
      }
      const move = MINE_ARROWS[event.key];
      if (!move) return;
      event.preventDefault();
      moveMineCursor(instance, move(instance.cursor, instance.board.cols));
    };
    instance.onFaceClick = () => resetMine(instance);
    instance.onCommand = (event) => {
      const command = event.target.dataset.gameCommand;
      if (command === 'new-mine') resetMine(instance);
      if (command === 'help-mine') {
        instance.liveEl.textContent = '좌클릭으로 열고 우클릭으로 깃발을 꽂습니다. 숫자만큼 깃발을 꽂은 칸을 다시 누르면 주변이 한 번에 열립니다.';
      }
    };

    instance.boardEl.addEventListener('click', instance.onClick);
    instance.boardEl.addEventListener('contextmenu', instance.onContextMenu);
    instance.boardEl.addEventListener('pointerdown', instance.onPointerDown);
    instance.boardEl.addEventListener('pointerup', instance.onRelease);
    instance.boardEl.addEventListener('pointerleave', instance.onRelease);
    instance.boardEl.addEventListener('pointercancel', instance.onRelease);
    instance.boardEl.addEventListener('keydown', instance.onKeyDown);
    instance.faceEl.addEventListener('click', instance.onFaceClick);
    if (instance.section) instance.section.addEventListener('click', instance.onCommand);

    renderMine(instance);
    announceMine(instance);
    return instance;
  }

  function resume(id) {
    const instance = instances.get(id);
    if (!instance || !instance.paused) return;
    instance.paused = false;
    if (instance.type === 'pinball') {
      // 판은 공이 없어도 계속 돈다 — 플런저를 당기는 동안과 플리퍼가 오르내리는 동안에도
      // 화면이 살아 있어야 한다.
      instance.loop.start();
      drawPinball(instance);
      return;
    }
    if (instance.type === 'mine') {
      // 첫 수를 두기 전이면 시계는 아직 돌지 않는다 — 복원했다고 0초부터 흐르면 안 된다.
      if (instance.board.status === 'playing') {
        instance.runningSince = Date.now();
        startMineTimer(instance);
      }
      renderMinePanel(instance);
      return;
    }
    instance.runningSince = Date.now();
    instance.timerId = setInterval(() => updateSolitaireStatus(instance), 1000);
    updateSolitaireStatus(instance);
  }

  function pause(id) {
    const instance = instances.get(id);
    if (!instance || instance.paused) return;
    instance.paused = true;
    if (instance.type === 'pinball') {
      instance.loop.stop();
      instance.controls.left = false;
      instance.controls.right = false;
      instance.chargeStarted = null;
      drawPinball(instance);
      return;
    }
    if (instance.type === 'mine') {
      if (instance.runningSince !== null) instance.elapsedMs += Date.now() - instance.runningSince;
      instance.runningSince = null;
      stopMineTimer(instance);
      renderMinePanel(instance);
      return;
    }
    if (instance.runningSince !== null) instance.elapsedMs += Date.now() - instance.runningSince;
    instance.runningSince = null;
    clearInterval(instance.timerId);
    instance.timerId = null;
    updateSolitaireStatus(instance);
  }

  function destroy(id, generation) {
    const instance = instances.get(id);
    if (!instance || (generation !== undefined && instance.generation !== generation)) return;
    pause(id);
    if (instance.type === 'pinball') {
      const view = instance.root.ownerDocument.defaultView;
      view.removeEventListener('keydown', instance.onKeyDown);
      view.removeEventListener('keyup', instance.onKeyUp);
      instance.section.removeEventListener('click', instance.onCommand);
      instance.launchButton.removeEventListener('pointerdown', instance.onLaunchDown);
      instance.launchButton.removeEventListener('pointerup', instance.onLaunchUp);
      instance.launchButton.removeEventListener('pointercancel', instance.onLaunchUp);
      instance.canvas.removeEventListener('pointerdown', instance.onCanvasPointer);
    } else if (instance.type === 'mine') {
      // 칸·얼굴 버튼의 청취자는 root를 비우면 DOM과 함께 사라진다. 창에 건 것만 걷어낸다.
      if (instance.section) instance.section.removeEventListener('click', instance.onCommand);
      instance.root.innerHTML = '';
    } else {
      instance.root.removeEventListener('click', instance.onClick);
      instance.root.removeEventListener('dblclick', instance.onDoubleClick);
      instance.root.removeEventListener('dragstart', instance.onDragStart);
      instance.root.removeEventListener('dragover', instance.onDragOver);
      instance.root.removeEventListener('drop', instance.onDrop);
      instance.section.removeEventListener('click', instance.onCommand);
      instance.root.innerHTML = '';
    }
    instances.delete(id);
  }

  function mount(id, root, generation) {
    if (!root) return;
    const current = instances.get(id);
    if (current?.generation === generation) return;
    if (current) destroy(id, current.generation);
    installGameStyles(root.ownerDocument);
    // 인스턴스를 펼쳐 복사하면(`{ ...mount(), generation }`) 레지스트리의 사본과 핸들러가
    // 붙잡은 원본이 갈라진다. pause/resume이 사본의 paused만 바꾸는 동안 원본은 계속
    // 멈춘 줄 알아 타이머가 영영 돌지 않는다. 같은 객체에 generation만 얹는다.
    if (id === 'mine') instances.set(id, Object.assign(mountMinesweeper(root), { generation }));
    if (id === 'pinball') instances.set(id, Object.assign(mountPinball(root), { generation }));
    if (id === 'solitaire') instances.set(id, Object.assign(mountSolitaire(root), { generation }));
  }

  return {
    BEGINNER,
    CLOSED,
    FLAG,
    OPEN,
    autoMoveToFoundation,
    chord,
    counterDigits,
    createBoard,
    flagCount,
    mountMinesweeper,
    neighbors,
    plantMines,
    remainingMines,
    reveal,
    toggleFlag,
    canPlaceOnTableau,
    addPinballRankProgress,
    addPinballScore,
    addPinballSpecialScore,
    awardPinballSkillShot,
    advancePinballMission,
    collideBumper,
    completePinballMission,
    createAnimationLoop,
    createPinballState,
    drainPinballBall,
    feedPinballBall,
    dealKlondike,
    drawStock,
    isKlondikeWon,
    launchPinball,
    moveCardToFoundation,
    nudgePinball,
    pinballMissionName,
    pinballPickMission,
    pinballRankName,
    projectPinball,
    selectPinballMission,
    startPinballMission,
    moveCardToTableau,
    moveTableauRun,
    mount,
    pause,
    pinballInputEnabled,
    reflectBallFromSegment,
    resume,
    stepPinball,
    tableauCardOffsets,
    destroy,
  };
});
