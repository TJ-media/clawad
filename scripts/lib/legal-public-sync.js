'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * 법무 공개본을 user-web이 마운트하는 호스트 디렉터리에 동기화한다 (CLAW-225).
 *
 * 공개본은 git 체크아웃이 아니라 `LEGAL_PUBLIC_DIR`(바인드 마운트, compose.yml의 `:/srv/legal:ro`)에서
 * 서빙된다. 배포가 이 디렉터리를 건드리지 않으면 약관·처리방침 개정이 코드로만 나가고 사용자가 보는
 * 공개본은 옛 버전에 머문다 — **배포는 성공으로 끝나므로 아무도 눈치채지 못한다.** 실제로 2026-08-18
 * 푸터 링크 변경(CLAW-224)과 2026-08-20 광고주 안내(CLAW-250)가 손으로 배치하기 전까지 반영되지 않았다.
 */
const PUBLISHED_EXTENSIONS = new Set(['.html', '.css']);

function syncLegalPublic(sourceDir, targetDir) {
  if (!targetDir) {
    throw new Error('운영 .env에 LEGAL_PUBLIC_DIR이 없습니다. 법무 공개본을 배치할 경로를 지정하세요.');
  }
  const names = fs
    .readdirSync(sourceDir)
    .filter((name) => PUBLISHED_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .sort();
  // 검토 노트(README.md)는 공개본이 아니다. 반대로 한 건도 못 찾았다면 경로가 틀렸다는 뜻이므로
  // 빈 디렉터리를 마운트에 그대로 반영하지 않고 세운다.
  if (names.length === 0) throw new Error(`법무 공개본을 찾지 못했습니다: ${sourceDir}`);

  fs.mkdirSync(targetDir, { recursive: true });
  for (const name of names) {
    const target = path.join(targetDir, name);
    fs.copyFileSync(path.join(sourceDir, name), target);
    // 마운트는 ro라 컨테이너가 권한을 고칠 수 없다. 0644가 아니면 user-web이 공개본을 읽지 못한다.
    try {
      fs.chmodSync(target, 0o644);
    } catch (error) {
      if (process.platform !== 'win32') throw error;
    }
  }
  // 대상에만 있는 파일은 지우지 않는다. 각 개정 안내가 직전 버전을 링크하므로 구버전을 지우면
  // 라이브 문서의 링크가 404가 된다 (docs/legal/public/README.md).
  return names;
}

module.exports = { syncLegalPublic };
