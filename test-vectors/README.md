# test-vectors

프로젝트 파일 포맷의 시험 파일과 기대 결과다. 다른 언어 구현(예: 서버의 헤더 검사)이 이 디렉터리를 가져가 같은 결과를 내는지 확인한다. npm 패키지에는 들어가지 않는다.

- 포맷 규칙은 `docs/format.md`가 소유한다.
- 파일은 `.bin`이다. 바이트를 그대로 읽는다. 줄바꿈 변환을 하지 않는다.
- `vectors.json`이 파일마다 기대 결과를 적는다.

## vectors.json

최상위 필드:

| 필드                    | 내용                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| `defaultScrambleKey`    | 기본 scramble 키. 16바이트 hex                                                                    |
| `defaultScrambleTable`  | 기본 키의 치환표 256바이트. hex. 인덱스 x의 바이트가 `표[x]`다                                    |
| `defaultScrambleStream` | 기본 키의 위치 0~15 키스트림 16바이트. hex. 인덱스 p의 바이트가 `키스트림(p)`다                   |
| `rules`                 | 디코딩에 쓴 이름·코드 규칙. `maxPathLength`, 조각 길이 상한, 코드 파일 판정(루트 파일명과 확장자) |
| `limits`                | 디코딩에 쓴 한도. 모든 항목                                                                       |
| `cases`                 | 사례 목록                                                                                         |

scramble 중간값:

- `defaultScrambleTable`과 `defaultScrambleStream`은 `docs/format.md`의 "scramble 알고리즘" 결과다.
- `.bin` 파일을 열기 전에 두 값을 맞춰 보면 치환표 생성과 키스트림 해시의 오류를 따로 찾을 수 있다.
- 키스트림은 `defaultScrambleKey`의 워드 `w0`, `w1`, `w2`로 만든다. 치환표는 `w3`으로 만든다.

사례 필드:

| 필드           | 내용                                                                     |
| -------------- | ------------------------------------------------------------------------ |
| `name`         | 사례 이름. 유일하다                                                      |
| `file`         | 이 디렉터리의 시험 파일. 사례 둘이 같은 파일을 쓸 수 있다                |
| `kind`         | `decodeProjectFile`에 넘기는 기대 kind                                   |
| `scrambleKeys` | 디코딩에 넘기는 키 목록(hex). `null`이면 키를 넘기지 않아 기본 키를 쓴다 |
| `header`       | 헤더 단계 결과. 키 없이 헤더만 읽는 구현이 이 값과 비교한다              |
| `decode`       | 디코딩 결과. 전체를 여는 구현이 이 값과 비교한다                         |
| `description`  | 사례 설명. 있는 사례만 가진다. 비교하지 않는다                           |

결과 모양:

- 헤더 성공: `{ ok: true, version, kind, payloadLength, headerBytes, keyCheck }`.
- 헤더 실패: `{ ok: false, reason }`. 모르는 버전(1과 2가 아닌 값)은 `version`을 더한다.
- 디코딩 성공: `{ ok: true, folders, entries }`. 텍스트 항목은 `text`, asset 항목은 본문 바이트 `hex`를 가진다.
  - 순서까지 비교한다. `entries`는 manifest 순서, `folders`는 중앙 디렉터리 순서다(`docs/format.md`의 "항목 순서").
- 디코딩 실패: `{ ok: false, reason }`. `invalid-name`은 걸린 항목의 `path`와 `cause`를 더한다.
- kind 이유는 둘이다. 헤더의 kind 길이나 문자열이 kind 규칙을 어기면 `kind-invalid`다(`kind-length-0`, `kind-length-65`, `kind-uppercase`, `kind-trailing-newline`). 규칙을 지킨 kind가 기대한 kind와 다르면 `kind-mismatch`다. 이 벡터에는 `kind-mismatch` 사례가 없다. 키 없이 헤더만 읽는 구현은 기대한 kind를 받지 않으므로 `kind-invalid`만 낸다.

두 단계의 관계:

- `header`가 실패면 `decode`는 같은 실패다. 두 함수가 같은 헤더 검사를 쓴다.
- `header`가 성공이고 `decode`가 실패면 헤더 뒤 단계에서 걸린 사례다. `scramble-key-mismatch`와 `crc-mismatch`가 있다. `crc-mismatch`는 헤더의 CRC 필드를, `crc-mismatch-local`은 첫 로컬 헤더의 서명 바이트를 바꾼 파일이다. 뒤 사례는 CRC를 로컬 헤더 해석보다 먼저 봐야 이 이유가 나온다. 중앙 디렉터리는 범위를 정할 때 해석하므로 거기를 바꾸면 `zip-corrupt`일 수 있다.

포맷 버전 2 사례:

- `full-scramble`, `full-scramble-mixed`, `full-scramble-asset-last`는 ZIP 전체를 섞은 정상 파일이다. `header.version`이 2다.
- `full-scramble-crc-mismatch-asset`은 `full-scramble-asset-last`의 마지막 asset 본문 바이트(`centralStart - 1`)를 바꾼 파일이다.
  - 버전 2의 헤더 CRC가 ZIP 전체를 보므로 `crc-mismatch`다.
  - 같은 위치를 바꾼 버전 1 파일은 CRC 범위 밖이라 열린다.

이름 검사 사례:

- `duplicate-nfc-nfd`는 같은 폴더의 두 파일 이름이 NFC로 같은 파일이다. 이름은 U+AC00 + `.txt`와 U+1100 U+1161 + `.txt`다.
- 형제 중복 키는 소문자 변환 뒤 NFC 정규화다("이름 규칙"은 `docs/format.md`에 있다). 디코딩은 둘째 이름을 `invalid-name`, `duplicate`로 거부한다. `path`는 둘째 이름이다.
- 인코더는 이 파일을 만들지 않는다. 생성 스크립트가 이 라이브러리를 쓰지 않고 직접 조립한다. deflate만 fflate를 쓴다. 조립기는 정상 파일의 바이트가 인코더 출력과 같은지 먼저 확인한다.
- 두 이름은 화면에서 같게 보인다. `path`와 파일 안의 이름을 코드 포인트로 비교한다.

## 다시 만들기

파일은 생성 스크립트가 만들고 결과를 커밋한다. 인코딩이 결정적이라 다시 만들어도 같은 바이트다.

```bash
pnpm vectors:generate
git diff --stat test-vectors   # 비어 있어야 한다
```

- 스크립트는 `packages/projectfile/scripts/build-vectors.mjs`다. 사례를 더하거나 고칠 때 여기를 고친다.
- `packages/projectfile/tests/vectors.test.ts`가 기대 값과 라이브러리 결과, 생성 결과와 커밋된 파일을 비교한다.
