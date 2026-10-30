# example-basic

기본 scramble 키(`DEFAULT_SCRAMBLE_KEY`)로 `@cp949/projectfile`을 쓰는 예제다. 파일 하나가 장면 하나다.

## 실행

저장소 루트에서 라이브러리를 먼저 빌드한다. 예제는 빌드한 `dist`를 쓴다.

```sh
pnpm install
pnpm build
cd apps/basic
node src/01-encode-decode.ts
node src/02-kind-mismatch.ts
```

## 예제

| 파일                      | 보이는 것                                                     |
| ------------------------- | ------------------------------------------------------------- |
| `src/01-encode-decode.ts` | 텍스트, asset, 빈 폴더를 인코딩하고 디코딩해 항목을 출력한다. |
| `src/02-kind-mismatch.ts` | 다른 `kind`로 열면 `kind-mismatch`로 실패한다.                |

`01-encode-decode.ts` 출력:

```text
인코딩 결과: 802바이트 (application/octet-stream)
kind: example.basic
text  project.json: {"title":"hello"}
asset media/logo.png: 4바이트
folders: empty, media
```

`02-kind-mismatch.ts` 출력:

```text
디코딩 실패: kind-mismatch
```

옵션 설명은 `packages/projectfile/README.md`에 있다.
