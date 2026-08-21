'use strict';
// 클로애드 데스크톱 게임 — 지뢰찾기 (CLAW-255).
//
// 경계 [CRITICAL]: 이 파일은 광고·노출·리워드 경로와 아무 것도 공유하지 않는다.
// 네트워크 호출이 없고, 점수·승패가 포인트·잔액·노출 인정에 닿지 않는다. 판은 메모리에만
// 있고 창을 닫으면 사라진다(localStorage도 쓰지 않는다 — 최고 기록을 남길 이유가 없다).
//
// 규칙 계산부는 DOM을 모르는 순수 함수다 — test/minesweeper.test.js가 브라우저 없이
// 그대로 부른다. DOM은 mountMinesweeper 아래에만 있다.
//
// 그래픽(지뢰·깃발·표정·7세그먼트)은 전부 이 파일 안에서 SVG로 그린다. 남의 게임 자산을
// 가져다 쓰지 않는다.
(function exposeGames(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ClawadGames = api;
})(typeof globalThis === 'object' ? globalThis : window, function buildGames() {
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

  // ── 화면 ──
  const MAX_SECONDS = 999;
  const CELL_STATE_LABEL = { [CLOSED]: '닫힘', [FLAG]: '깃발' };

  function mountMinesweeper(host, options) {
    const preset = (options && options.preset) || BEGINNER;
    const random = options && options.random;
    const doc = host.ownerDocument;
    let board = createBoard(preset);
    let cursor = Math.floor(preset.rows / 2) * preset.cols + Math.floor(preset.cols / 2);
    let startedAt = 0;
    let frozenSeconds = 0;
    let ticker = null;
    let pressing = false;

    host.innerHTML = `
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

    const boardEl = host.querySelector('[data-role="board"]');
    const faceEl = host.querySelector('[data-role="face"]');
    const minesEl = host.querySelector('[data-role="mines"]');
    const clockEl = host.querySelector('[data-role="clock"]');
    const liveEl = host.querySelector('[data-role="live"]');

    // 열 수는 판뿐 아니라 안내 문구 폭도 정한다 — 판만이 아니라 host에 건다.
    host.style.setProperty('--mine-cols', String(preset.cols));
    const cells = [];
    for (let i = 0; i < preset.cols * preset.rows; i += 1) {
      const cell = doc.createElement('button');
      cell.type = 'button';
      cell.className = 'mine-cell';
      cell.dataset.index = String(i);
      cell.tabIndex = -1;
      boardEl.appendChild(cell);
      cells.push(cell);
    }

    function elapsedSeconds() {
      if (!startedAt) return frozenSeconds;
      return Math.min(MAX_SECONDS, Math.floor((Date.now() - startedAt) / 1000));
    }

    function stopTicker() {
      if (ticker === null) return;
      clearInterval(ticker);
      ticker = null;
    }

    function startTicker() {
      if (ticker !== null) return;
      ticker = setInterval(() => {
        renderClock();
        if (elapsedSeconds() >= MAX_SECONDS) stopTicker();
      }, 1000);
    }

    function renderClock() {
      const seconds = elapsedSeconds();
      clockEl.innerHTML = counterHtml(seconds);
      clockEl.setAttribute('aria-label', `경과 ${seconds}초`);
    }

    function renderPanel() {
      const left = remainingMines(board);
      minesEl.innerHTML = counterHtml(left);
      minesEl.setAttribute('aria-label', `남은 지뢰 표시 ${left}`);
      const state = board.status === 'won' ? 'won' : board.status === 'lost' ? 'lost' : pressing ? 'press' : 'smile';
      faceEl.innerHTML = faceSvg(state);
      faceEl.classList.toggle('won', board.status === 'won');
      renderClock();
    }

    // 패배하면 못 찾은 지뢰를 모두 드러내고, 잘못 꽂은 깃발에 가위표를 친다.
    function paintCell(index) {
      const cell = cells[index];
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
        cell.classList.add('open');
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
      cell.tabIndex = index === cursor ? 0 : -1;
    }

    function renderBoard() {
      for (let i = 0; i < cells.length; i += 1) paintCell(i);
    }

    function announce() {
      if (board.status === 'won') {
        liveEl.textContent = `이겼습니다. 지뢰 ${board.mines}개를 ${elapsedSeconds()}초에 모두 찾았습니다.`;
      } else if (board.status === 'lost') {
        liveEl.textContent = '지뢰를 밟았습니다. 얼굴 버튼을 눌러 새 판을 시작하세요.';
      } else {
        liveEl.textContent = '';
      }
    }

    function render() {
      renderBoard();
      renderPanel();
    }

    function afterMove() {
      if (board.status === 'playing' && !startedAt) { startedAt = Date.now(); startTicker(); }
      if (finished(board)) {
        frozenSeconds = elapsedSeconds();
        startedAt = 0;
        stopTicker();
      }
      render();
      announce();
    }

    function reset() {
      board = createBoard(preset);
      startedAt = 0;
      frozenSeconds = 0;
      pressing = false;
      stopTicker();
      render();
      announce();
    }

    function moveCursor(next) {
      if (next < 0 || next >= cells.length) return;
      cursor = next;
      for (let i = 0; i < cells.length; i += 1) cells[i].tabIndex = i === cursor ? 0 : -1;
      cells[cursor].focus();
    }

    // ── 입력 ──
    boardEl.addEventListener('click', (event) => {
      const cell = event.target.closest('.mine-cell');
      if (!cell) return;
      const index = Number(cell.dataset.index);
      cursor = index;
      // 이미 열린 숫자 칸을 다시 누르면 코딩이다. 그 외에는 그냥 연다.
      if (board.cell[index] === OPEN) chord(board, index, random);
      else reveal(board, index, random);
      afterMove();
    });

    boardEl.addEventListener('contextmenu', (event) => {
      const cell = event.target.closest('.mine-cell');
      if (!cell) return;
      event.preventDefault();
      toggleFlag(board, Number(cell.dataset.index));
      afterMove();
    });

    // 누르는 동안 표정이 바뀐다. 판이 끝난 뒤에는 바뀌지 않는다.
    boardEl.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || finished(board)) return;
      pressing = true;
      renderPanel();
    });
    const releasePress = () => {
      if (!pressing) return;
      pressing = false;
      renderPanel();
    };
    boardEl.addEventListener('pointerup', releasePress);
    boardEl.addEventListener('pointerleave', releasePress);
    boardEl.addEventListener('pointercancel', releasePress);

    // 화살표로 칸 사이를 옮긴다. 포커스는 한 번에 한 칸만 받는다(roving tabindex).
    const ARROWS = {
      ArrowUp: (i) => i - board.cols,
      ArrowDown: (i) => i + board.cols,
      ArrowLeft: (i) => (i % board.cols === 0 ? i : i - 1),
      ArrowRight: (i) => ((i + 1) % board.cols === 0 ? i : i + 1),
      Home: (i) => Math.floor(i / board.cols) * board.cols,
      End: (i) => Math.floor(i / board.cols) * board.cols + board.cols - 1,
    };
    boardEl.addEventListener('keydown', (event) => {
      // 한글 자판에서도 F가 깃발이어야 한다 — 글자(key)가 아니라 자리(code)를 본다.
      if (event.code === 'KeyF') {
        event.preventDefault();
        toggleFlag(board, cursor);
        afterMove();
        if (cells[cursor]) cells[cursor].focus();
        return;
      }
      const move = ARROWS[event.key];
      if (!move) return;
      event.preventDefault();
      moveCursor(move(cursor));
    });

    faceEl.addEventListener('click', reset);

    render();
    announce();

    return {
      reset,
      destroy() {
        stopTicker();
        host.innerHTML = '';
      },
      // 검사·디버깅용. 화면은 이 값을 읽어 판단하지 않는다.
      get board() { return board; },
    };
  }

  return {
    CLOSED,
    OPEN,
    FLAG,
    BEGINNER,
    createBoard,
    neighbors,
    plantMines,
    reveal,
    toggleFlag,
    flagCount,
    remainingMines,
    chord,
    counterDigits,
    mountMinesweeper,
  };
});
