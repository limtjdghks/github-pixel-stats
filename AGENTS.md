# 에이전트 작업 규칙

## 브랜치 생성 규칙

GitHub Issue 작업을 시작할 때 다음 형식으로 브랜치를 생성합니다.

`<tag>/<issue-number>-<work-name>`

예시:

- `feat/3-runtime-username`
- `fix/12-invalid-query-fallback`
- `test/2-api-fixtures`
- `chore/6-vercel-deployment`

다음 규칙을 따릅니다.

- Issue 제목 앞의 `[tag]`를 브랜치의 첫 경로로 사용합니다.
- Issue 번호에는 `#`을 포함하지 않습니다.
- 작업명은 내용을 식별할 수 있는 영문 소문자 kebab-case로 작성합니다.
- `[epic]` Issue에서는 직접 작업 브랜치를 생성하지 않습니다.
- 별도 요청이 없다면 `codex/` 등의 추가 접두사를 붙이지 않습니다.
- 브랜치를 생성하기 전에 대상 Issue 번호와 제목을 확인합니다.
