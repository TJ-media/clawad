'use strict';

/**
 * 배포가 남긴 옛 release 이미지를 고른다 (CLAW-254).
 *
 * 배포마다 api·user-web 이미지가 로컬 tag와 레지스트리 tag 두 벌로 쌓여 디스크가 단조 증가한다.
 * 2026-08-20 실측으로 이미지 195개 18.12GB, 루트 파일시스템 88%까지 찼다.
 *
 * `docker image prune -a`를 조건 없이 걸 수 없다. rollback 대상 이미지는 **실행 중 컨테이너가 없어서**
 * 그대로 지워지는데, production-release.js가 배포 전 `inspectReleaseImages(rollbackSha)`로 그 이미지를
 * 요구한다 — 지우면 다음 배포가 거부되고 자동 rollback 경로도 함께 죽는다.
 */
const RELEASE_IMAGE = /^(?:[^\s/]+\/)*clawad-[a-z][a-z-]*:([0-9a-f]{40})$/;

function releaseShaOf(ref) {
  const match = RELEASE_IMAGE.exec(String(ref).trim());
  return match ? match[1] : null;
}

function staleImageRefs(refs, keepShas) {
  const keep = new Set([...keepShas].filter(Boolean));
  const stale = [];
  for (const ref of refs) {
    const trimmed = String(ref).trim();
    const sha = releaseShaOf(trimmed);
    // clawad release 이미지가 아니면 손대지 않는다. postgres·redis·grafana 같은 서드파티 이미지와
    // dangling(<none>)은 여기서 걸러지고, dangling은 docker image prune -f가 따로 정리한다.
    if (!sha || keep.has(sha)) continue;
    stale.push(trimmed);
  }
  return stale;
}

module.exports = { staleImageRefs, releaseShaOf };
