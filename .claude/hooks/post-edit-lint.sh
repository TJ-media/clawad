#!/bin/bash
# PostToolUse: Edit/Write 후 .js 파일에 node --check 구문 검사 자동 실행
# JSON 파싱은 node로 처리한다 (python3는 Windows Git Bash에 없을 수 있음)

INPUT=$(cat)
FILE=$(echo "$INPUT" | node -e "
let d = '';
process.stdin.on('data', c => d += c);
process.stdin.on('end', () => {
  try { console.log(JSON.parse(d).tool_input?.file_path || ''); }
  catch { console.log(''); }
});
" 2>/dev/null)

if [[ "$FILE" =~ \.(js|mjs|cjs)$ ]] && [ -f "$FILE" ]; then
  if ! node --check "$FILE" 2>&1; then
    echo "⚠️ 구문 오류: $FILE"
  fi
fi

exit 0
