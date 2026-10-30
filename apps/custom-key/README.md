# example-custom-key

사용처 scramble 키로 `@cp949/projectfile`을 쓰는 예제다. 파일 하나가 장면 하나다.

- 인코딩은 `scrambleKey`에 키 하나를 준다.
- 디코딩은 `scrambleKeys`에 풀 수 있는 키 목록을 준다.
- 키는 실행할 때마다 `crypto.getRandomValues`로 새로 만든다. 실제 사용처는 키를 한 번 만들어 보관한다.

## 실행

저장소 루트에서 라이브러리를 먼저 빌드한다. 예제는 빌드한 `dist`를 쓴다.

```sh
pnpm install
pnpm build
cd apps/custom-key
node src/01-encode-decode.ts
node src/02-key-mismatch.ts
node src/03-key-rotation.ts
```

## 예제

| 파일                      | 보이는 것                                                          |
| ------------------------- | ------------------------------------------------------------------ |
| `src/01-encode-decode.ts` | 사용처 키로 인코딩하고 같은 키로 디코딩한다.                       |
| `src/02-key-mismatch.ts`  | 키 목록에 만든 키가 없으면 `scramble-key-mismatch`로 실패한다.     |
| `src/03-key-rotation.ts`  | 키 목록에 새 키와 옛 키를 함께 두어 두 키로 만든 파일을 모두 연다. |

`01-encode-decode.ts` 출력:

```text
인코딩 결과: 470바이트
text  project.json: {"title":"hello"}
```

`02-key-mismatch.ts` 출력. 기본 키도 목록에 없으면 같은 이유로 실패한다:

```text
다른 키: scramble-key-mismatch
기본 키: scramble-key-mismatch
```

`03-key-rotation.ts` 출력:

```text
옛 키 파일: {"made":"old"}
새 키 파일: {"made":"new"}
```

키 규칙은 `packages/projectfile/README.md`의 "scramble 키"에 있다.
