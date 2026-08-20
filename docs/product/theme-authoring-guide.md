# 클로애드 커스텀 테마 만들기

클로애드 오버레이(Claw-Ad) 데스크펫에 **자기가 만든 캐릭터**를 올리는 방법이다.
그림만 있으면 코딩 없이 폴더 하나로 끝난다. 기본 마스코트(애드워드)를 설치하는 방법은
[mascot-theme-guide.md](mascot-theme-guide.md)를 본다.

---

## 1. 테마는 폴더 하나다

```
my-theme/
├─ theme.json      ← 어떤 상황에 어떤 그림을 쓸지 적는 설정 파일
├─ assets/         ← 그림 파일 전부 (하위 폴더 없이 이 안에 평평하게)
│   ├─ idle.svg
│   ├─ thinking.svg
│   └─ working.svg
└─ sounds/         ← (선택) 소리 파일
```

앱은 아래 폴더를 스캔한다. 여기에 `my-theme/`를 통째로 넣으면 테마 목록에 나타난다.

| OS | 사용자 테마 폴더 |
|---|---|
| Windows | `%APPDATA%\Claw-Ad\themes\` |
| macOS | `~/Library/Application Support/Claw-Ad/themes/` |
| Linux | `~/.config/Claw-Ad/themes/` |

- **폴더 이름이 곧 테마 ID다.** 영문 소문자·숫자·하이픈을 권장한다.
- `clawd`·`calico`·`cloudling`·`template`은 예약 ID라 거부된다. `clawad`는 내장 테마가 우선이라 무시된다.

---

## 2. 5분 만에 도는 최소 테마

그림 3장과 아래 `theme.json` 하나면 동작한다. 그대로 복사해 쓰면 된다.

```json
{
  "schemaVersion": 1,
  "name": "My Theme",
  "author": "내 이름",
  "version": "1.0.0",
  "description": "한 줄 설명",
  "viewBox": { "x": 0, "y": 0, "width": 100, "height": 100 },
  "states": {
    "idle":         ["idle.svg"],
    "thinking":     ["thinking.svg"],
    "working":      ["working.svg"],
    "sleeping":     { "fallbackTo": "idle" },
    "error":        { "fallbackTo": "attention" },
    "attention":    { "fallbackTo": "idle" },
    "notification": { "fallbackTo": "idle" }
  },
  "sleepSequence": { "mode": "direct" },
  "hitBoxes": { "default": { "x": 20, "y": 20, "w": 60, "h": 60 } },
  "miniMode": { "supported": false }
}
```

1. `themes/my-theme/assets/`에 `idle`·`thinking`·`working` 그림 3장을 넣는다.
2. 위 JSON을 `themes/my-theme/theme.json`으로 저장한다.
3. 트레이 아이콘 → 설정 → **테마** 탭 → **"테마 새로고침"** → 목록에서 선택.

여기서부터는 필요한 상태를 하나씩 늘려 가면 된다.

---

## 3. theme.json 레퍼런스

### 필수

| 필드 | 설명 |
|---|---|
| `schemaVersion` | 항상 `1` |
| `name` | 테마 목록에 보이는 이름 |
| `version` | semver 문자열 (`"1.0.0"`) |
| `viewBox` | 그림의 논리 캔버스 `{x, y, width, height}`. **모든 그림이 같은 비율**이어야 한다 |
| `states.idle` / `states.thinking` / `states.working` | 실제 파일이 든 배열 |
| `states.sleeping` | 파일 배열 또는 `{ "fallbackTo": "..." }` |

### 자주 쓰는 선택 필드

| 필드 | 설명 |
|---|---|
| `hitBoxes.default` | 클릭·드래그가 먹는 영역 (viewBox 단위). 없으면 캐릭터를 못 잡는 느낌이 난다 |
| `hitBoxes.sleeping`, `sleepingHitboxFiles` | 누워 있을 때 납작해진 영역 |
| `layout` | 캐릭터의 실제 몸통 위치·바닥선. 여백이 큰 그림에서 화면 배치가 어긋날 때 잡는다 |
| `objectScale` | 화면에 그려지는 크기 미세 조정 |
| `workingTiers` | 동시 세션 수(1/2/3+)에 따라 다른 작업 그림 |
| `jugglingTiers` | 서브에이전트 수에 따른 그림 |
| `idleAnimations` | 가만히 있을 때 가끔 재생할 그림 + `duration`(ms) |
| `reactions` | `drag`·`clickLeft`·`clickRight`·`double` 반응 그림 |
| `timings` | 상태별 최소 표시 시간, 잠들기까지 시간 등 (ms) |
| `sounds` | `sounds/` 폴더의 소리 파일 매핑. `null`이면 그 소리를 끈다 |
| `customization.petTint` | `true`면 설정에서 내장 색 필터로 색을 바꿀 수 있다 (필터가 어울리는 아트일 때만) |

### 상태 목록

| 분류 | 상태 | 비고 |
|---|---|---|
| 필수 | `idle`, `thinking`, `working` | 실제 파일 필요 |
| 준필수 | `sleeping` | 파일 또는 `fallbackTo` |
| 선택 | `attention`, `notification`, `error`, `sweeping`, `carrying`, `roam` | `fallbackTo` 허용 상태 |
| 수면 전환 | `yawning`, `dozing`, `collapsing`, `waking` | `sleepSequence.mode: "full"`일 때만 필수 |
| 미니 모드 | `mini-idle`, `mini-enter`, `mini-enter-sleep`, `mini-crabwalk`, `mini-peek`, `mini-alert`, `mini-happy`, `mini-sleep` | `miniMode.supported: true`면 **8종 전부** 필수 |

- `fallbackTo`는 `error`/`attention`/`notification`/`sweeping`/`carrying`/`sleeping`/`roam`에만 쓸 수 있다.
  체인은 3홉 이내여야 하고, 순환하면 검증에서 막힌다.
- 목록에 없는 선택 상태를 빼면 그 상황에서 `idle`로 보인다 — 망가지지는 않는다.
- 처음 만들 땐 `sleepSequence.mode: "direct"`(바로 잠듦), `miniMode.supported: false`로 두는 편이 쉽다.

### 눈동자 커서 추적 (선택)

```json
"eyeTracking": {
  "enabled": true,
  "states": ["idle"],
  "eyeRatioX": 0.5, "eyeRatioY": 0.5,
  "maxOffset": 3, "bodyScale": 0.33,
  "ids": { "eyes": "eyes-js", "body": "body-js" }
}
```

- `states`에 적은 상태의 파일은 **반드시 `.svg`**여야 한다.
- 그 SVG 안에 눈 그룹 `id="eyes-js"`, 몸통 그룹 `id="body-js"`가 있어야 앱이 움직일 수 있다.

---

## 4. 그림 파일 규칙

| 항목 | 규칙 |
|---|---|
| 포맷 | SVG, GIF, APNG, PNG, WebP, JPG, JPEG |
| 위치 | 전부 `assets/` 바로 아래. `theme.json`에는 **파일명만** 적는다 (경로·하위 폴더 X) |
| 비율 | 모든 그림이 `viewBox`와 같은 비율 |
| 애니메이션 | GIF/APNG/WebP를 쓰거나, SVG 안에서 CSS `@keyframes`로 |

### SVG는 앱이 한 번 걸러낸다 (보안)

외부에서 들어온 테마의 SVG는 설치 시 아래를 **제거**한다. 미리 알고 만들지 않으면 "그림이 안 보인다"가 된다.

- `<script>`, `<foreignObject>`, `<iframe>`, `<object>`, `<embed>`, `<form>` 계열 태그
- `onclick` 같은 `on*` 이벤트 속성, `javascript:` 링크
- 외부 주소 참조 — `http(s):`, `data:`, `file:`, `ftp:`, `//`로 시작하는 것 전부
  → **base64로 그림을 SVG에 심으면 지워진다.** 래스터는 `assets/` 안의 `.png`/`.webp`를 상대경로로 참조한다.

---

## 5. 만들면서 고쳐 나가는 루프

zip을 다시 싸지 말고 폴더를 직접 편집하는 쪽이 빠르다.

1. `themes/my-theme/`의 그림·`theme.json`을 고친다
2. 설정 → 테마 → **"테마 새로고침"** (앱 재시작 불필요)
3. 화면 확인 → 1번으로

캐시는 파일의 수정 시각·크기로 자동 무효화되므로 손댈 필요 없다.
그래도 옛 화면이 남으면 `%APPDATA%\Claw-Ad\theme-cache\my-theme\`를 지우고 새로고침한다.

---

## 6. 남에게 나눠주기 (.zip)

폴더를 통째로 압축한다.

```bash
powershell -Command "Compress-Archive -Path my-theme -DestinationPath my-theme.zip -Force"
```

받는 쪽은 설정 → 테마 → **"클로애드 테마 패키지 가져오기 (.zip)"**.

| 규칙 | 값 |
|---|---|
| `theme.json` 위치 | zip 루트 또는 **최상위 폴더 하나** 안에 정확히 1개 |
| 테마 ID | 그 최상위 폴더 이름 (없으면 zip 파일명) |
| 용량 | zip 80MB / 개별 파일 40MB / 압축 해제 160MB / `theme.json` 512KB 이하 |
| 중복 | 같은 ID가 이미 있으면 `already exists`로 실패 → 기존 폴더를 지우고 다시 가져온다 |

가져오기는 검증을 통과해야 설치된다. 필수 상태가 빠졌거나 `assets/`에 파일이 없으면 그 자리에서 거절된다.

---

## 7. 배포 전 검증 (선택, 개발자용)

오버레이 저장소(`clawad-overlay`)를 받을 수 있다면 커맨드로 미리 점검할 수 있다.

```bash
node apps/client-desktop/scripts/validate-theme.js "%APPDATA%\Claw-Ad\themes\my-theme"
```

스키마·에셋 존재·`fallbackTo` 체인·viewBox·눈 추적 ID까지 한 번에 짚어준다.
빈 뼈대가 필요하면 `node apps/client-desktop/scripts/create-theme.js my-theme`로 `theme.json`을 만들 수 있다
(이 저장소는 아트워크를 반입하지 않으므로 그림은 직접 채워야 한다).

---

## 8. 잘 안 될 때

| 증상 | 원인·조치 |
|---|---|
| 테마 목록에 안 보임 | 경로가 `%APPDATA%\Claw-Ad\themes\`가 맞는지 확인 (`clawd-on-desk`는 옛 경로다). 그 다음 "테마 새로고침" |
| 가져오기 `already exists` | 같은 ID 폴더가 이미 있다. 지우고 다시 가져온다 |
| 가져오기 시 "missing asset file" | `theme.json`에 적은 파일명이 `assets/` 안에 없다. 대소문자까지 같아야 한다 |
| 그림이 빈칸으로 뜸 | SVG가 `data:`·외부 URL을 참조하고 있다. `assets/`의 png/webp 상대경로로 바꾼다 |
| 고쳤는데 그대로 | "테마 새로고침"을 안 했다. 그래도 그러면 `theme-cache/<테마id>` 삭제 |
| 캐릭터가 클릭이 안 됨 | `hitBoxes.default`가 없거나 캐릭터와 어긋났다 (viewBox 단위인지 확인) |
| 캐릭터가 화면에서 붕 떠 보임 | `layout.baselineY`·`objectScale`을 조정한다 |
| 눈이 안 움직임 | `eyeTracking.states`의 파일이 SVG인지, `#eyes-js`·`#body-js` 그룹이 있는지 확인 |

---

## 9. 참고

- 실제로 25종 상태를 다 채운 예시: 이 저장소의 [`mascot/theme/theme.json`](../../mascot/theme/theme.json)
- 전 상태를 한 페이지에서 보는 갤러리: `mascot/theme-preview.html`
- 기본 마스코트 설치·운영: [mascot-theme-guide.md](mascot-theme-guide.md)
