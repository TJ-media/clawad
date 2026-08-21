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

  const PINBALL_WIDTH = 560;
  const PINBALL_HEIGHT = 620;
  const PINBALL_BUMPERS = [
    { id: 'north', x: 215, y: 165, radius: 27, points: 100 },
    { id: 'east', x: 350, y: 225, radius: 25, points: 150 },
    { id: 'west', x: 155, y: 285, radius: 24, points: 150 },
  ];
  const PINBALL_RAILS = [
    { ax: 490, ay: 145, bx: 490, by: 535 },
    { ax: 45, ay: 435, bx: 190, by: 550 },
    { ax: 470, ay: 435, bx: 325, by: 550 },
    { ax: 38, ay: 355, bx: 82, by: 440 },
    { ax: 478, ay: 355, bx: 434, by: 440 },
  ];

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
      x: state.width - 42,
      y: state.height - 54,
      vx: -45,
      vy: -640 - strength * 330,
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
    for (const rail of PINBALL_RAILS) reflectBallFromSegment(ball, rail, 0.88);
    if (controls.left) reflectBallFromSegment(ball, { ax: 155, ay: 530, bx: 250, by: 500 }, 1.05);
    else reflectBallFromSegment(ball, { ax: 155, ay: 530, bx: 245, by: 545 }, 0.9);
    if (controls.right) reflectBallFromSegment(ball, { ax: 405, ay: 530, bx: 310, by: 500 }, 1.05);
    else reflectBallFromSegment(ball, { ax: 405, ay: 530, bx: 315, by: 545 }, 0.9);

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
      .pinball-panel { min-width:150px; padding:9px 8px; color:#e8eef8; background:linear-gradient(90deg,#111827,#26354d,#101621);
        border:2px ridge #8c9bad; font-family:Tahoma,'Malgun Gothic',sans-serif; }
      .pinball-display { margin-bottom:8px; padding:7px; color:#ffdc67; background:#020405;
        border:2px inset #8391a4; text-align:right; text-shadow:0 0 5px #e99c16; }
      .pinball-display small { display:block; color:#9eafbd; font-size:10px; text-align:left; }
      .pinball-display strong { display:block; font:700 21px/1.2 'Courier New',monospace; letter-spacing:1px; }
      .pinball-panel [data-pinball-status] { min-height:50px; padding:7px; color:#9ef4ff; background:#08111d;
        border:1px inset #72839a; font-size:11px; line-height:1.5; }
      .pinball-launch { width:100%; margin:0 0 10px; padding:5px 4px; }
      .pinball-keys { margin:0; font-size:10px; line-height:1.4; }
      .pinball-keys div { padding:5px 0; border-top:1px solid #40516a; }
      .pinball-keys dt { color:#9eafbd; }
      .pinball-keys dd { margin:1px 0 0; color:#fff; font-weight:700; }
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

  function drawPinball(instance) {
    const { context: ctx, canvas, state, controls } = instance;
    const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, '#071831');
    gradient.addColorStop(0.55, '#102958');
    gradient.addColorStop(1, '#050a16');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = 'rgba(205,235,255,.72)';
    for (const [x, y, size] of [[62, 75, 2], [130, 130, 1], [280, 68, 2], [405, 116, 1], [455, 270, 2], [90, 350, 1], [325, 350, 1]]) {
      ctx.fillRect(x, y, size, size);
    }
    ctx.strokeStyle = '#60bce8';
    ctx.lineWidth = 3;
    ctx.strokeRect(18, 18, canvas.width - 36, canvas.height - 36);
    ctx.strokeStyle = '#8de4ff';
    ctx.lineWidth = 4;
    for (const rail of PINBALL_RAILS) {
      ctx.beginPath(); ctx.moveTo(rail.ax, rail.ay); ctx.lineTo(rail.bx, rail.by); ctx.stroke();
    }

    for (const bumper of PINBALL_BUMPERS) {
      const halo = ctx.createRadialGradient(bumper.x - 7, bumper.y - 9, 2, bumper.x, bumper.y, bumper.radius);
      halo.addColorStop(0, '#fff8ac'); halo.addColorStop(0.35, '#ffbc32'); halo.addColorStop(1, '#b82b24');
      ctx.fillStyle = halo;
      ctx.beginPath(); ctx.arc(bumper.x, bumper.y, bumper.radius, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#fff6bd'; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = '#331414'; ctx.font = '700 11px Tahoma'; ctx.textAlign = 'center';
      ctx.fillText(String(bumper.points), bumper.x, bumper.y + 4);
    }

    ctx.strokeStyle = '#f4c5ed';
    ctx.lineWidth = 14;
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(155, 530); ctx.lineTo(controls.left ? 250 : 245, controls.left ? 500 : 545); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(405, 530); ctx.lineTo(controls.right ? 310 : 315, controls.right ? 500 : 545); ctx.stroke();
    ctx.lineCap = 'butt';

    ctx.fillStyle = '#7ce8ff';
    ctx.font = '700 17px Tahoma';
    ctx.textAlign = 'left';
    ctx.fillText('STAR CIRCUIT', 38, 48);
    ctx.fillStyle = '#ffd463';
    ctx.font = '11px Tahoma';
    ctx.fillText('범퍼를 맞혀 신호를 모으세요', 38, 65);

    if (state.ball) {
      const shine = ctx.createRadialGradient(state.ball.x - 3, state.ball.y - 4, 1, state.ball.x, state.ball.y, state.ball.radius);
      shine.addColorStop(0, '#fff'); shine.addColorStop(0.3, '#d9f0ff'); shine.addColorStop(1, '#627991');
      ctx.fillStyle = shine;
      ctx.beginPath(); ctx.arc(state.ball.x, state.ball.y, state.ball.radius, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = '#345477';
    ctx.fillRect(canvas.width - 33, canvas.height - 116, 12, 90);
    const charge = instance.chargeStarted === null ? 0 : Math.min(1, (instance.now() - instance.chargeStarted) / 1200);
    ctx.fillStyle = '#ffbe32';
    ctx.fillRect(canvas.width - 33, canvas.height - 26 - charge * 90, 12, charge * 90);
    updatePinballPanel(instance);
  }

  function updatePinballPanel(instance) {
    instance.root.querySelector('[data-pinball-score]').textContent = String(instance.state.score).padStart(6, '0');
    instance.root.querySelector('[data-pinball-balls]').textContent = String(instance.state.ballsLeft);
    const status = instance.root.querySelector('[data-pinball-status]');
    if (instance.chargeStarted !== null) status.textContent = '플런저 충전 중… Space를 떼면 발사합니다.';
    else if (instance.state.gameOver) status.textContent = `게임 종료 · 최종 점수 ${instance.state.score}`;
    else if (instance.state.ball) status.textContent = '신호 탐색 중 · 범퍼를 노리세요!';
    else status.textContent = 'Space를 누르고 떼서 공을 발사하세요.';
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
