# 애드워드 걸음 애니메이션과 어지러움 반응 (CLAW-286)

바탕화면 애드워드에 두 가지 표현을 넣는다. 자유배회 중 **걸어다니는 모션**과, idle에서 마우스가 주위를 빙빙 돌면 **어지러워하는 반응**이다. 둘 다 같은 테마 빌드·전파 경로를 타므로 한 쌍의 PR로 함께 낸다.

원본은 clawad 레포다. `mascot/theme-build.js`가 파츠 PNG와 상태별 CSS로 상태 SVG와 `theme.json`을 생성하고, 그 산출물이 오버레이 번들로 전파된다.

---

## 1. 자유배회 걸음 애니메이션

### 지금 상태

`roam` 상태의 인프라는 전부 깔려 있다.

- `roam.js`가 창을 옮기기 **전에** 비주얼 상태를 `roam`으로 바꾼다 (80px/s). "idle 마스코트가 끌려다니는" 회귀를 막기 위한 설계다.
- `state-visual-resolver.js:42` — 테마에 `roam` 바인딩이 없으면 `{ files: [], fallbackTo: "idle" }`를 심는다.
- `renderer.js:456` — roam 비주얼이 있으면 진행 방향에 맞춰 좌우 반전을 **자동으로** 한다 (`_roamHeadingLeft !== _roamFlipAssets`).
- `renderer.js:1582` — roam 비주얼이 **없을 때만** `.roam-walk` 클래스를 붙이고, `styles.css:105`가 3px짜리 좌우 흔들림을 준다.

애드워드 테마에 `states.roam`이 없다. 그래서 idle SVG(제자리 숨쉬기)에 3px 흔들림만 얹혀 **선 채로 미끄러져 간다.**

### 변경

`mascot/theme-build.js`에 `STATES['roam']`을 추가하고 생성되는 `theme.json`의 `states`에 `roam: ['clawad-roam.svg']`를 등록한다.

모션은 **제자리 걸음 + 진행 방향 기울이기**다. 창 자체가 이동하므로 스프라이트를 좌우로 움직이면 이동과 겹쳐 출렁인다.

| 파츠 | 모션 |
|---|---|
| `.pet` | 걸음 박자 상하 바운스 + 진행 방향 약 3도 기울기 |
| `.lg1~4` | 0.29s 순차 스텝 (`mini-crabwalk`의 `mcStep` 박자 재사용, 다리마다 지연) |
| `.ant-l`/`.ant-r` | 관성으로 뒤로 흘렸다 돌아옴 |
| `.tail` | 걸음에 맞춘 흔들림 |
| `.arm-big`/`.arm-sm` | 걸음 반박자 스윙 |

`viewBox`는 기존 `DEFAULT_VB`를 유지한다. 좌우 이동이 없으니 게걸음처럼 캔버스를 넓힐 이유가 없고, 상태를 갈아끼울 때 `preserveAspectRatio` 때문에 크기가 튀는 문제(CLAW-256)를 피한다.

눈 추적 래퍼(`#body-js`/`#eyes-js`)는 넣지 않는다. `_eyeTrackingStates` 기본값이 `["idle", "dozing", "mini-idle"]`이라 roam은 추적 대상이 아니고, 추적 변환과 좌우 반전이 겹치면 시선이 뒤집힌다. `mini-crabwalk`과 같은 구조다.

`roamFlipAssets`는 설정하지 않는다(기본 `false`). 아트가 큰 집게 쪽 — 오른쪽을 향하고, 왼쪽으로 걸을 때 렌더러가 반전한다.

### 부수 효과

테마가 roam 비주얼을 갖게 되면 `renderer.js:1582`의 조건이 거짓이 되어 `.roam-walk` 폴백이 자동으로 꺼진다. 오버레이 코드는 건드리지 않는다.

---

## 2. 어지러움 반응

idle 상태에서 마우스가 마스코트 주위를 **2초 안에 1.5바퀴(540도)** 돌면 어지러워하는 반응을 재생한다. 눈이 마우스를 따라가는 기능이 이미 있어서 "눈이 따라 돌다 지친다"는 인과가 화면에서 성립한다.

### 감지 — 이미 있던 것과 바꿀 것

설계 단계에서 놓쳤던 사실: **각도 누적 감지기는 이미 `tick.js`에 있다.** 상류가 구현해 둔 기능이고, 눈 추적 블록 안에서 `relX`/`relY`/`dist`를 그대로 쓴다. 바꿔야 하는 것은 세 가지뿐이다.

| | 기존 | 이번 |
|---|---|---|
| 임계 | `Math.PI * 4` (2바퀴) | `Math.PI * 3` (1.5바퀴) |
| 시간 제한 | 없음. 500ms 멈추면 리셋 | 2초 슬라이딩 창 |
| 누적 구조 | `tick.js` 안 인라인 스칼라 | `src/spin-meter.js` 모듈 |

시간 창이 핵심이다. 창이 없으면 아주 느린 드리프트가 1분에 걸쳐 한 바퀴로 쌓여 아무도 의도하지 않은 제스처가 발동한다.

누적 규칙을 `spin-meter.js`로 뺀 이유는 테스트다. `tick.js`의 그 블록은 살아 있는 커서와 펫 창과 테마가 있어야 도는데, 단위 테스트는 셋 다 줄 수 없다. 모듈은 순수 함수라 `(각도, 거리, 시각)`만 먹인다.

블록의 게이트(`idleNow && !miniIdleNow && !isMouseIdle && moved && THEME_SUPPORTS_DIZZY`)는 그대로 둔다 — **idle + 추적 비주얼 + 마우스 활동 중**이라 요구사항과 이미 같다.

```
angle = atan2(relY, relX)
delta = 직전 샘플과의 최단 부호각, (-π, π]로 정규화
링에 {시각, delta} 누적, 2000ms 넘은 항목 폐기
|Σ delta| >= 540°  →  발동
```

부호를 그대로 더하므로 **방향이 일정해야만** 쌓인다. 좌우로 흔들면 상쇄되어 안 터진다. 방향 일치 검사를 따로 두지 않는다.

마우스가 움직이는 동안 틱은 `BOOST_TICK_MS`(100ms)라 2초에 20샘플, 샘플당 평균 27도다. 180도 앨리어싱 한계에서 멀다.

### 오발동 가드

기존 상수를 그대로 쓴다. 최대 거리 제한은 넣지 않았다 — 2초 창이 있으면 화면을 가로지르는 대각선 이동으로는 540도가 쌓이지 않아서 없어도 된다.

| 가드 | 값 | 이유 |
|---|---|---|
| 최소 거리 | 24px | 중심 근처에서는 손떨림이 큰 각도로 잡힌다. |
| 샘플 간격 | 500ms 초과면 누적 리셋 | 멈추기 전 각도와 멈춘 뒤 각도를 비교하면 커서가 실제로 지나지 않은 이동이 계산된다. |
| 쿨다운 | 발동 후 12초 | 계속 돌리는 동안 반복 발동하지 않게. |

### 발동과 테마 통합

리액션이 아니라 **상태**다. `ctx.setState("dizzy")`로 들어가고, 앱은 `THEME_SUPPORTS_DIZZY` 게이트로 테마 지원 여부를 본다 — **`states.dizzy`와 `timings.autoReturn.dizzy`가 둘 다** 있어야 켜진다. 그래서 `theme.json`에 상태와 타이밍을 함께 등록한다(`minDisplay.dizzy`도 같은 값으로). 바인딩이 없는 테마는 감지 계산 자체를 건너뛴다.

`dizzy`는 `state-priority.js`의 우선순위 표에 없어 0으로 잡힌다. 작업이 시작되면 즉시 덮인다 — 개그가 실제 작업을 가리지 않는다.

### 애니메이션 (`clawad-dizzy.svg`)

- **눈** — 기존 `p-eye-l/r.png`를 CSS로 가리고(`sleeping`이 `.blink`를 눌러 감기는 방식과 같다), 인라인 `<path>`로 그린 골뱅이(나선) 눈 2개를 그 자리에 놓는다. 각자 제자리 회전하며 서로 반대 방향으로 돈다. `bodyMarkup`에 `.face` 안쪽 슬롯(`eyesExtra`)을 하나 열어 PNG 눈과 같은 좌표계에 그린다 — `.face`의 `scale(0.75)`를 손으로 환산하지 않아도 된다.
- **별** — 머리 위에 노랑(`#ffd23e`) ~ 주황(`#ff8a5c`) 4각 별 3개가 궤도를 돌고, 같은 색 궤도 호(arc)가 함께 회전한다. 별 path는 `attention` 상태의 `.spark`와 같은 모양을 재사용한다.
- **몸** — 좌우 비틀거림, 더듬이 축 늘어짐, 다리 버둥.

브라우저에서 렌더해 보고 고친 세 가지:

1. **회전은 자식 `g`가 맡는다.** `transform` 속성을 가진 엘리먼트에 CSS `rotate`를 같이 걸면 `transform-box: fill-box`의 기준 상자가 그 속성 변환 뒤에 잡혀서, 제자리 회전이 아니라 먼 점을 도는 궤도 운동이 된다. 실측으로 0도에서 (111,226)이던 눈이 90도에서 (-81,162)로 튀었다. 자리 잡기와 회전을 다른 엘리먼트로 나누면 세 각도 모두 같은 자리에 머문다.
2. **나선에 흰 테두리를 두르지 않는다.** `zPixel`이 Z를 읽히게 하는 방식이지만, 나선에서는 그 테두리가 골을 메워 그냥 동그라미가 된다. 크림색 안구 원판을 깔면 얼굴색과 분리되면서 골도 남는다. 회전 수도 다섯 바퀴에서 1.5바퀴로 줄여야 작게 그려도 감긴 게 보인다.
3. **궤도에 보이지 않는 기준 원을 넣는다.** 호가 반 바퀴뿐이라 그것만으로는 경계 상자가 중심에서 치우쳐 `fill-box`의 center가 궤도 중심과 어긋난다. `getBBox`는 칠하지 않은 도형도 세므로 원 하나면 상자가 원점 대칭이 된다.

테마 새니타이저(`theme-sanitizer.js`)는 거부목록 방식이다 — `script`·`foreignObject`·`iframe` 류와 `on*` 속성, 외부·`data:` URL만 막는다. `<path>`·`<circle>`·`<rect>` 같은 인라인 벡터 도형은 그대로 통과한다.

---

## 전파

파츠 PNG는 바뀌지 않으므로 수동 전파 7군데 중 4군데만 해당된다.

| 경로 | 내용 |
|---|---|
| `mascot/theme/` | `node mascot/theme-build.js` 산출물 복사 |
| `apps/user-web/creative/assets/` | 상태 SVG 미러 (현재 25개 → 27개) |
| `mascot/clawad-theme.zip` | 재패키징. 빠뜨리면 테마를 가져다 쓰는 사용자만 옛 아트를 받는다. |
| `clawad-overlay/apps/client-desktop/themes/clawad/` | 오버레이 번들 |

`mascot/theme-preview.html`은 `theme-build.js`가 같이 쓴다. 독립 실행형 SVG 4개와 `mascot/clawad-mascot.html`은 파츠 기반이라 무관하다.

## 검증

각도 누적은 순수 로직이라 `src/spin-meter.js`로 분리하고 `test/spin-meter.test.js`를 붙인다 (9개, 전부 통과).

- 1.5바퀴를 2초 안에 → 발동. 반대 방향도 발동
- 1.4바퀴 → 미발동
- 좌우 흔들기 → 미발동 (부호 상쇄)
- 2초를 넘겨 천천히 1.5바퀴 → 미발동 (창 밖 샘플 폐기)
- 중심에 너무 가까운 샘플 → 미발동
- 중간에 500ms 넘게 멈춤 → 누적 끊김
- 발동 직후 → 쿨다운 동안 미발동, 지나면 다시 발동
- `reset()`은 제스처만 버리고 쿨다운 유지, `clear()`는 쿨다운까지 제거

`theme-build.js` 끝의 자체 점검이 `states`가 가리키는 파일 존재를 확인한다. 오버레이의 `theme-schema`로 번들 테마를 검증하고, `THEME_SUPPORTS_DIZZY` 게이트를 그대로 재현해 `roam` 바인딩과 `dizzy` 상태가 실제로 켜지는지 본다. 실제 모션은 오버레이를 띄워 자유배회(idle 진입 후 8초)와 원 그리기를 눈으로 확인한다.

## 산출물

PR 한 쌍, 같은 브랜치명 `feat/claw-286-mascot-roam-dizzy`.

- **clawad** — `mascot/theme-build.js`, `mascot/theme/`, `apps/user-web/creative/assets/`, `mascot/clawad-theme.zip`, 이 스펙 문서
- **clawad-overlay** — `themes/clawad/` 번들, `src/spin-meter.js`, `src/tick.js`, `test/spin-meter.test.js`

## 검증 결과

| | tests | pass | fail |
|---|---|---|---|
| clawad | 688 | 688 | 0 (lint 통과) |
| clawad-overlay `origin/develop` | 5500 | 5460 | 21 |
| clawad-overlay 이 브랜치 | 5509 | 5469 | 21 |

오버레이의 실패 21개는 브랜치를 자르기 전부터 있던 것이다. 원본 `origin/develop`을 워크트리로 떠서 같은 스위트를 돌려 같은 수를 확인했다. 이 브랜치가 더한 것은 통과하는 테스트 9개뿐이다.

번들 테마를 오버레이의 실제 로더에 통과시켜 런타임 게이트도 확인했다: `validateTheme` 오류 0, `THEME_SUPPORTS_DIZZY = true`, `states.roam = ["clawad-roam.svg"]`, `roamFlipAssets = false`, 에셋 2개 존재.
