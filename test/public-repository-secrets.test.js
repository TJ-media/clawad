'use strict';

// 저장소가 공개되어 있으므로 운영 인프라 식별자가 커밋되면 안 된다 (CLAW-78, CLAW-80).
// 자격증명은 아니지만 공격 표면을 넓히므로 접속 절차·식별자는 내부 문서로만 관리한다.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'data', 'dist', '.terraform', 'backups']);
const TEXT_EXTENSIONS = new Set([
  '.md', '.js', '.mjs', '.cjs', '.ts', '.json', '.yml', '.yaml',
  '.tf', '.hcl', '.sh', '.html', '.css', '.example', '.txt', '.toml',
]);
// 확장자가 없는 설정 파일도 계정 ID·레지스트리 URI가 들어가기 쉬운 자리다.
const TEXT_FILENAMES = new Set(['Dockerfile', 'Caddyfile', 'Makefile']);

const FORBIDDEN = [
  // EC2 인스턴스 ID 등 리소스 식별자. terraform의 ${aws_instance.api.id} 같은 참조는 값이 아니라 통과한다.
  { pattern: /\bi-[0-9a-f]{8,17}\b/, label: 'EC2 인스턴스 ID' },
  // ARN에 박힌 AWS 계정 번호.
  { pattern: /arn:aws[a-z-]*:[^\s:]*:[^\s:]*:\d{12}:/, label: 'AWS 계정 ID가 포함된 ARN' },
  // 계정 번호를 접미사로 쓰는 운영 버킷 이름.
  { pattern: /clawad-[a-z0-9-]*-\d{12}\b/, label: 'AWS 계정 ID가 포함된 버킷 이름' },
  // 컨테이너 레지스트리 URI와 환경변수에 박힌 계정 번호.
  { pattern: /\d{12}\.dkr\.ecr\./, label: 'AWS 계정 ID가 포함된 ECR URI' },
  { pattern: /account[_-]?id\D{0,4}\d{12}\b/i, label: 'AWS 계정 ID' },
];

function walk(dir) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (TEXT_EXTENSIONS.has(path.extname(entry.name)) || TEXT_FILENAMES.has(entry.name)) out.push(full);
  }
  return out;
}

test('공개 저장소에 운영 인프라 식별자를 커밋하지 않는다', () => {
  const findings = [];
  for (const file of walk(ROOT)) {
    const relative = path.relative(ROOT, file);
    if (relative === path.join('test', 'public-repository-secrets.test.js')) continue;
    let content;
    try { content = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); } catch { continue; }
    content.split(/\r?\n/).forEach((line, index) => {
      for (const { pattern, label } of FORBIDDEN) {
        if (pattern.test(line)) findings.push(`${relative}:${index + 1} — ${label}`);
      }
    });
  }
  assert.deepStrictEqual(findings, [], `공개 저장소에 두면 안 되는 값이 있습니다:\n${findings.join('\n')}`);
});

test('법률 공개본 배치 문서는 운영 접속 절차를 담지 않는다', () => {
  const guide = fs.readFileSync(path.join(ROOT, 'docs', 'legal', 'public', 'README.md'), 'utf8').replace(/^\uFEFF/, '');
  assert.doesNotMatch(guide, /ssm start-session/, '운영 서버 접속 명령은 내부 문서에서만 관리한다.');
  assert.match(guide, /CLAW-60/, '접속 절차의 위치를 안내해야 한다.');
});
