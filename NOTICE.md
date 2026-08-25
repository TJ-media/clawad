# 제3자 고지 (Third-Party Notices)

클로애드(clawad)에 포함된 제3자 저작물과 그 라이선스를 밝힌다.

---

## English pattern playing cards deck

`apps/user-web/icons/english-pattern-playing-cards.svg`는 영미식(English pattern) 52장
카드 원본이고, `english-pattern-playing-cards@2x.png`는 클래식 카드놀이 화면용으로
래스터 변환한 2배 해상도 카드 시트다.

- 작품: [English pattern playing cards deck.svg](https://commons.wikimedia.org/wiki/File:English_pattern_playing_cards_deck.svg)
- 저작자: Dmitry Fomin
- 출처: 저작자 본인의 작업(2017)
- 라이선스: [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/)

저작권자가 CC0를 적용해 저작권 및 저작인접권을 법이 허용하는 범위에서 포기했으므로,
상업적 사용을 포함해 복제·수정·배포할 수 있다. 클로애드는 원본 SVG와 화면용 PNG를
함께 포함하며, 게임에서는 PNG의 각 카드 영역만 잘라 표시한다.

---

## SpaceCadetPinball

`apps/user-web/games.js`의 3D 핀볼(우주 비행 훈련) 규칙 — 점수표, 임무 열일곱 가지의
진행 조건, 계급 승급 규칙, 보너스·잭팟·배수 계산, 화면 원근 투영 행렬 — 은 아래 프로젝트의
`control.cpp`·`TPinballTable.cpp`·`proj.cpp`를 읽고 자바스크립트로 옮긴 것이다.
게임 안내 문구의 한국어 표기도 같은 프로젝트의 `translations.cpp`에 실린 공식 한국어
로캘 문자열을 따랐다.

- 프로젝트: [k4zmu2a/SpaceCadetPinball](https://github.com/k4zmu2a/SpaceCadetPinball)
- 라이선스: MIT
- 저작권: (c) 2020-2021 Andrey Muzychenko

```
MIT License

Copyright (c) 2020-2021 Andrey Muzychenko

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 가져오지 않은 것 [CRITICAL]

위 MIT 허가는 **그 저장소의 소스 코드**에만 미친다. 원작 게임 *3D Pinball for
Windows — Space Cadet* / *Full Tilt! Pinball*의 **자산**(`PINBALL.DAT`의 비트맵·
Z맵, 소리 파일, 음악, 판 배치 좌표)은 Maxis·Cinematronics·Microsoft의 저작물이며
그 저장소에도 들어 있지 않다. 실행하려면 사용자가 원본 게임 파일을 따로 구해야 한다.

클로애드는 그 자산을 **하나도 쓰지 않는다.**

- 판·범퍼·표적·플리퍼·계급 원판 그림은 전부 `apps/user-web/games.js` 안의 좌표
  데이터로 캔버스에 직접 그린다. 비트맵을 가져오거나 추출하지 않았다.
- 소리·음악은 넣지 않았다.
- 요소의 배치 좌표는 원본 데이터 파일이 아니라 공개된 화면과 구성도를 보고 같은 구역·
  같은 개수로 다시 세운 값이다.

가져온 것은 **규칙과 숫자**(점수·횟수·순서)와 소스에 주석으로 적혀 있던 **투영 행렬**,
그리고 공개 로캘의 **한국어 문구**뿐이며, 이는 모두 MIT 코드에서 나온 것이다.

원작 이름 *3D Pinball*·*Space Cadet*은 각 권리자의 상표다. 클로애드는 권리자와
아무런 제휴 관계가 없다.
