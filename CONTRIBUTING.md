# 기여 안내

`@cp949/projectfile` 저장소에 변경을 보내는 방법이다. 라이선스는 MIT다([LICENSE](LICENSE)).

## 시작

Node와 pnpm 버전은 `packages/projectfile/package.json`의 `engines`와 루트 `package.json`의 `packageManager`를 따른다.

```sh
pnpm install
pnpm verify
```

`verify`의 구성과 각 명령의 전제 조건(`build`, 네트워크, Chromium)은 [README.md](README.md)의 "명령"에 있다.

`verify`에 들어가지 않는 검사는 CI가 pull request마다 실행한다.

- `pnpm --filter @cp949/projectfile test:browser`
- `pnpm check:consume`
- `pnpm check:package`

`exports`, `files`, 타입 선언을 바꾸면 보내기 전에 `check:consume`과 `check:package`를 로컬에서 돌린다.

## 변경 종류별 같이 고칠 곳

| 변경                                   | 같이 고칠 곳                                                   |
| -------------------------------------- | -------------------------------------------------------------- |
| 포맷 바이트 배치, 검사 순서, 한도 규칙 | [docs/format.md](docs/format.md)와 `test-vectors/`             |
| 공개 API나 동작                        | `packages/projectfile/README.md`와 변경 기록(아래 "변경 기록") |
| 소스의 구조적 설계 결정                | [docs/design/](docs/design/)                                   |
| 되돌리기 비싼 방향 결정                | [docs/adr/](docs/adr/)                                         |

- `test-vectors/`는 `pnpm vectors:generate`로 다시 만든다.
- 버그 수정은 실패하는 회귀 테스트를 먼저 확인한 뒤 고친다. 테스트 기준은 [docs/agents/testing.md](docs/agents/testing.md)를 따른다.
- 문서와 주석은 [docs/agents/writing-styles.md](docs/agents/writing-styles.md)를 따른다. 한국어로 쓰고, 볼드와 버전 번호를 쓰지 않는다.

## 변경 기록

공개 API나 동작을 바꾸면 변경 기록을 남긴다. 방법과 종류(`patch`, `minor`, `major`)는 [docs/release.md](docs/release.md)의 "changeset"을 따른다.

## 커밋 메시지

형식은 `type: 요약` 또는 `type(scope): 요약`이다. 요약은 한글로 쓴다.

- `feat`: 새 기능
- `fix`: 버그 수정
- `refactor`: 리팩터링
- `perf`: 성능 개선
- `style`: 코드 스타일 수정
- `docs`: 문서 변경
- `test`: 테스트 변경
- `build`: 빌드와 의존성 변경
- `ci`: CI 설정 변경
- `chore`: 그 밖의 변경

## pull request

- 기준 브랜치는 `dev`다.
- 보내기 전에 `pnpm verify`를 실행한다.

## 이슈

버그 신고와 기능 요청은 GitHub Issues에 올린다.

## 취약점 신고

취약점은 공개 이슈로 올리지 않는다. [SECURITY.md](SECURITY.md)의 신고 방법을 따른다.
