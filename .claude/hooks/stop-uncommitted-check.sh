#!/bin/bash
# Stop: 응답 완료 후 uncommitted 변경 파일 경고
# git 레포 밖에서 실행되면 조용히 종료한다

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

UNCOMMITTED=$(git status --porcelain 2>/dev/null | grep -v "^??" | wc -l | tr -d ' ')

if [ "$UNCOMMITTED" -gt "0" ]; then
  echo ""
  echo "⚠️  커밋되지 않은 변경 파일 ${UNCOMMITTED}개:"
  git status --short 2>/dev/null | grep -v "^??"
fi

exit 0
