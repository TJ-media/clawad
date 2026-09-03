'use strict';
// 데스크톱 게임 스모크 (CLAW-255) — 지뢰찾기 규칙과 경계.
//
// games.js의 규칙 계산부는 DOM을 모르는 순수 함수라 브라우저 없이 그대로 부른다.
// 화면(mountMinesweeper)은 문자열 검사로만 본다 — 이 저장소에는 DOM 구현이 없다.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'apps', 'user-web');
const games = require(path.join(DIR, 'games.js'));
const GAMES = fs.readFileSync(path.join(DIR, 'games.js'), 'utf8');
// 금지어 검사는 주석을 빼고 본다 — "localStorage도 쓰지 않는다"라고 적어 둔 주석이
// localStorage를 쓴 것으로 잡히면, 규칙을 설명한 벌로 검사가 깨진다.
const GAMES_CODE = GAMES.replace(/\/\/.*$/gm, '');
const HTML = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');

const { CLOSED, OPEN, FLAG } = games;

// 판을 손으로 깐다. '*'가 지뢰다 — 무작위 배치로는 규칙을 확인할 수 없다.
function seed(layout) {
  const rows = layout.length;
  const cols = layout[0].length;
  let mines = 0;
  for (const row of layout) for (const ch of row) if (ch === '*') mines += 1;
  const board = games.createBoard({ cols, rows, mines });
  layout.forEach((row, y) => {
    [...row].forEach((ch, x) => { if (ch === '*') board.mine[y * cols + x] = 1; });
  });
  for (let i = 0; i < cols * rows; i += 1) {
    let sum = 0;
    for (const n of games.neighbors(board, i)) sum += board.mine[n];
    board.near[i] = sum;
  }
  board.planted = true;
  board.status = 'playing';
  return board;
}

function openedCount(board) {
  let n = 0;
  for (const cell of board.cell) if (cell === OPEN) n += 1;
  return n;
}

// 가운데 세로줄이 지뢰라 왼쪽·오른쪽이 갈린다. 연쇄가 어디서 멈추는지 볼 수 있다.
const WALL = ['..*..', '..*..', '..*..', '..*..', '..*..'];

test('초급 판은 9×9·지뢰 10개다', () => {
  assert.deepStrictEqual({ ...games.BEGINNER }, { cols: 9, rows: 9, mines: 10 });
  const board = games.createBoard(games.BEGINNER);
  assert.strictEqual(board.cell.length, 81);
  assert.strictEqual(board.status, 'ready');
  assert.strictEqual(board.planted, false, '첫 클릭 전에는 지뢰를 놓지 않는다');
});

// 첫 수에서 지는 게임은 게임이 아니다. 누른 칸뿐 아니라 이웃까지 비워야 첫 수가 넓게
// 열리고, 두 번째 수가 순전히 찍기가 되지 않는다.
test('첫 클릭한 칸과 그 이웃에는 지뢰를 놓지 않는다', () => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const board = games.createBoard(games.BEGINNER);
    const first = 40; // 한가운데
    games.plantMines(board, first);
    let planted = 0;
    for (const flag of board.mine) planted += flag;
    assert.strictEqual(planted, 10, '지뢰 수는 정책대로여야 한다');
    assert.strictEqual(board.mine[first], 0, '누른 칸이 지뢰면 안 된다');
    for (const n of games.neighbors(board, first)) {
      assert.strictEqual(board.mine[n], 0, '첫 클릭 주변도 비어 있어야 한다');
    }
  }
});

test('첫 클릭은 늘 연쇄로 열린다', () => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const board = games.createBoard(games.BEGINNER);
    games.reveal(board, 40);
    assert.ok(openedCount(board) >= 9, '누른 칸과 이웃 8칸은 최소한 열려야 한다');
    assert.strictEqual(board.status, 'playing');
  }
});

// 빈 칸이 모자랄 만큼 지뢰가 많은 판(작은 판)에서도 첫 수는 살아야 한다.
test('이웃까지 비울 수 없으면 누른 칸만 지킨다', () => {
  const board = games.createBoard({ cols: 3, rows: 3, mines: 8 });
  games.plantMines(board, 4);
  let planted = 0;
  for (const flag of board.mine) planted += flag;
  assert.strictEqual(planted, 8, '지뢰를 다 놓아야 한다');
  assert.strictEqual(board.mine[4], 0, '누른 칸은 그래도 안전해야 한다');
});

test('인접 지뢰 수를 정확히 센다', () => {
  const board = seed(WALL);
  assert.strictEqual(board.near[0], 0, '모서리는 지뢰줄에서 두 칸 떨어져 있다');
  assert.strictEqual(board.near[1], 2, '(1,0)은 위·아래 지뢰 둘에 닿는다');
  assert.strictEqual(board.near[6], 3, '(1,1)은 지뢰 셋에 닿는다');
});

test('0칸은 연쇄로 열리고 지뢰 줄에서 멈춘다', () => {
  const board = seed(WALL);
  games.reveal(board, 0);
  // 왼쪽 두 열(10칸)만 열린다. 지뢰 줄 건너편은 그대로 닫혀 있다.
  assert.strictEqual(openedCount(board), 10, '연쇄는 지뢰에 닿는 칸까지만 간다');
  assert.strictEqual(board.cell[3], CLOSED, '건너편은 열리지 않는다');
  assert.strictEqual(board.status, 'playing');
});

test('깃발을 꽂은 칸은 연쇄가 건너뛴다', () => {
  const board = seed(WALL);
  games.toggleFlag(board, 5);
  games.reveal(board, 0);
  assert.strictEqual(board.cell[5], FLAG, '깃발은 연쇄에 열리지 않는다');
  assert.strictEqual(openedCount(board), 3, '연쇄가 깃발에 막혀 세 칸만 열린다');
});

test('깃발은 켜고 끌 수 있고 열린 칸에는 꽂히지 않는다', () => {
  const board = seed(WALL);
  games.toggleFlag(board, 2);
  assert.strictEqual(board.cell[2], FLAG);
  assert.strictEqual(games.remainingMines(board), 4, '남은 지뢰 표시가 하나 줄어든다');
  games.toggleFlag(board, 2);
  assert.strictEqual(board.cell[2], CLOSED, '다시 누르면 걷힌다');

  games.reveal(board, 0);
  games.toggleFlag(board, 0);
  assert.strictEqual(board.cell[0], OPEN, '열린 칸에는 깃발이 꽂히지 않는다');
});

// 깃발을 지뢰 수보다 많이 꽂으면 카운터가 음수가 된다 — 막지 않는다. 사람이 세다 틀렸다는
// 신호이지 규칙 위반이 아니다.
test('남은 지뢰 표시는 음수까지 내려간다', () => {
  const board = seed(['*.', '..']);
  games.toggleFlag(board, 1);
  games.toggleFlag(board, 2);
  games.toggleFlag(board, 3);
  assert.strictEqual(games.remainingMines(board), -2);
  assert.strictEqual(games.counterDigits(-2), '-02');
});

test('지뢰를 밟으면 지고 밟은 자리가 남는다', () => {
  const board = seed(WALL);
  games.reveal(board, 2);
  assert.strictEqual(board.status, 'lost');
  assert.strictEqual(board.hit, 2, '어느 지뢰를 밟았는지 화면이 표시할 수 있어야 한다');
});

test('지뢰가 아닌 칸을 모두 열면 이긴다', () => {
  const board = seed(['...', '.*.', '...']);
  for (const i of [0, 1, 2, 3, 5, 6, 7, 8]) games.reveal(board, i);
  assert.strictEqual(board.status, 'won');
  // 지뢰 칸을 눌러서 이기는 게 아니다. 이긴 순간 남은 지뢰에 깃발이 저절로 꽂혀
  // 남은 지뢰 표시가 0으로 떨어진다 — 10에 멈춰 있으면 진 것처럼 읽힌다.
  assert.strictEqual(board.cell[4], FLAG, '이기면 남은 지뢰에 깃발이 꽂힌다');
  assert.strictEqual(games.remainingMines(board), 0, '남은 지뢰 표시가 0이어야 한다');
});

test('끝난 판은 더 이상 입력을 받지 않는다', () => {
  const board = seed(WALL);
  games.reveal(board, 2);
  assert.strictEqual(board.status, 'lost');
  games.reveal(board, 0);
  assert.strictEqual(board.cell[0], CLOSED, '진 뒤에는 칸이 열리지 않는다');
  games.toggleFlag(board, 0);
  assert.strictEqual(board.cell[0], CLOSED, '진 뒤에는 깃발도 꽂히지 않는다');
});

// 코딩은 편의 기능이지 안전 장치가 아니다. 깃발이 맞으면 빠르고, 틀리면 그대로 진다.
test('깃발 수가 숫자와 맞을 때만 주변을 한 번에 연다', () => {
  const board = seed(WALL);
  games.reveal(board, 1);
  assert.strictEqual(board.near[1], 2);

  games.chord(board, 1);
  assert.strictEqual(openedCount(board), 1, '깃발이 없으면 아무 일도 없다');

  games.toggleFlag(board, 2);
  games.chord(board, 1);
  assert.strictEqual(openedCount(board), 1, '깃발이 모자라도 아무 일도 없다');

  games.toggleFlag(board, 7);
  games.chord(board, 1);
  assert.ok(openedCount(board) > 1, '깃발이 맞으면 나머지 이웃이 열린다');
  assert.strictEqual(board.status, 'playing');
});

test('틀린 깃발로 코딩하면 그대로 진다', () => {
  const board = seed(WALL);
  games.reveal(board, 1);
  games.toggleFlag(board, 2);
  games.toggleFlag(board, 5); // 지뢰가 아닌 칸
  games.chord(board, 1);
  assert.strictEqual(board.status, 'lost', '틀린 깃발은 코딩이 지켜주지 않는다');
});

test('숫자가 없는 칸이나 닫힌 칸은 코딩 대상이 아니다', () => {
  const board = seed(WALL);
  games.chord(board, 1);
  assert.strictEqual(openedCount(board), 0, '닫힌 칸은 코딩할 수 없다');
  games.reveal(board, 0);
  const before = openedCount(board);
  games.chord(board, 0);
  assert.strictEqual(openedCount(board), before, '0칸은 코딩할 것이 없다');
});

test('카운터는 세 자리로 잘라 표시한다', () => {
  assert.strictEqual(games.counterDigits(0), '000');
  assert.strictEqual(games.counterDigits(10), '010');
  assert.strictEqual(games.counterDigits(999), '999');
  assert.strictEqual(games.counterDigits(1200), '999', '세 자리를 넘기지 않는다');
  assert.strictEqual(games.counterDigits(-150), '-99', '음수도 세 칸을 넘기지 않는다');
});

// ── 경계 (규칙 §2·§4·§5·§6) ──
// 게임은 놀거리다. 여기서 포인트가 생기거나 서버와 이야기하기 시작하면 사행성·경품 오인
// 문제가 되고, 노출 인정·리워드 판정과 데이터 경로가 섞인다.
test('게임 코드는 네트워크에 나가지 않는다 (CLAW-255)', () => {
  for (const forbidden of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'navigator.sendBeacon', 'EventSource']) {
    assert.ok(!GAMES_CODE.includes(forbidden), `games.js에 ${forbidden}이 있으면 안 된다`);
  }
});

test('게임 점수는 포인트·잔액·노출과 이어지지 않는다 (CLAW-255)', () => {
  // 리워드 도메인에서만 쓰는 이름들이다. 게임 코드에 하나라도 나오면 경계가 뚫린 것이다.
  // ('point'처럼 pointerdown·SVG points와 겹치는 낱말은 넣지 않는다 — 잡을 것을 못 잡는다.)
  for (const forbidden of ['balance', 'reward', 'serveToken', 'campaignId', 'impression',
    'ledger', 'redeem', 'machineId', '/v1/']) {
    assert.ok(!GAMES_CODE.includes(forbidden),
      `games.js가 ${forbidden}을 알면 안 된다 — 게임과 리워드는 남남이다`);
  }
  // 화면에도 그렇게 적어 둔다. 리워드 사이트 안의 게임이라 묻지 않아도 오해가 생긴다.
  assert.match(GAMES, /점수는 리워드 포인트와 아무 관계가 없습니다/, '무관하다고 화면에 적어야 한다');
});

test('게임은 기록을 남기지 않는다 (CLAW-253 창 배치와 같은 이유)', () => {
  for (const forbidden of ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie']) {
    assert.ok(!GAMES_CODE.includes(forbidden), `games.js에 ${forbidden}이 있으면 안 된다`);
  }
});

test('자체 그래픽과 고지된 CC0 카드 원화만 사용한다 (CLAW-255, CLAW-278)', () => {
  // 지뢰·깃발·표정·카운터는 코드에서 그리고, 카드 앞면만 고지한 CC0 원화를 쓴다.
  for (const marker of ['MINE_SVG', 'FLAG_SVG', 'FACES', 'SEGMENT_POINTS']) {
    assert.ok(GAMES.includes(marker), `${marker}가 있어야 한다`);
  }
  assert.doesNotMatch(GAMES, /<img|\.gif/, '게임 본문에 임의 비트맵을 넣으면 안 된다');
  const assetReferences = [...GAMES.matchAll(/url\('([^']+)'\)/g)].map((match) => match[1]);
  assert.deepStrictEqual(assetReferences, ['./icons/english-pattern-playing-cards@2x.png']);
  const cardAsset = path.join(DIR, 'icons', 'english-pattern-playing-cards@2x.png');
  assert.ok(fs.existsSync(cardAsset), 'CC0 카드 원화를 최적화한 PNG가 배포 자산에 있어야 한다');
  const png = fs.readFileSync(cardAsset);
  assert.deepStrictEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.deepStrictEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [2040, 822],
    '고해상도 화면에서도 카드가 선명하도록 2배 스프라이트를 사용해야 한다');
  const notice = fs.readFileSync(path.join(__dirname, '..', 'NOTICE.md'), 'utf8');
  assert.match(notice, /English pattern playing cards deck/);
  assert.match(notice, /CC0 1\.0 Universal/);
});

test('창 포인터 갱신은 한 화면 프레임에 마지막 좌표만 적용한다 (CLAW-278)', () => {
  const start = HTML.indexOf('function createFrameScheduler');
  const end = HTML.indexOf('// ── 창 이동', start);
  assert.ok(start >= 0 && end > start, '창 이동과 크기 조절이 공유할 프레임 스케줄러가 필요하다');
  const createFrameScheduler = new Function(
    `${HTML.slice(start, end)}; return createFrameScheduler;`,
  )();
  const frames = [];
  const applied = [];
  const scheduler = createFrameScheduler((callback) => frames.push(callback), (value) => applied.push(value));

  scheduler.schedule({ x: 1, y: 2 });
  scheduler.schedule({ x: 8, y: 9 });
  assert.strictEqual(frames.length, 1, '포인터 이벤트마다 새 프레임을 예약하면 안 된다');
  assert.deepStrictEqual(applied, []);
  frames[0]();
  assert.deepStrictEqual(applied, [{ x: 8, y: 9 }], '해당 프레임의 마지막 좌표만 적용해야 한다');

  scheduler.schedule({ x: 13, y: 21 });
  scheduler.flush();
  assert.deepStrictEqual(applied, [{ x: 8, y: 9 }, { x: 13, y: 21 }],
    '포인터를 놓을 때 예약된 마지막 좌표를 즉시 반영해야 한다');
  frames[1]();
  assert.strictEqual(applied.length, 2, '이미 반영한 좌표를 예약 프레임에서 중복 적용하면 안 된다');
});

// 광고 차단기의 범용 규칙은 도메인을 가리지 않고 클래스 이름만 보고 지운다 (CLAW-226).
// index.html은 이미 검사하지만 games.js가 만드는 클래스는 그 검사 밖이다.
test('games.js가 만드는 class에 ad 토큰이 없다 (CLAW-226)', () => {
  const values = [...GAMES.matchAll(/class(?:Name)?\s*=\s*'([^']*)'/g), ...GAMES.matchAll(/class="([^"]*)"/g)]
    .map((m) => m[1]);
  assert.ok(values.length > 0, '검사할 class가 있어야 한다');
  for (const value of values) {
    for (const token of value.replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)) {
      if (!token) continue;
      assert.doesNotMatch(token, /(^|-)ads?(-|$)/i, `class="${token}"이 광고 차단 규칙에 걸린다`);
    }
  }
});

// ── 창 연결 ──
test('게임 코드는 창을 처음 열 때만 받아온다 (CLAW-255)', () => {
  assert.match(HTML, /script\.src = '\.\/games\.js'/, '게임 코드는 별도 파일이어야 한다');
  assert.ok(!HTML.includes('<script src="./games.js"'),
    '리워드 샵을 보러 온 사람에게까지 게임 코드를 내려보내지 않는다');
  // 지뢰찾기·핀볼·두 카드놀이가 같은 레지스트리를 탄다 — 게임마다 전용 로더를 두지 않는다.
  assert.match(HTML, /const GAME_IDS = new Set\(\['mine', 'pinball', 'solitaire', 'spider'\]\)/,
    '네 게임이 모두 등록돼 있어야 한다');
  assert.match(HTML, /prepareGame\(id\);/, '창을 열 때 게임을 붙여야 한다');
  assert.ok(!/startMinesweeper/.test(HTML), '지뢰찾기 전용 로더가 남아 있으면 안 된다');
  // 한 번 실패해도 다음에 다시 받아올 수 있어야 한다.
  assert.match(HTML, /gamesScriptPromise = null;/, '실패한 약속을 남겨두면 안 된다');
  assert.match(HTML, /게임을 불러오지 못했습니다/, '실패를 알려야 한다');
});

test('창을 닫으면 판과 타이머가 정리된다 (CLAW-255)', () => {
  const close = HTML.slice(HTML.indexOf('function closeWindow(id, options = {})'), HTML.indexOf('function closeAllWindows'));
  assert.match(close, /disposeGame\(id\);/, '닫을 때 정리해야 한다');
  const closeAll = HTML.slice(HTML.indexOf('function closeAllWindows()'), HTML.indexOf('function renderTaskbar'));
  assert.match(closeAll, /disposeGame\(id\);/, '로그아웃·탈퇴로 창을 접을 때도 타이머가 남으면 안 된다');
  assert.match(GAMES, /function stopMineTimer\(instance\) \{[\s\S]{0,120}clearInterval\(instance\.timerId\)/,
    '타이머를 실제로 멈춰야 한다');
  // 최소화는 파기가 아니다 — 멈췄다가 복원하면 이어져야 한다.
  const minimize = HTML.slice(HTML.indexOf('function minimizeWindow(id)'), HTML.indexOf('function setMaximizeButton'));
  assert.match(minimize, /pauseGame\(id\);/, '최소화하면 게임을 멈춰야 한다');
  assert.match(GAMES, /instance\.elapsedMs \+= Date\.now\(\) - instance\.runningSince/,
    '멈춘 동안의 시간은 시계에 더하지 않는다');
});

test('게임 창에는 서비스 상단 메뉴를 붙이지 않는다 (CLAW-255)', () => {
  assert.match(HTML, /class="win win-game win-mine xp-window hidden" data-win="mine"/,
    '게임 창은 win-game이고 크기는 win-mine이 정한다');
  // 가르는 기준은 상단 메뉴에 자리가 있느냐(=WINDOWS에 href가 있느냐)다. 게임 창은 주소가
  // 없으니 광고주·로그인 창과 함께 자동으로 빠진다 — 게임 전용 예외를 따로 두지 않는다.
  const table = HTML.slice(HTML.indexOf('const WINDOWS = {'), HTML.indexOf('// 로그인 여부.'));
  const mineRow = table.match(/^\s{8}mine: \{[^\n]*$/m);
  assert.ok(mineRow, 'WINDOWS 표에 게임 창이 있어야 한다');
  assert.ok(!mineRow[0].includes('href:'), '게임 창에 상단 메뉴 주소를 주면 메뉴가 붙는다');
  const clone = HTML.slice(HTML.indexOf('function cloneMenubars()'), HTML.indexOf('function topmostWindow'));
  assert.match(clone, /if \(!MENU_HREFS\[el\.dataset\.win\]\) continue;/,
    '주소 없는 창은 메뉴 복제에서 빠져야 한다');
});

// 게임 코드는 HTML 속성이 아니라 JS가 부른다 — 페이지 자산 검사(src="./…")가 잡지 못한다.
// 배포 목록에서 빠지면 로컬·CI는 전부 통과하고 배포본에서만 404가 난다 (CLAW-203).
test('게임 코드와 솔버 워커가 배포 이미지와 캐시 규칙에 등록돼 있다 (CLAW-255, CLAW-278, CLAW-279)', () => {
  const dockerfile = fs.readFileSync(path.join(DIR, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /apps\/user-web\/games\.js/, 'Dockerfile COPY 목록에 games.js가 있어야 한다');
  assert.match(dockerfile, /apps\/user-web\/spider-solitaire\.js/,
    'Dockerfile COPY 목록에 스파이더 엔진이 있어야 한다');
  assert.match(dockerfile, /apps\/user-web\/spider-presentation\.js/,
    '완료 연출 모듈도 이미지에서 제공해야 한다');
  assert.match(dockerfile, /apps\/user-web\/solitaire-solver\.js/);
  assert.match(dockerfile, /apps\/user-web\/solitaire-worker\.js/);
  const caddyfile = fs.readFileSync(path.join(DIR, 'Caddyfile'), 'utf8');
  const versioned = caddyfile.split('\n').find((line) => line.includes('@versionedContent path'));
  assert.ok(versioned.includes('/games.js'),
    'games.js는 no-store여야 한다 — 캐시된 옛 게임 코드가 새 index.html과 만나면 깨진다');
  assert.ok(versioned.includes('/spider-solitaire.js'),
    '스파이더 엔진도 새 셸·게임 코드와 버전이 어긋나지 않게 no-store여야 한다');
  assert.ok(versioned.includes('/spider-presentation.js'));
  assert.ok(versioned.includes('/solitaire-solver.js'));
  assert.ok(versioned.includes('/solitaire-worker.js'));
  assert.match(caddyfile, /worker-src 'self'/);
  assert.ok(fs.existsSync(path.join(DIR, 'icons', 'mine.png')), '창·작업 표시줄 아이콘이 있어야 한다');
});

// 위 검사는 저장소 안의 설정만 본다. 그것들이 맞아도 배포본에서 games.js가 실제로 200으로
// 오는지는 확인하지 못한다 — 그건 운영 스모크만 알 수 있다. 지뢰찾기 배포(2026-08-21) 때
// 그 구간이 비어 있어 사람이 직접 열어봐야 했다.
test('운영 스모크가 games.js를 직접 받아본다 (CLAW-255)', () => {
  const smoke = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'production-smoke.js'), 'utf8');
  assert.match(smoke, /checkWeb\('\/games\.js', 'ClawadGames'\)/,
    '배포 후 games.js가 200으로 오는지 확인해야 한다');
  // checkWeb은 상태·release SHA·no-store 헤더·본문 표식을 한 번에 본다. 그 계약이 바뀌면
  // 이 검사도 함께 봐야 하므로 여기서 못 박는다.
  assert.match(smoke, /if \(response\.headers\.get\('x-clawad-release'\) !== releaseSha\)/,
    'checkWeb은 release SHA가 맞는지 봐야 한다');
});

test('접근성: 칸은 버튼이고 키보드로 열고 깃발을 꽂는다 (CLAW-255)', () => {
  assert.match(GAMES, /doc\.createElement\('button'\)/, '칸은 버튼이어야 한다 — Enter·Space가 그냥 먹는다');
  assert.match(GAMES, /cell\.setAttribute\('aria-label', `\$\{row\}행 \$\{col\}열/, '칸마다 위치·상태를 읽어줘야 한다');
  assert.match(GAMES, /event\.code === 'KeyF'/, '한글 자판에서도 F가 깃발이어야 한다');
  assert.match(GAMES, /cell\.tabIndex = index === instance\.cursor \? 0 : -1/, '포커스는 한 번에 한 칸만 받는다');
  assert.match(GAMES, /aria-live="polite"/, '승패를 보조기술에 알려야 한다');
  // 끝난 판을 disabled로 막으면 보조기술이 결과를 훑어볼 수 없다.
  assert.ok(!GAMES.includes('cell.disabled'), '끝난 판의 칸을 disabled로 만들면 안 된다');
});

// `.win`은 창 안 레이아웃이 창 폭에 반응하도록 container-type: inline-size를 건다. 그 상태로
// width: max-content를 주면 폭이 내용과 무관하게 계산돼(inline-size 컨테인먼트) 0이 되고,
// 창이 보이지 않는 실선으로 접힌다 — 실제로 그렇게 한 번 접혔다.
test('판 크기에 맞춰 줄어드는 창은 컨테이너를 끈다 (CLAW-255)', () => {
  const common = HTML.slice(HTML.indexOf('.win-game {'), HTML.indexOf('}', HTML.indexOf('.win-game {')));
  assert.match(common, /container-type: normal/,
    'inline-size 컨테인먼트를 끄지 않으면 max-content가 0이 된다');
  const mine = HTML.slice(HTML.indexOf('.win-mine {'), HTML.indexOf('}', HTML.indexOf('.win-mine {')));
  assert.match(mine, /width: max-content/, '지뢰찾기 창은 판 크기에 맞춘다');
  // 크기는 게임마다 다르다. 공통 규칙이 폭을 못박으면 핀볼·카드놀이가 같이 줄어든다.
  assert.ok(!/width:/.test(common), '공통 규칙이 폭을 정하면 안 된다');
});

test('승리 연출은 동작 최소화 설정을 존중한다 (CLAW-255)', () => {
  const reduced = HTML.slice(HTML.indexOf('@media (prefers-reduced-motion'));
  assert.match(reduced, /\.mine-face\.won svg \{ animation: none; \}/, '승리 연출을 멈춰야 한다');
});

// 난이도 세 가지는 고전 지뢰찾기의 초급·중급·고급이다. 판이 정사각형이 아닌 고급에서
// 행·열 계산이 어긋나면 여기서 잡힌다.
test('난이도 세 가지가 각자의 판과 지뢰 수를 만든다', () => {
  assert.deepStrictEqual(Object.keys(games.MINE_PRESETS), ['easy', 'normal', 'hard']);
  assert.deepStrictEqual({ ...games.MINE_PRESETS.normal }, { cols: 16, rows: 16, mines: 40 });
  assert.deepStrictEqual({ ...games.MINE_PRESETS.hard }, { cols: 30, rows: 16, mines: 99 });
  for (const [key, preset] of Object.entries(games.MINE_PRESETS)) {
    const board = games.createBoard(preset);
    assert.strictEqual(board.cell.length, preset.cols * preset.rows, `${key} 판 크기`);
    assert.ok(preset.mines < preset.cols * preset.rows, `${key}는 첫 수를 둘 빈 칸이 있어야 한다`);
    // 첫 수 자리에는 지뢰를 놓지 않는다 — 가장자리든 가운데든 마찬가지다.
    games.reveal(board, 0);
    assert.strictEqual(board.mine[0], 0, `${key} 첫 칸이 지뢰면 안 된다`);
    let planted = 0;
    for (const mine of board.mine) planted += mine;
    assert.strictEqual(planted, preset.mines, `${key} 지뢰 수`);
  }
});

// 창을 키우면 판만이 아니라 칸 테두리·표시부까지 한 배율로 커진다. 되먹임(판이 커져 창이
// 커지고 그 창이 다시 판을 키우는 고리)을 끊는 것은 "창 크기를 못박은 뒤에만" 가드 하나뿐이다.
test('지뢰찾기는 껍데기 전체가 같은 비율로 커지고 최대에서 멈춘다', () => {
  assert.match(HTML, /\.mine-shell \{[^}]*zoom: var\(--mine-scale\)/, '요소마다 따로가 아니라 껍데기를 통째로 늘려야 한다');
  assert.match(GAMES, /MINE_CELL = 22/, '배율 1은 지금 칸 크기여야 한다 — 창이 작아도 지금보다 작아지지 않는다');
  assert.match(GAMES, /MINE_CELL_MAX = \d+/, '더 커지지 않는 상한이 있어야 한다');
  assert.match(GAMES, /Math\.max\(MINE_CELL, Math\.min\(MINE_CELL_MAX, cell\)\) \/ MINE_CELL/,
    '배율은 칸 픽셀 단위로 끊어야 칸이 전부 같은 정수 크기로 떨어진다');
  assert.match(GAMES, /win\.style\.width \|\| win\.classList\.contains\('win-max'\)/,
    '창 크기를 못박은 뒤에만 계산해야 한다 — max-content 창에서 계산하면 창과 판이 서로를 키운다');
  assert.match(GAMES, /new view\.ResizeObserver\(\(\) => fitMineShell\(instance\)\)/, '창 크기가 바뀌면 다시 맞춰야 한다');
  // 창 높이가 남아야 그 자리를 판에 줄 수 있다. flex-basis가 0이면 판이 0px로 접힌다.
  const root = HTML.slice(HTML.indexOf('.win-mine > .game-root'));
  assert.match(root.slice(0, root.indexOf('}')), /flex: 1 1 auto/, '남는 높이를 받되 내용 높이도 지켜야 한다');
  // 안내 문구 폭도 같은 배율을 타야 판 옆이 아니라 판 아래에 맞춰 접힌다.
  assert.match(HTML, /max-width: calc\(\(var\(--mine-cols, 9\) \* var\(--mine-cell\) \+ 24px\) \* var\(--mine-scale\)\)/);
});

test('난이도는 게임 메뉴에서 고르고 지금 난이도가 보인다', () => {
  const start = HTML.indexOf('id="mineView"');
  const mine = HTML.slice(start, HTML.indexOf('</section>', start));
  assert.match(mine, /data-mine-menu-trigger[^>]+aria-haspopup="menu"[^>]+aria-expanded="false"[^>]*>게임\(G\)<\/button>/);
  assert.match(mine, /class="game-popup"[^>]+role="menu"[^>]+data-mine-game-menu[^>]+hidden/);
  for (const [key, checked] of [['easy', true], ['normal', false], ['hard', false]]) {
    assert.match(mine, new RegExp(`role="menuitemradio"[^>]+data-game-command="mine-${key}"[^>]+data-mine-difficulty="${key}"[^>]+aria-checked="${checked}"`),
      `${key}는 현재 선택을 나타내는 체크 메뉴여야 한다`);
  }
  assert.match(mine, /data-game-command="new-mine"[^>]*>새 게임\(N\)<\/button>/);
  // 난이도를 바꾸면 판 모양이 달라진다 — 못박아 둔 창 크기를 버려야 큰 판이 잘리지 않는다.
  assert.match(GAMES, /instance\.section\.style\.width = '';/);
  // Escape는 창이 아니라 메뉴만 닫아야 한다.
  assert.match(GAMES, /instance\.onMenuKeyDown = \(event\) => \{[\s\S]*?event\.stopPropagation\(\);/);
});

// 어려움 30×16은 폰 너비에 들어가지 않는다. 좁은 화면에서는 세로로 돌려 깐다.
test('좁은 화면에서는 가로로 긴 판을 세로로 돌린다', () => {
  const root = (matches) => ({ ownerDocument: { defaultView: { matchMedia: () => ({ matches }) } } });
  const { easy, normal, hard } = games.MINE_PRESETS;
  assert.deepStrictEqual({ ...games.minePresetFor(root(true), hard) }, { cols: 16, rows: 30, mines: 99 },
    '어려움은 좁은 화면에서 16×30이어야 한다');
  assert.strictEqual(games.minePresetFor(root(false), hard), hard, '넓은 화면은 그대로 30×16이다');
  // 정사각형 판은 돌릴 것이 없다 — 좁든 넓든 같은 판이어야 한다.
  for (const preset of [easy, normal]) {
    assert.strictEqual(games.minePresetFor(root(true), preset), preset);
    assert.strictEqual(games.minePresetFor(root(false), preset), preset);
  }
  // 돌린 판도 지뢰 수와 칸 수는 같다.
  const board = games.createBoard(games.minePresetFor(root(true), hard));
  assert.strictEqual(board.cell.length, hard.cols * hard.rows);
  assert.strictEqual(board.mines, hard.mines);
  // 넘친 판은 가운데가 아니라 위에서부터 놓아야 지뢰 수·얼굴 버튼에 닿는다.
  const mineRoot = HTML.slice(HTML.indexOf('.win-mine > .game-root'));
  assert.match(mineRoot.slice(0, mineRoot.indexOf('}')), /place-content: safe center/);
  // 좁은 화면에서는 창을 못 늘리므로 칸을 줄여 가로 스크롤을 없앤다.
  assert.match(HTML.slice(HTML.indexOf('@media (max-width: 640px)')),
    /\.win-mine > \.game-root \{ --mine-cell: min\(22px, calc\(\(100vw - 48px\) \/ var\(--mine-cols, 9\)\)\); \}/);
});
