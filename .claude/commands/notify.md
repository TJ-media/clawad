Mattermost 웹훅으로 파이프라인 결과를 전송한다.

인자 형식: `/notify [success|failure] [ISSUE_KEY] [메시지]`

예시:
- `/notify success CLAW-4 https://github.com/TJ-media/clawad/pull/2`
- `/notify failure CLAW-4 빌드/테스트 3회 모두 실패. 오류: Cannot find module...`

---

## 웹훅 URL 확인

`.env.local` 파일에서 `MATTERMOST_WEBHOOK_URL` 값을 읽는다.

```bash
WEBHOOK_URL=$(grep MATTERMOST_WEBHOOK_URL .env.local | cut -d '=' -f2-)
```

값이 비어있으면 아래 메시지를 출력하고 **웹훅 전송만 건너뛴다** (Jira 상태 전환은 계속 진행).
```
Mattermost 웹훅 URL이 설정되지 않았습니다.
.env.local 에 MATTERMOST_WEBHOOK_URL=https://... 를 추가하세요.
```

---

## Jira 이슈 제목 조회

Atlassian MCP로 이슈 제목을 가져온다.

- cloudId: `d4081ac1-010a-45f5-8241-d9d67209e21b`
- issueIdOrKey: `ISSUE_KEY`

응답의 `fields.summary` 값을 ISSUE_TITLE 변수에 저장한다.
조회 실패 시 ISSUE_TITLE = `ISSUE_KEY` (이슈 키로 대체)

---

## 메시지 구성

인자에서 파싱:
- TYPE = 첫 번째 인자 (success 또는 failure)
- ISSUE_KEY = 두 번째 인자
- PAYLOAD = 나머지 인자 전체 (PR URL 또는 실패 이유)

### 성공 메시지 (TYPE = success)

```
✅ *[ISSUE_KEY] 개발 완료*

> 이슈: ISSUE_TITLE
> Jira: https://whatsuphouse.atlassian.net/browse/ISSUE_KEY
> PR: PAYLOAD

자동 개발 파이프라인이 정상적으로 완료됐습니다.
```

### 실패 메시지 (TYPE = failure)

```
❌ *[ISSUE_KEY] 파이프라인 실패*

> 이슈: ISSUE_TITLE
> Jira: https://whatsuphouse.atlassian.net/browse/ISSUE_KEY
> 실패 이유: PAYLOAD

수동 확인이 필요합니다.
```

---

## 웹훅 전송

JSON 이스케이프는 `node`로 처리한다 (jq/python 의존 금지).

```bash
MESSAGE="{위에서 구성한 메시지}"

BODY=$(node -e 'console.log(JSON.stringify({ text: process.argv[1] }))' "$MESSAGE")

curl -s -o /dev/null -w "%{http_code}" \
  -X POST \
  -H 'Content-Type: application/json' \
  -d "$BODY" \
  "$WEBHOOK_URL"
```

응답 코드가 200이면 "✅ Mattermost 알림 전송 완료"를 출력한다.
응답 코드가 200이 아니면 "❌ Mattermost 전송 실패 (HTTP {코드})"를 출력한다.

---

## Jira 상태 전환 (성공 시에만)

TYPE = success 인 경우에만 실행한다.

Atlassian MCP로 이슈를 "완료"로 전환한다. transition ID를 하드코딩하지 말고 `getTransitionsForJiraIssue`로 조회해 이름이 "완료"인 전환을 사용한다.

성공 시 "✅ Jira 이슈 ISSUE_KEY → 완료 전환 완료"를 출력한다.
실패 시 "⚠️ Jira 상태 전환 실패 (수동으로 변경 필요)"를 출력한다.
