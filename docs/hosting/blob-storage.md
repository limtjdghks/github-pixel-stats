# HOST-06 Blob 저장·발행 계약

수집 상태는 private store에, 검증된 SVG만 public store에 저장합니다. 두 store의 접근 방식은 생성 후 바꿀 수 없다고 가정하며, 같은 store를 함께 쓰지 않습니다.

## 구성 요소

| 파일 | 책임 |
| --- | --- |
| `src/storage/object-store.ts` | 저장소 공통 계약과 pathname 형식 검사 |
| `src/storage/pathnames.ts` | 사용자·release 버전·마스코트별 pathname SSOT |
| `src/storage/manifest.ts` | manifest 구조, 검증, 다음 manifest·퇴역 release 계산, 보존 대상 계산 |
| `src/storage/private-repository.ts` | manifest 조건부 교체, release state 저장, 발행된 state 조회 |
| `src/storage/checkpoint-object-store.ts` | HOST-03 checkpoint 계약의 ETag 기반 구현 |
| `src/storage/admissions.ts` | 등록 기록 형식·검증과 조건부 갱신 |
| `src/storage/publish.ts` | 렌더링·검증부터 manifest 교체까지의 발행 흐름 |
| `src/storage/cleanup.ts` | manifest가 참조하지 않는 객체 정리 |
| `src/storage/filesystem-store.ts` | CLI·로컬 검증용 adapter |
| `src/storage/vercel-blob-store.ts` | `@vercel/blob` adapter |

## Pathname

| store | pathname | 변경 방식 |
| --- | --- | --- |
| private | `admissions.json` | ETag 조건부 교체([`abuse-defense.md`](./abuse-defense.md)) |
| private | `checkpoints/{user}.json` | ETag 조건부 교체 |
| private | `manifests/{user}.json` | ETag 조건부 교체 |
| private | `releases/{user}/{version}/snapshot.json`, `state.json` | 내용 주소, 불변 |
| private | `usage/{YYYY-MM-DD}.json` | ETag 조건부 교체, 90일 보존([`operations.md`](./operations.md)) |
| public | `cards/{user}/{version}/languages.svg`, `stats-{mascot}.svg` | 내용 주소, 불변 |

`{user}`는 검증한 GitHub 사용자명의 소문자입니다. `{version}`은 `YYYYMMDD-HHMMSS-{hash16}` 형식이며 snapshot 생성 시각과 snapshot·state·렌더링된 카드 내용 hash로 만듭니다. 같은 수집 결과와 같은 renderer는 같은 버전이 되므로 재시도한 발행은 같은 pathname에 같은 내용을 씁니다. renderer가 바뀌면 버전도 바뀌어 이미 cache된 카드 pathname을 덮지 않습니다. 이때 같은 snapshot의 재발행은 생성 시각이 같아 `stale`이 되므로 새 renderer 결과는 다음 수집부터 반영됩니다.

## 발행 순서

1. 등록된 모든 마스코트의 stats 카드와 languages 카드를 렌더링하고 `validateGeneratedOutput()`으로 검증합니다. 검증에 실패하면 아무것도 저장하지 않습니다. 이어서 manifest를 읽어 같은 버전이 이미 현재 버전이면 `unchanged`, 같거나 더 새로운 snapshot이 발행되어 있으면 `stale`로 쓰기 없이 끝냅니다.
2. private store에 release의 snapshot과 state를 저장합니다.
3. public store에 카드를 저장합니다.
4. 1단계에서 읽은 manifest의 ETag로 조건부 교체합니다. 조건부 쓰기가 충돌하면 manifest를 다시 읽어 `unchanged`·`stale`을 다시 판정하고, 최대 3회 시도한 뒤 `conflict`를 반환합니다.
5. 새 manifest 발행 뒤 manifest가 참조하지 않는 객체를 삭제합니다. 정리 실패는 발행 결과에 기록하고 발행 자체는 성공으로 처리합니다.

## 보존과 정리

- manifest는 current, previous와 함께 `retired` 목록을 가집니다. 새 발행 때 기존 previous는 그 시각(`retiredAt`)에 퇴역 목록으로 옮겨지고, 퇴역 후 1시간(`RELEASE_GRACE_MS`)이 지난 항목은 다음 발행에서 목록에서 빠집니다.
- 유예는 업로드 시각이 아니라 참조가 끊긴 시각부터 계산합니다. 오래전에 올라간 release도 previous에서 밀려난 직후에는 지워지지 않으므로, 버전 경로를 cache한 클라이언트가 유예 시간 동안 같은 카드를 받을 수 있습니다.
- 정리는 current, previous, retired가 참조하지 않는 객체만 삭제합니다. 한 번도 참조되지 않은 객체는 아직 manifest에 반영되지 않은 다른 발행의 것일 수 있으므로 업로드 후 1시간이 지나야 삭제합니다.
- 목록 조회 뒤 삭제 직전에 저장된 최신 manifest를 다시 읽어 그 참조도 보존합니다. 최신 manifest 확인과 삭제 사이의 짧은 경합은 남아 있습니다.

4단계 이전에 실패하면 manifest는 바뀌지 않으므로 마지막 성공 카드가 그대로 제공됩니다. 남은 고아 객체는 다음 성공 발행의 정리 단계에서 삭제됩니다.

## 인증과 설정

- Vercel adapter는 모든 요청에 `@vercel/oidc`에서 얻은 OIDC token과 store ID를 명시합니다. token이 없으면 요청 전에 실패하며, 환경 변수의 `BLOB_READ_WRITE_TOKEN`으로 넘어가지 않습니다.
- `BLOB_PRIVATE_STORE_ID`와 `BLOB_PUBLIC_STORE_ID`는 함께 설정해야 하며 같은 값을 허용하지 않습니다.
- manifest와 checkpoint 조회는 `useCache: false`로 origin을 읽습니다. SDK는 이 옵션을 private store에만 적용하므로 public store(카드) 읽기는 항상 Blob CDN을 거칩니다. 카드 pathname은 내용 주소라 cache 사본도 같은 내용입니다.
- checkpoint lease guard는 ETag를 문자열로 비교하지 않고 lease 소유권만 확인합니다. Blob은 `get()` 응답 헤더와 `put()` 응답에서 ETag를 따로 받으므로 revision 일치는 조건부 쓰기에 맡깁니다.
- Blob은 약 1KB 이상 객체를 압축해 내려주며 `get()` ETag를 weak(`W/"…"`)로 바꿉니다. weak 값으로는 `ifMatch`가 항상 실패하므로 adapter가 읽을 때 `W/`를 떼어 strong ETag로 돌려줍니다. 안의 값은 `put()`·`head()`의 ETag와 같고, 그 값으로 교체가 됨을 실제 store에서 확인했습니다(2026-10-24 staging). 이 처리가 없으면 커진 checkpoint·manifest·`admissions.json`의 조건부 갱신이 매번 충돌로 끝나 수집을 이어 갈 수 없습니다.
- 같은 store 금지 검사는 SDK와 같이 `store_` 접두사를 제거한 뒤 비교합니다.
- 조건부 쓰기가 실패하면 객체를 다시 읽어 판정합니다. 방금 쓴 내용과 같으면 성공, 다른 내용이면 충돌, 객체가 없으면 원래 오류입니다. SDK가 기존 객체 생성 충돌을 별도 오류로 구분하지 않고, 응답이 유실된 PUT을 자동 재시도하면 실제로 반영된 쓰기도 충돌 오류로 끝나기 때문입니다.
- SDK는 네트워크 오류를 `VERCEL_BLOB_RETRIES`(기본 10회) 만큼 지수 backoff로 재시도합니다. 이 값은 프로세스 전역 환경 변수이므로 코드에서 바꾸지 않습니다. Function `maxDuration` 안에 재시도가 끝나도록 배포 환경에서 작은 값을 설정합니다. staging은 `3`입니다. backoff는 1·2·4…초에 1~2배 무작위가 곱해지므로 3회면 대기 합계가 7~14초로 카드 Function(30초) 안에 들어갑니다. 기본 10회는 최악 대기가 Function 제한을 크게 넘습니다. 호출자가 넘긴 abort signal은 read·write 요청에 전달됩니다.

## 마스코트 registry 변경

manifest를 읽을 때 registry에 없는 마스코트 ID는 오류 대신 목록에서 제외합니다. 제외된 variant 카드는 참조에서 빠지므로 정리 단계에서 삭제됩니다.

## 범위 밖

실제 Blob store 생성·프로젝트 연결은 이 문서의 범위가 아닙니다. 수집 결과를 발행하는 bootstrap과 Cron은 [`refresh.md`](./refresh.md)에 정리합니다. 발행된 카드를 읽는 route는 [`card-route.md`](./card-route.md)에 정리합니다. filesystem adapter의 조건부 쓰기는 한 프로세스 안에서만 직렬화합니다.
