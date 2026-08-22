'use strict';
// 클로애드 데스크톱 게임 — 지뢰찾기·핀볼·카드놀이 (CLAW-255).
//
// 경계 [CRITICAL]: 이 파일은 광고·노출·리워드 경로와 아무 것도 공유하지 않는다.
// 네트워크 호출이 없고, 점수·승패가 포인트·잔액·노출 인정에 닿지 않는다. 판은 메모리에만
// 있고 창을 닫으면 사라진다(localStorage도 쓰지 않는다 — 최고 기록을 남길 이유가 없다).
//
// 규칙 계산부는 DOM을 모르는 순수 함수다 — test/games.test.js와 test/user-web-games.test.js가
// 브라우저 없이 그대로 부른다. DOM은 mount* 아래에만 있다.
//
// 그래픽(지뢰·깃발·표정·7세그먼트·카드·핀볼판)은 전부 이 파일 안에서 SVG·캔버스로 그린다.
// 남의 게임 자산을 가져다 쓰지 않는다.
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

  // 실제 핀볼대의 기구 배치를 그대로 옮긴다. 오른쪽 발사 레일 → 위쪽 아치 → 팝 범퍼 →
  // 슬링샷 → 플리퍼·드레인이라는 순서는 기계의 구조가 정하는 것이라 어느 대나 같다.
  const PINBALL_WIDTH = 560;
  const PINBALL_HEIGHT = 620;
  const PLUNGER_LANE_X = 502;   // 발사 레일과 필드를 가르는 벽
  const PLUNGER_REST_X = 531;   // 레일 한가운데(공이 대기하는 자리)

  // 팝 범퍼 셋을 삼각형으로 둔다 — 위쪽 필드에서 공이 튀는 구간이다.
  const PINBALL_BUMPERS = [
    { id: 'top', x: 268, y: 152, radius: 26, points: 100 },
    { id: 'left', x: 192, y: 232, radius: 26, points: 100 },
    { id: 'right', x: 344, y: 232, radius: 26, points: 100 },
  ];
  // 슬링샷 위의 가르기 기둥. 공이 한쪽으로만 흐르지 않게 갈라 주는 실제 기구다.
  const PINBALL_POSTS = [
    { id: 'post-left', x: 150, y: 340, radius: 11, points: 50 },
    { id: 'post-right', x: 386, y: 340, radius: 11, points: 50 },
  ];

  const PINBALL_RAILS = [
    // 발사 레일 벽. 위쪽이 끊겨 있어 올라간 공이 필드로 넘어간다(원웨이 게이트와 같은 효과).
    { ax: PLUNGER_LANE_X, ay: 620, bx: PLUNGER_LANE_X, by: 190 },
    // 레일 덮개. 올라온 공을 왼쪽으로 꺾어 필드에 넣는다 — 이게 없으면 공이 레일을 되짚어
    // 내려와 그대로 빠진다.
    { ax: 560, ay: 152, bx: 494, by: 92 },
    // 위쪽 아치 — 필드 가장자리를 따라 공을 왼쪽 아래로 흘린다.
    { ax: 494, ay: 92, bx: 424, by: 46 },
    { ax: 424, ay: 46, bx: 330, by: 24 },
    { ax: 330, ay: 24, bx: 214, by: 24 },
    { ax: 214, ay: 24, bx: 118, by: 52 },
    { ax: 118, ay: 52, bx: 56, by: 110 },
    { ax: 56, ay: 110, bx: 34, by: 188 },
    // 좌우 측벽.
    { ax: 34, ay: 188, bx: 34, by: 392 },
    { ax: 502, ay: 250, bx: 502, by: 392 },
    // 아웃레인 바깥 벽. 아래로 좁아지며 드레인을 만든다.
    { ax: 34, ay: 392, bx: 156, by: 545 },
    { ax: 502, ay: 392, bx: 380, by: 545 },
    // 슬링샷. 플리퍼 위에서 공을 걷어차는 삼각 고무다 — 반발이 세다.
    { ax: 92, ay: 400, bx: 176, by: 486 },
    { ax: 444, ay: 400, bx: 360, by: 486 },
  ];

  // 플리퍼는 축을 중심으로 돈다. 쉴 때는 안쪽 아래로 처지고 누르면 위로 올라온다.
  const PINBALL_FLIPPERS = {
    left: { x: 200, y: 549, length: 82, dir: 1 },
    right: { x: 360, y: 549, length: 82, dir: -1 },
  };
  const FLIPPER_REST_DEG = 27;
  const FLIPPER_UP_DEG = -27;

  function flipperSegment(side, pressed) {
    const flipper = PINBALL_FLIPPERS[side];
    const angle = ((pressed ? FLIPPER_UP_DEG : FLIPPER_REST_DEG) * Math.PI) / 180;
    return {
      ax: flipper.x,
      ay: flipper.y,
      bx: flipper.x + flipper.dir * flipper.length * Math.cos(angle),
      by: flipper.y + flipper.length * Math.sin(angle),
    };
  }

  function createPinballState() {
    return {
      width: PINBALL_WIDTH,
      height: PINBALL_HEIGHT,
      ball: null,
      ballsLeft: 3,
      score: 0,
      gameOver: false,
      status: 'ready',
    };
  }

  function launchPinball(state, power = 0.7) {
    if (state.ball || state.gameOver || state.ballsLeft <= 0) return false;
    const strength = Math.max(0.25, Math.min(1, Number(power) || 0.7));
    state.ballsLeft -= 1;
    state.ball = {
      x: PLUNGER_REST_X,
      y: state.height - 54,
      vx: 0,
      vy: -700 - strength * 250,
      radius: 8,
      contacts: new Set(),
    };
    state.status = 'playing';
    return true;
  }

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

  function collideBumper(state, bumper) {
    const ball = state.ball;
    if (!ball) return false;
    if (!(ball.contacts instanceof Set)) ball.contacts = new Set();
    const offsetX = ball.x - bumper.x;
    const offsetY = ball.y - bumper.y;
    const distance = Math.hypot(offsetX, offsetY);
    const collisionDistance = ball.radius + bumper.radius;
    if (distance >= collisionDistance) {
      if (distance > collisionDistance + 2) ball.contacts.delete(bumper.id);
      return false;
    }
    if (ball.contacts.has(bumper.id)) return false;
    const normalX = distance ? offsetX / distance : 0;
    const normalY = distance ? offsetY / distance : -1;
    ball.x = bumper.x + normalX * collisionDistance;
    ball.y = bumper.y + normalY * collisionDistance;
    const incoming = ball.vx * normalX + ball.vy * normalY;
    if (incoming < 0) {
      ball.vx -= 1.9 * incoming * normalX;
      ball.vy -= 1.9 * incoming * normalY;
    }
    ball.vx += normalX * 120;
    ball.vy += normalY * 120;
    ball.contacts.add(bumper.id);
    state.score += bumper.points;
    return true;
  }

  function stepPinball(state, seconds, controls = {}) {
    const ball = state.ball;
    if (!ball || state.gameOver) return;
    if (ball.y > state.height + ball.radius) {
      state.ball = null;
      state.gameOver = state.ballsLeft === 0;
      state.status = state.gameOver ? 'game-over' : 'ready';
      return;
    }
    const elapsed = Math.max(0, Math.min(1 / 30, seconds));
    ball.vy += 470 * elapsed;
    ball.x += ball.vx * elapsed;
    ball.y += ball.vy * elapsed;

    if (ball.x < ball.radius) {
      ball.x = ball.radius;
      ball.vx = Math.abs(ball.vx) * 0.88;
    } else if (ball.x > state.width - ball.radius) {
      ball.x = state.width - ball.radius;
      ball.vx = -Math.abs(ball.vx) * 0.88;
    }
    if (ball.y < ball.radius) {
      ball.y = ball.radius;
      ball.vy = Math.abs(ball.vy) * 0.88;
    }

    for (const bumper of PINBALL_BUMPERS) collideBumper(state, bumper);
    for (const post of PINBALL_POSTS) collideBumper(state, post);
    for (const rail of PINBALL_RAILS) reflectBallFromSegment(ball, rail, 0.88);
    // 올린 플리퍼는 공을 되받아치고(반발 > 1), 내린 플리퍼는 그냥 받친다.
    reflectBallFromSegment(ball, flipperSegment('left', controls.left), controls.left ? 1.12 : 0.9);
    reflectBallFromSegment(ball, flipperSegment('right', controls.right), controls.right ? 1.12 : 0.9);

    if (ball.y <= state.height + ball.radius) return;
    state.ball = null;
    state.gameOver = state.ballsLeft === 0;
    state.status = state.gameOver ? 'game-over' : 'ready';
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

  function pinballInputEnabled(state) {
    return !state.paused && !state.hidden && !state.minimized && state.active;
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

  /**
   * 숫자 카드의 무늬(pip) 배치. 수백 년 된 트럼프 조판 관습이라 어느 덱이나 같다 —
   * 양쪽 끝에서 읽히도록 위아래가 180° 회전 대칭이고, 아래 절반(y > 0.5)은 뒤집어 그린다.
   * x는 왼쪽·가운데·오른쪽 세 자리, y는 pip 상자 안의 비율이다.
   */
  const PIP_LAYOUT = {
    1: [['C', 0.5]],
    2: [['C', 0], ['C', 1]],
    3: [['C', 0], ['C', 0.5], ['C', 1]],
    4: [['L', 0], ['R', 0], ['L', 1], ['R', 1]],
    5: [['L', 0], ['R', 0], ['C', 0.5], ['L', 1], ['R', 1]],
    6: [['L', 0], ['R', 0], ['L', 0.5], ['R', 0.5], ['L', 1], ['R', 1]],
    7: [['L', 0], ['R', 0], ['C', 0.25], ['L', 0.5], ['R', 0.5], ['L', 1], ['R', 1]],
    8: [['L', 0], ['R', 0], ['C', 0.25], ['L', 0.5], ['R', 0.5], ['C', 0.75], ['L', 1], ['R', 1]],
    9: [['L', 0], ['R', 0], ['L', 1 / 3], ['R', 1 / 3], ['C', 0.5], ['L', 2 / 3], ['R', 2 / 3], ['L', 1], ['R', 1]],
    10: [['L', 0], ['R', 0], ['C', 1 / 6], ['L', 1 / 3], ['R', 1 / 3],
      ['L', 2 / 3], ['R', 2 / 3], ['C', 5 / 6], ['L', 1], ['R', 1]],
  };
  const PIP_X = { L: 0, C: 50, R: 100 };

  // 그림 카드. 실물처럼 위아래가 뒤집힌 같은 그림이라 반쪽만 그리고 180° 회전해 붙인다.
  // 남의 카드 일러스트를 베끼지 않고 왕관·모자만으로 구분되는 자체 도안이다.
  // 그림 카드 머리 장식. 왕관(K)·보관(Q)·깃털 모자(J)로 갈린다.
  const COURT_HATS = {
    13: '<path d="M12.5 16.5 14.2 5.6 18.6 11.4 23.5 3.6 28.4 11.4 32.8 5.6 34.5 16.5Z" fill="#F0C000"/>'
      + '<rect x="12.5" y="16.5" width="22" height="3.4" fill="#F0C000"/>'
      + '<circle cx="18.6" cy="13.4" r="1.3" fill="#D40000"/><circle cx="23.5" cy="11.6" r="1.5" fill="#2050C0"/>'
      + '<circle cx="28.4" cy="13.4" r="1.3" fill="#D40000"/>',
    12: '<path d="M14 16.5 15.4 7.4 19.4 12 23.5 5.6 27.6 12 31.6 7.4 33 16.5Z" fill="#F0C000"/>'
      + '<rect x="14" y="16.5" width="19" height="3.2" fill="#F0C000"/>'
      + '<circle cx="15.4" cy="6" r="1.6" fill="#fff"/><circle cx="31.6" cy="6" r="1.6" fill="#fff"/>'
      + '<circle cx="23.5" cy="12.4" r="1.6" fill="#D40000"/>',
    11: '<path d="M13.6 17.4c0-7 4.4-10.4 9.9-10.4s9.9 3.4 9.9 10.4Z" fill="#2050C0"/>'
      + '<rect x="13.2" y="17.4" width="20.6" height="2.8" fill="#F0C000"/>'
      + '<path d="M32.6 9.6c5-2.6 7.4 1.6 4.4 5.2" fill="#D40000"/>',
  };

  /**
   * 그림 카드. 실물처럼 위아래가 같은 그림이라 반쪽만 그려 180° 돌려 붙이고 가운데에
   * 경계선을 둔다. 서양 트럼프의 court card 관습(좌우 대칭 반신·왕관·주름 깃·홀)을 따르되
   * 남의 카드 일러스트를 옮기지 않은 자체 도안이다.
   */
  function courtSvg(rank, red) {
    const suitInk = red ? '#D40000' : '#000';
    const robe = red ? '#D40000' : '#2050C0';
    const panel = red ? '#2050C0' : '#D40000';
    const props = {
      13: `<rect x="35.4" y="19" width="2.2" height="19" fill="#C8CED6" stroke="#000" stroke-width=".7"/>`
        + `<rect x="33.2" y="22.4" width="6.6" height="2" fill="#F0C000" stroke="#000" stroke-width=".7"/>`,
      12: `<circle cx="36.4" cy="24.4" r="3.4" fill="#F0C000" stroke="#000" stroke-width=".7"/>`
        + `<rect x="35.7" y="26.6" width="1.4" height="11.4" fill="#2f7d32" stroke="#000" stroke-width=".6"/>`,
      11: `<rect x="35.6" y="17.6" width="1.8" height="20.4" fill="#8a5a2b" stroke="#000" stroke-width=".7"/>`
        + `<path d="M33.4 17.6 39.6 17.6 36.5 12.4Z" fill="#C8CED6" stroke="#000" stroke-width=".7"/>`,
    };
    const half = '<g stroke="#000" stroke-width=".9" stroke-linejoin="round">'
      + props[rank]
      + COURT_HATS[rank]
      + '<circle cx="23.5" cy="24.4" r="5.6" fill="#fff"/>'
      + '<circle cx="21.5" cy="23.4" r=".85" fill="#000" stroke="none"/>'
      + '<circle cx="25.5" cy="23.4" r=".85" fill="#000" stroke="none"/>'
      + `<path d="M16.4 30.4 20 32.4 23.5 30.4 27 32.4 30.6 30.4 30.6 33 16.4 33Z" fill="#fff"/>`
      + `<path d="M13.4 38v-3.4c0-3.4 4.4-5.4 10.1-5.4s10.1 2 10.1 5.4V38Z" fill="${robe}"/>`
      + `<path d="M20.6 38v-7.2h5.8V38Z" fill="${panel}" stroke-width=".7"/>`
      + '</g>';
    return '<svg class="card-court" viewBox="0 0 47 76" aria-hidden="true">'
      + '<rect x="1" y="1" width="45" height="74" rx="2" fill="#fff" stroke="#000" stroke-width="1"/>'
      + `<rect x="3.2" y="3.2" width="40.6" height="69.6" rx="1.4" fill="#FFF6DC" stroke="${suitInk}" stroke-width=".8"/>`
      + `<line x1="3.2" y1="38" x2="43.8" y2="38" stroke="#000" stroke-width=".9"/>`
      + `${half}<g transform="rotate(180 23.5 38)">${half}</g></svg>`;
  }

  function pipsSvg(card, red) {
    const suit = SUIT_LABELS[card.suit];
    if (card.rank >= 11) return courtSvg(card.rank, red);
    const layout = PIP_LAYOUT[card.rank] || [];
    const ace = card.rank === 1 ? ' ace' : '';
    return layout.map(([x, y]) => {
      const flip = y > 0.5 ? ' flip' : '';
      return `<span class="card-pip${ace}${flip}" style="left:${PIP_X[x]}%;top:${(y * 100).toFixed(2)}%"`
        + ` aria-hidden="true">${suit}</span>`;
    }).join('');
  }
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
      .pinball-shell { display:grid; grid-template-columns:minmax(300px, 560px) 158px; justify-content:center;
        gap:8px; padding:8px; background:#10151f; overflow:auto; }
      .pinball-shell canvas { display:block; width:min(100%, 560px); height:auto; align-self:start;
        border:2px ridge #b9c7d9; background:#07101f; outline:none; image-rendering:auto; }
      .pinball-shell canvas:focus { border-color:#f9c776; box-shadow:0 0 0 2px #003c74; }
      /* 백박스. 실제 기계의 헤드처럼 로고 띠 → 공 번호 → 점수 → 메시지 순으로 쌓는다. */
      .pinball-panel { min-width:150px; padding:8px 7px; color:#e8eef8;
        background:linear-gradient(180deg,#1b1030,#2a1748 45%,#14092a);
        border:2px ridge #8c7bad; font-family:Tahoma,'Malgun Gothic',sans-serif; }
      .pinball-head { position:relative; margin-bottom:8px; padding:9px 8px 30px; text-align:center;
        background:radial-gradient(circle at 50% 22%,#4a2b80,#1d0f38 72%);
        border:2px outset #6f5a9c; }
      .pinball-head-sub { display:block; color:#c9a6ff; font-size:9px; letter-spacing:2px; }
      .pinball-head-name { display:block; margin-top:1px; color:#fff;
        font:700 19px/1.1 Georgia,'Times New Roman',serif; letter-spacing:1px;
        text-shadow:0 0 8px #b98cff,1px 1px 0 #3a1f66; }
      /* 공 번호는 실제 기계에서도 로고 아래 칸에 크게 박혀 있다. */
      .pinball-ball { position:absolute; left:0; right:0; bottom:5px; color:#ffd267; font-size:10px; letter-spacing:1px; }
      .pinball-ball b { display:inline-block; min-width:20px; margin-left:4px; padding:0 5px;
        color:#2a0b0b; background:#ffb020; border-radius:2px; font-size:13px; }
      .pinball-display { margin-bottom:8px; padding:6px 7px; color:#ffdc67; background:#020405;
        border:2px inset #8391a4; text-align:right; text-shadow:0 0 6px #e99c16; }
      .pinball-display small { display:block; color:#9eafbd; font-size:10px; text-align:left; }
      .pinball-display strong { display:block; font:700 22px/1.2 'Courier New',monospace; letter-spacing:2px; }
      /* 메시지 패널. 도트 매트릭스처럼 보이도록 격자를 겹쳐 깐다. */
      .pinball-message { white-space:pre-line; min-height:52px; margin:0 0 9px; padding:8px 7px; color:#7ef7c4; background:#04120c;
        background-image:repeating-linear-gradient(0deg,rgba(0,0,0,.55) 0 1px,transparent 1px 3px),
          repeating-linear-gradient(90deg,rgba(0,0,0,.55) 0 1px,transparent 1px 3px);
        border:2px inset #4c7d68; font:700 11px/1.5 'Courier New',monospace; letter-spacing:.5px; }
      .pinball-launch { width:100%; margin:0 0 10px; padding:5px 4px; }
      .pinball-keys { margin:0; font-size:10px; line-height:1.4; }
      .pinball-keys div { padding:5px 0; border-top:1px solid #40516a; }
      .pinball-keys dt { color:#9eafbd; }
      .pinball-keys dd { margin:1px 0 0; color:#fff; font-weight:700; }
      .pinball-keyboard-note { display:none; margin:12px; padding:14px; color:#000; background:#ffffe1;
        border:1px solid #000; border-radius:5px; }
      /* 카드는 71x96이다 — 윈도우 카드 게임들이 쓰던 규격이고, 이 크기라야 인덱스와 pip이
         함께 들어가면서도 7열이 한 화면에 들어온다. 펠트는 VGA 초록(#008000). */
      .solitaire-shell { position:relative; min-width:700px; min-height:520px; padding:12px 14px 30px;
        overflow:auto; color:#fff; background:#008000; border-top:1px solid #005c00;
        box-shadow:inset 0 0 55px rgba(0,0,0,.16); user-select:none; }
      .solitaire-top { display:grid; grid-template-columns:71px 71px 1fr repeat(4,71px); gap:14px; margin-bottom:18px; }
      .solitaire-top > div { position:relative; width:71px; height:96px; }
      .solitaire-columns { display:grid; grid-template-columns:repeat(7,71px); justify-content:space-between; gap:14px; }
      .solitaire-column { position:relative; min-height:360px; border-radius:4px; }
      /* 빈 자리는 카드가 놓일 곳임을 알리는 윤곽선이다. 펠트보다 살짝 어둡게 눌러 둔다. */
      .solitaire-slot { position:relative; width:71px; height:96px; padding:0; border:1px solid rgba(255,255,255,.45);
        border-radius:4px; background:rgba(0,0,0,.12); color:rgba(255,255,255,.75); font:700 26px/94px Tahoma,sans-serif;
        text-align:center; }
      button.solitaire-slot:hover { box-shadow:inset 0 0 0 2px rgba(255,255,255,.55); }
      .solitaire-card { position:absolute; left:0; width:71px; height:96px; min-height:0; padding:0;
        overflow:hidden; border:1px solid #000; border-radius:4px; background:#fff; color:#000;
        box-shadow:1px 1px 0 rgba(0,0,0,.4); font:700 13px/1 Tahoma,'Malgun Gothic',sans-serif; }
      /* 붉은 무늬는 VGA 빨강이다. 검정과 확실히 갈라져야 색으로 무늬를 읽을 수 있다. */
      .solitaire-card.red { color:#D40000; }
      /* 마주 보는 두 모서리의 인덱스. 아래쪽은 180° 돌아 있다 — 실물 트럼프와 같다. */
      .card-index { position:absolute; display:flex; flex-direction:column; align-items:center; line-height:1; }
      .card-index b { font-size:14px; }
      .card-index i { font-style:normal; font-size:13px; margin-top:0; }
      .card-tl { top:3px; left:4px; }
      .card-br { bottom:3px; right:4px; transform:rotate(180deg); }
      /* pip 상자. 좌우 인덱스를 피해 가운데만 쓴다. */
      .card-pips { position:absolute; left:21px; right:21px; top:13px; bottom:13px; }
      .card-pip { position:absolute; transform:translate(-50%,-50%); font-size:18px; line-height:1; }
      .card-pip.flip { transform:translate(-50%,-50%) rotate(180deg); }
      .card-pip.ace { font-size:40px; }
      .card-court { position:absolute; left:50%; top:50%; width:53px; height:82px;
        transform:translate(-50%,-50%); }
      /* 뒷면은 촘촘한 격자무늬다. 원본 도안을 베끼지 않고 같은 결의 자체 패턴을 쓴다. */
      .card-back { position:absolute; inset:2px; border-radius:2px; background-color:#1a3fa0;
        background-image:repeating-linear-gradient(45deg,rgba(255,255,255,.34) 0 1px,transparent 1px 5px),
          repeating-linear-gradient(-45deg,rgba(255,255,255,.34) 0 1px,transparent 1px 5px); }
      .solitaire-card:hover { z-index:60!important; box-shadow:0 0 0 2px #f9c776,1px 1px 0 rgba(0,0,0,.4); }
      .solitaire-card.selected { z-index:70!important; box-shadow:0 0 0 2px #ffd24a,1px 1px 0 rgba(0,0,0,.4); transform:translateY(-2px); }
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
    // 실물 카드처럼 마주 보는 두 모서리에 같은 인덱스를 둔다 — 손에 쥐고 부채꼴로 펼쳐도
    // 읽히라고 생긴 관습이고, 이게 있어야 트럼프처럼 보인다.
    const red = isRed(card);
    const index = `<b>${RANK_LABELS[card.rank] || card.rank}</b><i>${SUIT_LABELS[card.suit]}</i>`;
    const face = card.faceUp
      ? `<span class="card-index card-tl" aria-hidden="true">${index}</span>`
        + `<span class="card-index card-br" aria-hidden="true">${index}</span>`
        + `<span class="card-pips" aria-hidden="true">${pipsSvg(card, red)}</span>`
      : '<span class="card-back" aria-hidden="true"></span>';
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
          : ''}</div>
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

  // 플레이필드를 기계처럼 그린다: 도색된 판 위에 크롬 레일, 팝 범퍼, 고무를 두른 슬링샷,
  // 그리고 오른쪽 발사 레일. 남의 테이블 아트를 옮기지 않고 기구의 생김새만 그린다.
  // 램프 인서트. 실제 판은 색 전구가 촘촘히 박혀 있어 비어 보이지 않는다 — 점수와
  // 무관한 도색이지만 이게 없으면 판이 휑하다.
  const PINBALL_LAMPS = [
    [96, 150, '#ffd24a'], [128, 118, '#ff6b57'], [164, 96, '#4ad2ff'], [206, 82, '#ffd24a'],
    [252, 76, '#6bff9e'], [298, 78, '#ff6b57'], [340, 88, '#4ad2ff'], [378, 108, '#ffd24a'],
    [412, 136, '#6bff9e'], [96, 196, '#4ad2ff'], [432, 186, '#ff6b57'],
    [120, 296, '#ffd24a'], [416, 296, '#ffd24a'], [150, 372, '#6bff9e'], [386, 372, '#6bff9e'],
    [206, 318, '#ff6b57'], [330, 318, '#ff6b57'],
    [72, 250, '#ff6b57'], [464, 250, '#ff6b57'], [64, 320, '#6bff9e'], [472, 320, '#6bff9e'],
    [74, 418, '#ffd24a'], [462, 418, '#ffd24a'], [112, 470, '#4ad2ff'], [424, 470, '#4ad2ff'],
    [196, 400, '#ffd24a'], [340, 400, '#ffd24a'], [268, 430, '#6bff9e'],
    [232, 486, '#4ad2ff'], [304, 486, '#4ad2ff'],
  ];
  // 드롭 타깃 뱅크. 점수와 무관한 도색이지만 판이 기계처럼 보이는 데 크게 기여한다.
  const PINBALL_TARGET_BANKS = [
    { x: 118, y: 214, angle: -0.5 },
    { x: 418, y: 214, angle: 0.5 },
  ];
  // 가운데 라이트 링. 판의 중심을 잡아 주는 흔한 기구다.
  const PINBALL_RING = { x: 268, y: 318, radius: 62, lamps: 12 };

  function drawPlayfield(ctx, canvas) {
    // 우주색 도색. 보랏빛에서 남색으로 떨어진다.
    const felt = ctx.createLinearGradient(0, 0, 0, canvas.height);
    felt.addColorStop(0, '#3a1f6b');
    felt.addColorStop(0.42, '#241348');
    felt.addColorStop(1, '#0d0722');
    ctx.fillStyle = felt;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 별. 도색 위에 흩뿌린다.
    ctx.fillStyle = 'rgba(230,225,255,.75)';
    for (let i = 0; i < 70; i += 1) {
      const x = ((i * 97) % 520) + 20;
      const y = ((i * 173) % 560) + 20;
      ctx.fillRect(x, y, i % 7 === 0 ? 2 : 1, i % 7 === 0 ? 2 : 1);
    }

    // 위쪽 아치를 따라 도는 도색 띠(레인 안내 그림).
    ctx.strokeStyle = 'rgba(150,110,235,.28)';
    ctx.lineWidth = 20;
    for (const inset of [0, 28, 56]) {
      ctx.beginPath();
      ctx.arc(268, 250 + inset, 196 - inset, Math.PI * 1.06, Math.PI * 1.94);
      ctx.stroke();
    }

    // 가운데 라이트 링.
    ctx.strokeStyle = 'rgba(120,220,255,.4)';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(PINBALL_RING.x, PINBALL_RING.y, PINBALL_RING.radius, 0, Math.PI * 2); ctx.stroke();
    for (let i = 0; i < PINBALL_RING.lamps; i += 1) {
      const angle = (Math.PI * 2 * i) / PINBALL_RING.lamps;
      const lx = PINBALL_RING.x + Math.cos(angle) * PINBALL_RING.radius;
      const ly = PINBALL_RING.y + Math.sin(angle) * PINBALL_RING.radius;
      ctx.fillStyle = i % 3 === 0 ? '#7ee6ff' : '#3f7fd0';
      ctx.beginPath(); ctx.arc(lx, ly, 4.5, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = 'rgba(90,180,255,.18)';
    ctx.beginPath(); ctx.arc(PINBALL_RING.x, PINBALL_RING.y, PINBALL_RING.radius - 12, 0, Math.PI * 2); ctx.fill();

    // 인서트 전구.
    for (const [lx, ly, color] of PINBALL_LAMPS) {
      ctx.fillStyle = 'rgba(0,0,0,.45)';
      ctx.beginPath(); ctx.arc(lx, ly + 1.5, 6, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(lx, ly, 5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.55)';
      ctx.beginPath(); ctx.arc(lx - 1.6, ly - 1.8, 1.6, 0, Math.PI * 2); ctx.fill();
    }

    // 드롭 타깃 뱅크. 세 장짜리 흰 타깃이 비스듬히 서 있다.
    for (const bank of PINBALL_TARGET_BANKS) {
      ctx.save();
      ctx.translate(bank.x, bank.y);
      ctx.rotate(bank.angle);
      for (let i = 0; i < 3; i += 1) {
        ctx.fillStyle = '#101a30';
        ctx.fillRect(-16, -22 + i * 15, 32, 11);
        ctx.fillStyle = i === 1 ? '#ffd24a' : '#e9f1ff';
        ctx.fillRect(-14, -20 + i * 15, 28, 7);
      }
      ctx.restore();
    }

    // 레인 화살표. 공이 흐르는 길을 알린다.
    ctx.fillStyle = 'rgba(255,220,120,.45)';
    for (const [ax, ay] of [[112, 250], [424, 250], [176, 420], [360, 420]]) {
      ctx.beginPath();
      ctx.moveTo(ax, ay - 8); ctx.lineTo(ax + 6, ay + 4); ctx.lineTo(ax - 6, ay + 4);
      ctx.closePath(); ctx.fill();
    }

    // 아래쪽 드레인으로 모이는 어두운 도색.
    ctx.fillStyle = 'rgba(6,4,20,.6)';
    ctx.beginPath();
    ctx.moveTo(34, 392); ctx.lineTo(156, 545); ctx.lineTo(380, 545); ctx.lineTo(502, 392);
    ctx.lineTo(502, 620); ctx.lineTo(34, 620); ctx.closePath();
    ctx.fill();
  }

  function drawPlungerLane(ctx, canvas, instance) {
    // 발사 레일. 오른쪽 끝의 좁은 통로와 그 안의 플런저 로드·스프링.
    const laneLeft = PLUNGER_LANE_X + 5;
    ctx.fillStyle = '#0b1e3c';
    ctx.fillRect(laneLeft, 96, canvas.width - laneLeft, canvas.height - 96);
    ctx.strokeStyle = 'rgba(160,200,245,.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(canvas.width - 2, 96); ctx.lineTo(canvas.width - 2, canvas.height);
    ctx.stroke();
    // 공이 올라가는 방향을 화살표로 알린다.
    ctx.fillStyle = 'rgba(150,195,240,.5)';
    for (const y of [300, 360, 420]) {
      ctx.beginPath();
      ctx.moveTo(PLUNGER_REST_X, y - 9);
      ctx.lineTo(PLUNGER_REST_X + 7, y + 3);
      ctx.lineTo(PLUNGER_REST_X - 7, y + 3);
      ctx.closePath();
      ctx.fill();
    }
    const charge = instance.chargeStarted === null
      ? 0 : Math.min(1, (instance.now() - instance.chargeStarted) / 1200);
    const rodTop = canvas.height - 34 + charge * 30;
    ctx.strokeStyle = '#9fb4cc';
    ctx.lineWidth = 5;
    ctx.beginPath(); ctx.moveTo(PLUNGER_REST_X, canvas.height - 4); ctx.lineTo(PLUNGER_REST_X, rodTop); ctx.stroke();
    // 스프링은 감긴 만큼 촘촘해진다 — 얼마나 당겼는지가 눈에 보인다.
    ctx.strokeStyle = '#e0a33a';
    ctx.lineWidth = 2.5;
    const coils = 7;
    const span = 54 - charge * 26;
    ctx.beginPath();
    for (let i = 0; i <= coils; i += 1) {
      const y = rodTop + (span / coils) * i;
      ctx.moveTo(PLUNGER_REST_X - 9, y); ctx.lineTo(PLUNGER_REST_X + 9, y + span / coils / 2);
    }
    ctx.stroke();
    ctx.fillStyle = '#d8452f';
    ctx.beginPath(); ctx.arc(PLUNGER_REST_X, canvas.height - 6, 8, 0, Math.PI * 2); ctx.fill();
  }

  function drawRails(ctx) {
    // 레일은 크롬이다: 어두운 심 위에 밝은 하이라이트를 겹쳐 금속처럼 보이게 한다.
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#243b5c';
    ctx.lineWidth = 9;
    for (const rail of PINBALL_RAILS) {
      ctx.beginPath(); ctx.moveTo(rail.ax, rail.ay); ctx.lineTo(rail.bx, rail.by); ctx.stroke();
    }
    ctx.strokeStyle = '#cfe3f7';
    ctx.lineWidth = 4;
    for (const rail of PINBALL_RAILS) {
      ctx.beginPath(); ctx.moveTo(rail.ax, rail.ay); ctx.lineTo(rail.bx, rail.by); ctx.stroke();
    }
    ctx.lineCap = 'butt';
  }

  function drawBumpers(ctx) {
    // 팝 범퍼는 밑판(스커트) → 몸통 → 캡의 세 겹이다.
    for (const bumper of PINBALL_BUMPERS) {
      ctx.fillStyle = 'rgba(4,12,28,.55)';
      ctx.beginPath(); ctx.arc(bumper.x, bumper.y + 3, bumper.radius + 4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#eef4fb';
      ctx.beginPath(); ctx.arc(bumper.x, bumper.y, bumper.radius, 0, Math.PI * 2); ctx.fill();
      const cap = ctx.createRadialGradient(bumper.x - 7, bumper.y - 8, 2, bumper.x, bumper.y, bumper.radius - 5);
      cap.addColorStop(0, '#ffe9a8');
      cap.addColorStop(0.45, '#f0a81f');
      cap.addColorStop(1, '#c2371c');
      ctx.fillStyle = cap;
      ctx.beginPath(); ctx.arc(bumper.x, bumper.y, bumper.radius - 5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#3a1408';
      ctx.font = '700 11px Tahoma';
      ctx.textAlign = 'center';
      ctx.fillText(String(bumper.points), bumper.x, bumper.y + 4);
    }
  }

  function drawPosts(ctx) {
    for (const post of PINBALL_POSTS) {
      ctx.fillStyle = '#0a1830';
      ctx.beginPath(); ctx.arc(post.x, post.y + 2, post.radius + 2, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#e8f1fb';
      ctx.beginPath(); ctx.arc(post.x, post.y, post.radius, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#2f6fbd';
      ctx.beginPath(); ctx.arc(post.x, post.y, post.radius - 4, 0, Math.PI * 2); ctx.fill();
    }
  }

  function drawSlingshots(ctx) {
    // 슬링샷은 삼각 판에 고무를 두른 모양이다. 고무를 밝게 그려 튕기는 면을 알린다.
    const shots = [
      [[92, 400], [176, 486], [96, 486]],
      [[444, 400], [360, 486], [440, 486]],
    ];
    for (const points of shots) {
      ctx.fillStyle = '#1d3256';
      ctx.beginPath();
      ctx.moveTo(points[0][0], points[0][1]);
      for (const [x, y] of points.slice(1)) ctx.lineTo(x, y);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#f2f6ff';
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(points[0][0], points[0][1]);
      ctx.lineTo(points[1][0], points[1][1]);
      ctx.stroke();
    }
  }

  function drawFlippers(ctx, controls) {
    for (const side of ['left', 'right']) {
      const segment = flipperSegment(side, controls[side]);
      ctx.strokeStyle = '#1a2840';
      ctx.lineWidth = 19;
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(segment.ax, segment.ay); ctx.lineTo(segment.bx, segment.by); ctx.stroke();
      ctx.strokeStyle = controls[side] ? '#ff6b57' : '#e0453a';
      ctx.lineWidth = 14;
      ctx.beginPath(); ctx.moveTo(segment.ax, segment.ay); ctx.lineTo(segment.bx, segment.by); ctx.stroke();
      ctx.lineCap = 'butt';
      // 축. 실제 플리퍼도 이 점을 중심으로 돈다.
      ctx.fillStyle = '#cfe3f7';
      ctx.beginPath(); ctx.arc(segment.ax, segment.ay, 5, 0, Math.PI * 2); ctx.fill();
    }
  }

  function drawPinball(instance) {
    const { context: ctx, canvas, state, controls } = instance;
    drawPlayfield(ctx, canvas);
    drawPlungerLane(ctx, canvas, instance);
    drawSlingshots(ctx);
    drawRails(ctx);
    drawBumpers(ctx);
    drawPosts(ctx);
    drawFlippers(ctx, controls);

    // 발사 전에도 공은 레일 안에서 기다린다 — 실제 기계가 그렇고, 비어 있으면 뭘 쏘는지
    // 알 수 없다.
    const resting = !state.ball && !state.gameOver && state.ballsLeft > 0
      ? { x: PLUNGER_REST_X, y: canvas.height - 54, radius: 8 } : null;
    const shown = state.ball || resting;
    if (shown) {
      const shine = ctx.createRadialGradient(
        shown.x - 3, shown.y - 4, 1, shown.x, shown.y, shown.radius);
      shine.addColorStop(0, '#fff');
      shine.addColorStop(0.35, '#dceaf6');
      shine.addColorStop(1, '#5d7286');
      ctx.fillStyle = shine;
      ctx.beginPath(); ctx.arc(shown.x, shown.y, shown.radius, 0, Math.PI * 2); ctx.fill();
    }
    updatePinballPanel(instance);
  }

  function updatePinballPanel(instance) {
    instance.root.querySelector('[data-pinball-score]').textContent = String(instance.state.score).padStart(6, '0');
    instance.root.querySelector('[data-pinball-balls]').textContent = String(instance.state.ballsLeft);
    const status = instance.root.querySelector('[data-pinball-status]');
    if (instance.chargeStarted !== null) status.textContent = '플런저 장전 중…';
    else if (instance.state.gameOver) status.textContent = `게임 종료\n최종 점수 ${instance.state.score}`;
    else if (instance.state.ball) status.textContent = '항해 중\n범퍼를 맞히세요';
    else status.textContent = '발사 대기\nSpace를 누르고 떼세요';
  }

  function resetPinball(instance) {
    instance.loop.stop();
    instance.state = createPinballState();
    instance.controls.left = false;
    instance.controls.right = false;
    instance.chargeStarted = null;
    drawPinball(instance);
  }

  function pinballAvailable(instance) {
    return !instance.paused && !instance.section.classList.contains('hidden') && !instance.section.classList.contains('win-min');
  }

  function pinballCanHandleKeys(instance) {
    return pinballInputEnabled({
      paused: instance.paused,
      hidden: instance.section.classList.contains('hidden'),
      minimized: instance.section.classList.contains('win-min'),
      active: instance.section.classList.contains('win-active'),
    });
  }

  function beginPinballCharge(instance, event) {
    if (!pinballAvailable(instance) || instance.state.ball || instance.state.gameOver || instance.chargeStarted !== null) return;
    if (event) event.preventDefault();
    instance.chargeStarted = instance.now();
    instance.loop.start();
    drawPinball(instance);
  }

  function releasePinballCharge(instance, event) {
    if (instance.chargeStarted === null) return;
    if (event) event.preventDefault();
    const power = Math.max(0.25, Math.min(1, (instance.now() - instance.chargeStarted) / 1200));
    instance.chargeStarted = null;
    if (launchPinball(instance.state, power)) instance.loop.start();
    drawPinball(instance);
    instance.canvas.focus({ preventScroll: true });
  }

  function mountPinball(root) {
    const canvas = root.querySelector('canvas');
    const view = root.ownerDocument.defaultView;
    const instance = {
      type: 'pinball', root, section: root.closest('.win'), canvas, context: canvas.getContext('2d'),
      state: createPinballState(), controls: { left: false, right: false }, paused: true, chargeStarted: null,
      now: () => view.performance.now(),
    };
    instance.loop = createAnimationLoop((seconds) => {
      if (instance.state.ball) {
        const steps = Math.max(1, Math.ceil(seconds / (1 / 120)));
        for (let index = 0; index < steps; index += 1) stepPinball(instance.state, seconds / steps, instance.controls);
      }
      drawPinball(instance);
      if (!instance.state.ball && instance.chargeStarted === null) instance.loop.stop();
    }, (callback) => view.requestAnimationFrame(callback), (requestId) => view.cancelAnimationFrame(requestId));
    instance.onKeyDown = (event) => {
      if (!pinballCanHandleKeys(instance)) return;
      const key = event.key.toLowerCase();
      if (key === 'arrowleft' || key === 'z') { event.preventDefault(); instance.controls.left = true; }
      if (key === 'arrowright' || key === 'm') { event.preventDefault(); instance.controls.right = true; }
      if (key === ' ' && !event.repeat) beginPinballCharge(instance, event);
      if (!instance.loop.isRunning()) drawPinball(instance);
    };
    instance.onKeyUp = (event) => {
      const key = event.key.toLowerCase();
      if (key === 'arrowleft' || key === 'z') { event.preventDefault(); instance.controls.left = false; }
      if (key === 'arrowright' || key === 'm') { event.preventDefault(); instance.controls.right = false; }
      if (key === ' ') releasePinballCharge(instance, event);
    };
    instance.onCommand = (event) => {
      const command = event.target.dataset.gameCommand;
      if (command === 'new-pinball') resetPinball(instance);
      if (command === 'help-pinball') {
        instance.root.querySelector('[data-pinball-status]').textContent = '←/Z와 →/M으로 플리퍼, Space를 누르고 떼서 발사합니다.';
      }
    };
    instance.onLaunchDown = (event) => {
      if (typeof event.currentTarget.setPointerCapture === 'function') event.currentTarget.setPointerCapture(event.pointerId);
      beginPinballCharge(instance, event);
    };
    instance.onLaunchUp = (event) => {
      releasePinballCharge(instance, event);
      if (typeof event.currentTarget.hasPointerCapture === 'function'
          && event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
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
      if (instance.state.ball) instance.loop.start();
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
