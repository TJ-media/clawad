# ClawAd 마스코트

`~/Downloads/exact_svg_parts_from_sheet`의 SVG 파츠(임베드 PNG)를 조합해 만든 애니메이션 마스코트.

- `clawad-mascot.html` — 자립형 결과물(파츠 base64 인라인). 브라우저에서 바로 열면 됨.
- `build.js` — 위치·애니메이션을 수정한 뒤 재생성하는 빌더. `parts/`의 PNG를 읽는다.
- `parts/` — 원본 SVG에서 추출한 파츠 PNG. `tail-side.png`는 `tail.png`를 반시계 90° 회전한 버전(몸통 왼쪽 배치용).

## 빌드

```bash
node build.js          # clawad-mascot.html + mascot-artifact.html 생성
node build.js --pose   # 리깅 검증용 강제 포즈(집게 열림·더듬이 스윙·시선 이동)
```

## 애니메이션 구성

| 동작 | 대상 | 방식 |
|---|---|---|
| 숨쉬기 | `#pet` | scale/translateY 3.4s, 발 라인 기준 |
| 시선 추적 | `#face`(눈+볼+입), `#tilt`(몸 기울임) | JS가 CSS 변수 `--lx`/`--ly`만 갱신(rAF+lerp) |
| 더듬이 살랑 | `.antenna-l/.antenna-r` | 밑동 피벗 ±6°, 주기 2.3s/2.7s로 어긋냄 |
| 집게 개폐 | `.claw-upper` | 관절(108px,285px) 피벗, steps(3)로 픽셀 감성 딸깍 |
| 팔 흔들기 | `.arm-big`, `.arm-left-w` | 어깨 피벗 저진폭 회전 |
| 눈 깜빡임 | `#blink` | scaleY 4.6s 주기(숨쉬기와 배수 회피) |

파츠 위치를 조정하려면 `build.js`의 CSS `left/top` 값을 수정하고 재빌드.

## clawd-on-desk 테마

- `theme/` — clawd-on-desk 테마 패키지 원본 (theme.json + 상태별 SVG 7종 + 파츠 PNG)
- `clawad-theme.zip` — 배포·공유용 패키지 (Clawd Settings → 테마 → "Clawd 테마 패키지 가져오기")
- `theme-build.js` — 테마 생성 빌더. `parts/` PNG를 읽어 `theme-out/clawad/`를 만들고 앱 스키마(theme-schema)로 자체 검증한다.

기본 상태: idle(눈동자 추적+숨쉬기+집게 딸깍) / thinking(픽셀 구름 말풍선+한쪽 눈썹 올림) / working(정면 키보드+발 4개 타건+키 눌림+10시10분 눈썹) /
attention(점프+반짝이+눈썹 들썩) / notification(픽셀 느낌표+눈썹 쫑긋) / error(흔들림+식은땀+걱정 눈썹) / sleeping(픽셀 Zzz+처진 눈썹).
눈·눈썹은 4조각(brow-l/brow-r/eye-l/eye-r)으로 분리 — 분리 스크립트는 `split-eyes.ps1`, blink는 눈만 감고 눈썹은 유지된다.
그림자는 고정 픽셀 바(전체 폭의 2/3, 몸 중심 정렬). 커서 추적 대상에서 제외(eyeTracking.ids에 shadow 없음).

v1.5 확장 (총 21개 SVG):
- **working 티어**: 동시 세션 1=typing / 2=juggling(모니터 2대 번갈아 보기, 코드 라인 타이핑) / 3+=building(크런치 모드: 모니터 2대+발 연타+커피).
  서브에이전트 티어: 1=juggling / 2+=conducting(우상향 지휘봉+8분·연속16분음표, 피벗은 팔-몸통 연결부).
- **미니 모드 8종**(supported: true): mini-idle / mini-enter(슬라이드 등장) / mini-enter-sleep / mini-crabwalk(게걸음) /
  mini-peek(왼쪽 가장자리에서 오른쪽 절반 빼꼼) / mini-alert / mini-happy / mini-sleep.
- **리액션**: drag(대롱대롱 매달림) / clickLeft(화들짝 점프+!) / double(픽셀 하트 2개, 흰 언더레이).

v1.6 확장 — 수면 시퀀스 full 모드(`sleepSequence.mode: "full"`, 총 25개 SVG):
idle → yawning(하품: 입 1.65배+눈 질끈+팔 올림, 3.6s) → dozing(꾸벅꾸벅: 앞으로 기울다 화들짝, 5.8s 루프)
→ collapsing(잠들기 전환, 1.6s 1회) → sleeping → waking(기지개 후 눈 뜨기, 2.6s 1회).
전환 상태(collapsing/waking)는 `both`로 1회 재생하며 끝 포즈가 다음 상태 시작 포즈와 이어진다.

`theme-preview.html` — 전체 상태를 한 페이지에서 확인하는 갤러리(theme-build.js가 함께 생성).

주의: 앱 새니타이저가 `data:` URI를 제거하므로 SVG는 반드시 assets/ 내 PNG를 상대경로로 참조해야 한다.
로컬 설치 경로: `%APPDATA%\clawd-on-desk\themes\clawad` (설정에서 "테마 새로고침" 후 선택).
