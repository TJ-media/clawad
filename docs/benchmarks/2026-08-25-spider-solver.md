# 스파이더 솔버 예비 측정 — 검증 풀 생성 차단

이 문서는 완료된 100딜 벤치마크가 아니라, 풀 생성 가능성을 확인하기 위한 **예비 측정**이다. 평균 해답 발견 시간이나 평균 가능·불가능 판정 시간은 아직 산출할 수 없다. 아래 제한 시간에 도달한 결과는 모두 `timeout`(미판정)이며 불가능 판정이 아니다.

## 환경

- CPU: Intel(R) Core(TM) Ultra 9 185H
- Node.js: v24.18.0
- OS/아키텍처: Windows (`win32`), x64
- 측정: 2026-08-25, 재개 진단 2026-08-26 (KST)
- 솔버 기준 커밋: `d43aed2` (재고 레인 대칭 건전성 수정 포함)
- 검색은 한 번에 한 건씩 실행했다.

## 2초 제한 예비 표본

각 난이도에서 시드 1–5를 `solveSpiderSeed(difficulty, seed, { timeoutMs: 2000, maxNodes: Number.MAX_SAFE_INTEGER })`로 실행했다.

| 무늬 수 | 표본 | solved | exhausted | timeout | 총 wall time | 방문 노드 범위 |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 5 | 0 | 0 | 5 | 9,999.9ms | 2,795–3,051 |
| 2 | 5 | 0 | 0 | 5 | 10,002.2ms | 2,722–3,511 |
| 4 | 5 | 0 | 0 | 5 | 9,999.8ms | 2,349–3,658 |

## 30초 제한 예비 표본

각 난이도의 시드 1을 아래 명령 형태로 실행했다.

```js
const { performance } = require('node:perf_hooks');
const { solveSpiderSeed } = require('./apps/user-web/spider-solver.js');
for (const difficulty of [1, 2, 4]) {
  const started = performance.now();
  const result = solveSpiderSeed(difficulty, 1, {
    timeoutMs: 30000,
    maxNodes: Number.MAX_SAFE_INTEGER,
  });
  console.log({ difficulty, wallMs: performance.now() - started, ...result });
}
```

| 무늬 수 | 시드 | 결과 | solver elapsed | wall time | 방문 노드 | 해답 길이 |
|---:|---:|---|---:|---:|---:|---:|
| 1 | 1 | timeout | 30,000ms | 30,001.4ms | 42,645 | 0 |
| 2 | 1 | timeout | 30,000ms | 30,001.2ms | 41,416 | 0 |
| 4 | 1 | timeout | 30,000ms | 30,000.0ms | 39,638 | 0 |

전체 예비 표본은 solved 0/18, exhausted 0/18, timeout 18/18이다. 해답이 반환되지 않았으므로 성공 해답 재생 표본도 0건이다. 이를 재생 검증 성공률이나 실제 승리 가능 비율로 해석하면 안 된다.

## 재개 후 읽기 전용 진단

2026-08-26에 저장소 파일을 변경하지 않고 메모리에 로드한 솔버의 시작 깊이만 512로 바꿔 각 난이도 시드 1을 5초 동안 실행했다. 결과는 모두 timeout이었다(1무늬 5,025ms/495노드, 2무늬 5,002ms/1,968노드, 4무늬 5,000ms/4,893노드). 시작 깊이만 높이는 단순 변경으로는 병목이 해소되지 않았다. 이 실험 코드는 제품에 반영하지 않았다.

## 현재 결론과 미완료 항목

- 1초 내 판정 조건을 충족한다는 근거가 없다. 현재 솔버로 실시간 검증 경로를 활성화하지 않는다.
- 난이도별 256개 재생 검증 딜 풀은 생성되지 않았다. timeout을 solved로 바꾸거나 풀 크기를 낮추지 않았다.
- 워밍업 10개 + 난이도별 100개 표본, median/p95/max 정식 집계와 검증 풀 생성기는 미완료다.
- `spider-deal-provider.js`는 구현·테스트됐지만 실제 게임 UI에 연결하지 않았다. 기존 게임을 검증된 딜이라고 표시하지 않는다.
- 다음 결정은 해답 탐색 전략을 개선해 다시 측정할지, 해답 경로를 함께 구성하는 별도 딜 생성 방식을 승인받을지다. 어느 경우에도 실제 규칙 엔진의 승리 재생 검증은 유지해야 한다.
