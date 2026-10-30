# @cp949/projectfile

프로젝트 파일의 인코더와 디코더다.

- 항목 목록(경로, 종류, 내용)을 `Blob` 하나로 만들고, 그 `Blob`을 항목 목록으로 되돌린다.
- 목적은 인라인 보안 검사 장비의 오탐을 피하는 것이다.
  - 소스 텍스트를 그대로 보내면 장비가 오탐해 차단한 적이 있다.
  - 일반 ZIP은 장비가 열어 본다.
  - 그래서 ZIP 메타데이터와 `manifest.json` 본문을 섞는다(scramble).
  - 장비가 통과시키는지는 장비마다 다르다. 라이브러리는 통과를 보장하지 않는다.
- 파일 트리, 화면, 에디터를 모른다. 바이트와 항목만 안다.
- 브라우저와 Node에서 돈다. `Blob`, `Response`, `TextEncoder`, `TextDecoder` 전역이 필요하다.
- 의존은 `fflate` 하나다.

사양의 원천은 저장소 루트의 [`docs/format.md`](https://github.com/cp949/projectfile/blob/main/docs/format.md)다. 포맷, 검사 순서, 한도 규칙이 거기에 있다.

## 설치

```sh
pnpm add @cp949/projectfile
```

## 지원 환경

- Node 하한은 24.18이다. `engines.node`는 `>=24.18`이다.
- CI의 소비 검사는 Node 24.18.x, 24.x, 26.x에서 `npm pack` tarball을 설치해 실행한다.
- 24.18보다 낮은 Node는 CI에서 시험하지 않는다.
- 브라우저 하한은 Chrome 75다. 빌드 target은 `chrome75`다.
- 전역 polyfill을 넣지 않는다. 하한에 없는 API는 쓰지 않는다.
- `Blob.prototype.arrayBuffer()`는 Chrome 76부터라서 `Response`로 읽는다([`src/blob.ts`](https://github.com/cp949/projectfile/blob/main/packages/projectfile/src/blob.ts)).
- `check-types`는 `tsconfig.build.json`의 `lib`(ES2019 + DOM)로 ES2020 이후 API 사용을 잡는다.
- `check:escompat`은 `dist/index.js`와 `fflate`의 ESM 산출물이 ES2019 문법인지 parse로 검사한다.
- `check:escompat`은 [`scripts/check-banned-api.mjs`](https://github.com/cp949/projectfile/blob/main/packages/projectfile/scripts/check-banned-api.mjs)로 `src`에서 하한에 없는 API 이름도 찾는다. 주석은 뺀다. 대상은 `Blob`의 `arrayBuffer`·`text`·`stream`, `Object.hasOwn`, `.at(`, `structuredClone`, `replaceAll` 같은 이름이다. 목록은 스크립트의 `RULES`다.
- 한계: 이름 검색이라 동적 접근(`obj[name]()`)과 목록에 없는 API는 못 잡는다. 목록에 없는 새 API는 리뷰에서 확인한다.
- 한계: Chrome 75를 실제로 실행하지 않는다. Playwright가 Chrome 82 미만을 구동하지 못한다. 하한은 정적 검사로만 확인한다.

## 사용

텍스트 하나를 인코딩하고 디코딩하는 최소 예다. `kind`, `rules`, `limits`는 필수 옵션이다. 옵션 설명은 "rules", "limits", "kind"에 있다.

```ts
import { decodeProjectFile, encodeProjectFile } from "@cp949/projectfile";

const rules = { maxPathLength: 256, isCode: () => false };
const limits = {
  maxFiles: 100,
  maxFolders: 100,
  maxAssetBytes: 1024 * 1024,
  maxAssetsTotalBytes: 1024 * 1024,
  maxCodeBytes: 1024 * 1024,
  maxUncompressedBytes: 2 * 1024 * 1024,
};
const options = { kind: "acme.blocks", rules, limits };

const entries = [{ path: "a.json", type: "text" as const, data: "{}" }];
const encoded = await encodeProjectFile({ ...options, entries });
if (!encoded.ok) throw new Error(encoded.failure.reason);

const decoded = await decodeProjectFile(encoded.value, options);
if (!decoded.ok) throw new Error(decoded.failure.reason);
console.log(decoded.value.entries); // [{ path: "a.json", type: "text", data: "{}" }]
```

인코딩:

```ts
import {
  encodeProjectFile,
  type ProjectFileLimits,
  type ProjectFileRules,
} from "@cp949/projectfile";

const rules: ProjectFileRules = {
  maxPathLength: 256,
  isCode: (path) => path === "project.json",
};
const limits: ProjectFileLimits = {
  maxFiles: 200,
  maxFolders: 200,
  maxAssetBytes: 5 * 1024 * 1024,
  maxAssetsTotalBytes: 50 * 1024 * 1024,
  maxCodeBytes: 1024 * 1024,
  maxUncompressedBytes: 51 * 1024 * 1024,
};

const result = await encodeProjectFile({
  kind: "acme.blocks",
  entries: [
    { path: "project.json", type: "text", data: '{"items":[]}' },
    { path: "media/cat.png", type: "asset", data: catBlob },
  ],
  folders: ["media", "empty-folder"],
  rules,
  limits,
});
if (result.ok) {
  // result.value는 application/octet-stream Blob이다.
} else {
  // result.failure.reason으로 안내를 고른다.
}
```

`limits` 값은 예시다.

- `maxUncompressedBytes` 51 MiB는 `maxAssetsTotalBytes` 50 MiB와 `maxCodeBytes` 1 MiB의 합이다.
- 모든 파일은 코드 한도와 asset 한도 중 하나에 센다. 그래서 두 한도를 지킨 입력은 `maxUncompressedBytes`를 넘지 않는다.
- 라이브러리는 세 값의 관계를 검사하지 않는다.

디코딩:

```ts
import { decodeProjectFile } from "@cp949/projectfile";

const result = await decodeProjectFile(fileOrBytes, {
  kind: "acme.blocks",
  rules,
  limits,
});
if (result.ok) {
  const { kind, entries, folders } = result.value;
  // text 항목의 data는 string, asset 항목의 data는 Blob이다.
}
```

- 입력은 `Blob` 또는 `Uint8Array`다. 입력 `Uint8Array`는 바꾸지 않는다.
- `Blob` 입력은 필요한 범위만 읽는다. asset 본문은 읽지 않는다. 범위는 [`docs/format.md`](https://github.com/cp949/projectfile/blob/main/docs/format.md)의 "읽기 방식"에 있다.
- 인코딩의 asset `data`는 `Blob` 또는 `Uint8Array`다. text `data`는 `string`이다.
- text `data`의 짝 없는 서로게이트(U+D800..U+DFFF 코드 유닛)는 UTF-8 인코딩에서 U+FFFD로 바뀌어 저장된다.
  - 오류로 알리지 않는다. 디코딩 결과는 입력과 같지 않다.
  - 필요하면 호출자가 인코딩 전에 직접 검사한다.
  - 경로의 짝 없는 서로게이트는 다르다. `invalid-char`로 거부한다.
- 경로는 `/`로 이은 이름이다(`media/cat.png`). `files/` 같은 접두사를 붙이지 않는다.
- 폴더는 항목이 아니다. 빈 폴더를 담으려면 `folders`에 적는다. 파일 경로의 조상 폴더는 적지 않아도 생긴다.
- 디코딩의 `folders`는 ZIP의 폴더 항목이다. 인코딩은 파일의 조상 폴더도 폴더 항목으로 담는다. 그래서 인코딩 때 `folders`에 적지 않은 조상 폴더도 돌아온다.
- 열 수 없는 파일은 던지지 않고 `ProjectFileFailure`를 `ok: false`로 돌려준다.
- 인코딩이 asset `Blob`을 읽지 못해도 던지지 않는다. `read-failed`와 읽지 못한 asset의 `path`를 돌려준다.

호출자 버그는 던진다. 코덱이 검사해 던지는 조건은 아래 표가 전부다.

| 조건                                                                                | 던지는 값    | 메시지 앞부분                                       | 함수                                                            |
| ----------------------------------------------------------------------------------- | ------------ | --------------------------------------------------- | --------------------------------------------------------------- |
| `kind`가 정규식 `^[a-z0-9][a-z0-9._-]{0,63}$`를 어긴다. 문자열이 아니어도 같다.     | `Error`      | `kind가 규칙을 어겼다:`                             | `encodeProjectFile`, `decodeProjectFile`                        |
| `scrambleKey`가 길이 16의 `Uint8Array`가 아니다.                                    | `RangeError` | `scrambleKey는 길이 16의 Uint8Array여야 한다`       | `encodeProjectFile`                                             |
| `scrambleKeys`가 키 하나 이상인 배열이 아니다.                                      | `RangeError` | `scrambleKeys는 키가 하나 이상인 배열이어야 한다`   | `decodeProjectFile`                                             |
| `scrambleKeys`의 키가 길이 16의 `Uint8Array`가 아니다.                              | `RangeError` | `scrambleKeys의 키는 길이 16의 Uint8Array여야 한다` | `decodeProjectFile`                                             |
| `scrambleKeys`에 키 확인값이 같은 키가 둘 이상이다.                                 | `RangeError` | `scrambleKeys에 키 확인값이 같은 키가 둘 이상이다`  | `decodeProjectFile`                                             |
| `rules.maxPathLength`가 1 이상 1,024 이하의 정수가 아니다.                          | `RangeError` | `maxPathLength는 1 이상 1024 이하의 정수여야 한다:` | `encodeProjectFile`, `decodeProjectFile`                        |
| `limits`의 항목 하나가 0 이상의 안전한 정수(`Number.isSafeInteger`)가 아니다.       | `RangeError` | `<항목 이름>는 0 이상의 정수여야 한다:`             | `encodeProjectFile`, `decodeProjectFile`, `maxProjectFileBytes` |
| `limits.maxUncompressedBytes`가 `MAX_UNCOMPRESSED_BYTES_CEILING`(256 MiB)을 넘는다. | `RangeError` | `maxUncompressedBytes는 268435456 이하여야 한다:`   | `encodeProjectFile`, `decodeProjectFile`, `maxProjectFileBytes` |
| `limits.maxFiles` + `limits.maxFolders`가 65,533을 넘는다.                          | `RangeError` | `maxFiles + maxFolders + 2는 65535 이하여야 한다:`  | `encodeProjectFile`, `decodeProjectFile`, `maxProjectFileBytes` |

- `encodeProjectFile`과 `decodeProjectFile`은 `async`라서 동기로 던지지 않고 반환한 `Promise`를 reject한다.
- `maxProjectFileBytes`는 동기로 던진다.
- 검사 순서는 `kind`, 키, `rules`, `limits`다. 여러 조건을 어기면 먼저 걸린 하나만 던진다.
- 타입을 어긴 그 밖의 인자(배열이 아닌 `entries` 등)는 검사하지 않는다. `rules`의 함수가 던진 오류는 바꾸지 않고 전파한다.

## asset Blob

- 인코딩은 asset `Blob`을 복사하지 않고 출력에 넣는다. CRC32를 계산하려고 1 MiB씩 읽는다.
- 디코딩한 asset `data`는 `Blob`이다.
  - `Blob` 입력이면 입력을 `slice`한 `Blob`이다.
  - `Uint8Array` 입력이면 그 범위를 복사해 `new Blob`으로 만든 것이다.
- 큰 파일은 `File`이나 `Blob`을 그대로 넘긴다. `Uint8Array` 입력은 asset마다 범위를 복사한다.
- Chrome은 메모리에 있는 `Blob` 총량에 한계가 있다. 이 저장소 측정에서는 약 500 MiB였다([ADR-0001](https://github.com/cp949/projectfile/blob/main/docs/adr/0001-uncompressed-bytes-ceiling.md)).
  - 한계를 넘은 뒤에 만든 `Blob`은 읽을 때 실패한다.
  - 다 쓴 입력 asset `Blob`과 asset `Blob`의 참조는 놓는다.
- `Blob` 입력의 원본이 바뀌거나 사라진 뒤에 asset `Blob`을 읽으면 읽기가 실패할 수 있다. 입력 `Blob`과 asset `Blob`의 수명은 호출자 책임이다.
- 디코딩은 asset 본문을 읽지 않는다. 손상도 검사하지 않는다("포맷 버전").

## rules

라이브러리가 모르는 정책을 호출자가 주입한다.

| 항목            | 내용                                                                              |
| --------------- | --------------------------------------------------------------------------------- |
| `maxPathLength` | 항목 경로의 최대 길이(UTF-16 코드 유닛). `MAX_PATH_LENGTH_CEILING`(1,024) 이하다. |
| `checkSegment`  | 선택. 경로 조각 하나를 검사한다. 통과하면 `null`, 아니면 거부 이유다.             |
| `isCode(path)`  | 텍스트 항목이 코드 한도(`maxCodeBytes`)에 세는 항목이면 참이다.                   |

```ts
const rules: ProjectFileRules = {
  maxPathLength: 256,
  checkSegment: (kind, segment) =>
    kind === "file" && !segment.endsWith(".json") ? "invalid-extension" : null,
  isCode: (path) => path === "project.json",
};
```

- `checkSegment`의 `kind`는 `file`, `folder`, `asset`이다. 마지막 조각만 항목 종류를 따르고 나머지는 `folder`다.
- 돌려줄 수 있는 이유는 `ProjectNameCause`다.
- `MAX_PATH_LENGTH_CEILING`(1,024)은 입력 크기 상한(`maxProjectFileBytes`)의 근거다. 올리면 상한이 커지고, 옛 버전은 새 상한으로 만든 큰 파일을 거부한다. 그래서 값을 올리지 않는다.
- 파일을 디스크에 푸는 소비자는 플랫폼 이름 규칙(Windows 예약 이름 `CON`, `:` 등)을 직접 더 검사한다. 무결성 규칙은 경로 탈출(`..`, `\`, 앞 `/`)만 막는다.
- 컨테이너 무결성 규칙은 `rules`와 무관하게 항상 강제한다. `checkSegment`로 풀 수 없다.
  - 빈 조각, `.`·`..`, `\`, 제어 문자, 짝 없는 서로게이트, 앞뒤 공백.
  - 형제 사이 중복. 대소문자와 NFC 정규형 차이를 무시한다. 저장하고 복원하는 이름은 그대로다.
  - 경로 길이 `maxPathLength` 초과.

## limits

모든 항목이 필수다. 기본값은 없다.

| 항목                   | 내용                                                            |
| ---------------------- | --------------------------------------------------------------- |
| `maxFiles`             | 파일(텍스트와 asset) 개수. 폴더는 세지 않는다.                  |
| `maxFolders`           | 폴더 개수. 파일 경로의 조상으로만 생기는 폴더도 센다.           |
| `maxAssetBytes`        | asset 하나의 바이트. `isCode`가 거짓인 텍스트도 asset으로 센다. |
| `maxAssetsTotalBytes`  | asset의 바이트 합.                                              |
| `maxCodeBytes`         | `isCode`가 참인 텍스트의 UTF-8 바이트 합.                       |
| `maxUncompressedBytes` | 압축을 풀었을 때 모든 파일의 바이트 합.                         |

- 인코딩과 디코딩이 같은 한도로 검사한다. 만든 파일을 같은 한도로 못 여는 일이 없다.
- 디코딩은 압축을 풀기 전에 ZIP 헤더가 선언한 크기로 검사한다.
- 디코딩은 로컬 헤더를 읽기 전에 ZIP 끝 레코드의 항목 수를 `maxFiles` + `maxFolders` + 2와 비교한다. 넘으면 `zip-corrupt`다. 인코더는 한도 안에서 이 수를 넘는 파일을 만들지 않는다. 합 이하에서 `maxFiles`나 `maxFolders` 한 항목만 넘으면 `limit-exceeded`다.
- 디코딩은 읽기 전에 입력 크기를 `maxProjectFileBytes(limits)`와 비교한다. 넘으면 `input-too-large`다. 풀린 크기 합계가 `maxUncompressedBytes`를 넘으면 `limit-exceeded`다.
- 한도와 별개로 `manifest.json`(파일 경로 목록)은 1 MiB 이하여야 한다. 넘으면 인코딩이 `manifest-too-large`로 거부한다. 경로가 모두 1,024 코드 유닛의 비 ASCII이면 파일 약 340개에서 넘는다. 긴 경로를 허용하면서 `maxFiles`를 크게 잡으면 한도 안의 입력도 거부될 수 있다.

절대 상한:

- `maxUncompressedBytes`는 `MAX_UNCOMPRESSED_BYTES_CEILING`(256 MiB) 이하여야 한다. 넘으면 인코딩과 디코딩이 던진다.
- 상한은 입력 크기 상한(`maxProjectFileBytes`)과 해제 메모리를 묶는다.
- 상한을 올려도 포맷은 바뀌지 않는다. 다만 올린 버전이 만든 큰 파일을 옛 버전은 `input-too-large`나 `limit-exceeded`로 거부할 수 있다.

입력 크기 상한:

- `maxProjectFileBytes(limits)`는 한도 안의 항목을 인코딩한 파일이 넘지 않는 크기(바이트)다. 한도가 잘못되면 인코딩·디코딩과 같이 던진다.
- 헤더는 최대 길이(`MAX_HEADER_BYTES`, 86바이트)로 잡는다. 계산식은 [`docs/format.md`](https://github.com/cp949/projectfile/blob/main/docs/format.md)의 "입력 크기 상한"에 있다.
- 호출자가 입력 크기를 직접 검사할 때 쓴다. 예: 업로드 크기 제한, 암호문 크기 검사("기밀성").

## kind

사용처가 정하는 문자열이다. 헤더와 manifest가 적는다. 디코딩은 기대한 `kind`와 다르면 `kind-mismatch`로 거부한다. kind 자체가 규칙을 어기면 `kind-invalid`다.

- 규칙은 정규식 `^[a-z0-9][a-z0-9._-]{0,63}$`다. 1자 이상 64자 이하이고 대문자를 받지 않는다.
- 비교는 완전 일치다.
- 다른 사용처와 겹치지 않게 `acme.blocks`처럼 앞에 이름을 붙이기를 권한다. 강제하지 않는다.
- 라이브러리는 kind 목록을 갖지 않는다.
- 옵션의 `kind`가 규칙을 어기면 던진다.
- 파일 헤더의 kind가 규칙을 어기면 `kind-invalid`다.

## scramble 키

scramble에 쓰는 키는 16바이트 `Uint8Array`다. 길이가 다르면 던진다.

| 옵션           | 내용                                                                 |
| -------------- | -------------------------------------------------------------------- |
| `scrambleKey`  | 인코딩. 비우면 `DEFAULT_SCRAMBLE_KEY`다.                             |
| `scrambleKeys` | 디코딩. 풀 수 있는 키의 목록이다. 비우면 `[DEFAULT_SCRAMBLE_KEY]`다. |

- 헤더가 키 확인값(키의 CRC32)을 적는다. 디코딩은 목록에서 확인값이 같은 키를 고른다. 없으면 `scramble-key-mismatch`다.
- 목록을 주면 목록의 키만 쓴다. 기본 키를 자동으로 더하지 않는다. 기본 키도 받으려면 목록에 넣는다.
- 빈 배열이나 키 확인값이 같은 키가 둘 이상인 목록은 던진다. 어느 키로 풀지 정할 수 없다.
- 키 확인값은 헤더에 평문으로 있다. scramble은 기밀성을 약속하지 않는다("scramble은 암호가 아니다").

사용처 키를 쓰는 예:

```ts
// 키는 한 번 만들어 보관한다. 키를 잃으면 그 키로 만든 파일을 열 수 없다.
const scrambleKey = crypto.getRandomValues(new Uint8Array(16));

await encodeProjectFile({
  kind: "acme.blocks",
  entries,
  rules,
  limits,
  scrambleKey,
});
await decodeProjectFile(file, {
  kind: "acme.blocks",
  rules,
  limits,
  scrambleKeys: [scrambleKey],
});
```

## readProjectFileHeader

키 없이 헤더만 읽고 검사한다. 서버가 업로드된 파일의 헤더만 검사하는 용도다.

```ts
import { readProjectFileHeader } from "@cp949/projectfile";

const result = await readProjectFileHeader(fileOrBytes);
if (result.ok) {
  const { version, kind, payloadLength, headerBytes, keyCheck } = result.value;
  // kind가 서버가 받는 종류인지는 호출자가 비교한다.
} else {
  // result.failure.reason: read-failed, bad-magic, length-mismatch,
  // unsupported-version, kind-invalid
}
```

- 키가 필요 없다. `Blob` 입력은 앞 86바이트(`MAX_HEADER_BYTES`)까지만 읽는다.
- 입력 크기 상한은 보지 않는다. 크기 제한이 필요하면 호출자가 `maxProjectFileBytes(limits)`로 직접 검사한다.
- 통과해도 파일이 열린다는 뜻이 아니다. 검사 범위와 실패 이유는 [`docs/format.md`](https://github.com/cp949/projectfile/blob/main/docs/format.md)의 "readProjectFileHeader"에 있다.

돌려주는 필드:

| 필드            | 내용                                                      |
| --------------- | --------------------------------------------------------- |
| `version`       | 포맷 버전. 1                                              |
| `kind`          | 헤더의 kind 문자열                                        |
| `payloadLength` | payload(ZIP 전체)의 바이트 길이                           |
| `headerBytes`   | 헤더의 바이트 길이. 22 + kind 길이                        |
| `keyCheck`      | 봉인한 scramble 키 16바이트의 CRC32. 0 이상의 uint32 정수 |

## 받는 쪽 검사 책임

- 서버는 헤더만 검사한다. 내용(텍스트, asset)은 검사하지 않는다.
- 내용 검사가 필요하면 받는 쪽이 `decodeProjectFile`로 디코딩한 뒤 검사한다.
- 헤더 검사만으로는 파일이 열린다는 것도, 내용이 안전하다는 것도 알 수 없다.

## 포맷 버전

포맷 버전은 1 하나다. 헤더와 manifest가 적는다. 바이트 배치와 검사 순서는 [`docs/format.md`](https://github.com/cp949/projectfile/blob/main/docs/format.md)에 있다.

- 헤더는 magic `OCOD`, 포맷 버전, kind, payload 길이, CRC32, 키 확인값이다. scramble하지 않는다.
- 모르는 헤더 버전은 `unsupported-version`으로 거부한다.
- ZIP 메타데이터(로컬 헤더, 중앙 디렉터리, 끝 레코드)와 manifest 본문을 scramble한다. 헤더 CRC는 그 범위만 본다.
- 열 때 텍스트 본문은 ZIP 항목 CRC32로 검사한다. asset 본문 손상은 검사하지 않는다.

## 실패 이유

`ProjectFileFailure.reason`이다.

| `reason`                 | 뜻                                                                             |
| ------------------------ | ------------------------------------------------------------------------------ |
| `read-failed`            | `Blob`을 읽지 못했다. 인코딩은 `path`에 읽지 못한 asset 경로를 담는다.         |
| `bad-magic`              | 앞 4바이트가 `OCOD`가 아니다.                                                  |
| `unsupported-version`    | 헤더 버전을 모른다. `version` 필드가 있다.                                     |
| `kind-invalid`           | 헤더의 kind 길이나 문자열이 kind 규칙을 어긴다.                                |
| `kind-mismatch`          | 헤더 kind는 규칙을 지켰지만 기대한 `kind`와 다르다.                            |
| `length-mismatch`        | 파일 길이가 헤더와 맞지 않는다. 잘렸거나 뒤에 덧붙었다.                        |
| `scramble-key-mismatch`  | 헤더의 키 확인값과 같은 키가 디코딩 키 목록에 없다.                            |
| `crc-mismatch`           | 복원한 범위의 CRC32가 헤더 값과 다르다.                                        |
| `zip-corrupt`            | ZIP 손상, ZIP 항목 수 상한 초과, 내용과 선언의 불일치, 저장 방식이 아닌 asset. |
| `manifest-invalid`       | `manifest.json`이 크기 상한을 넘거나 형식이 틀리거나 ZIP 항목과 맞지 않는다.   |
| `manifest-kind-mismatch` | 헤더 kind와 manifest kind가 다르다.                                            |
| `manifest-too-large`     | 인코딩만 돌려준다. 만들 manifest가 1 MiB(1,048,576바이트)를 넘는다.            |
| `invalid-name`           | 이름 규칙 위반. `path`와 `cause`(`ProjectNameCause`)가 있다.                   |
| `input-too-large`        | 디코딩 입력이 입력 크기 상한을 넘는다. `maxBytes`에 상한이 있다.               |
| `limit-exceeded`         | 한도 초과. `limit`에 넘은 한도 이름이 있다.                                    |

`readProjectFileHeader`는 `read-failed`, `bad-magic`, `length-mismatch`, `unsupported-version`, `kind-invalid`만 돌려준다.

## scramble은 암호가 아니다

- 목적은 머리말의 오탐 회피다. 압축 유틸리티가 파일 목록을 읽지 못하게 한다.
- 복원 규칙이 이 라이브러리 코드에 있어 분석하면 풀 수 있다.
- 기밀성과 변조 방지를 약속하지 않는다.

## 기밀성

기밀성이 필요하면 `encodeProjectFile`의 출력 `Blob`을 표준 암호로 감싼다. 아래는 WebCrypto AES-GCM 예다. 복호화한 뒤 `decodeProjectFile`에 넘긴다.

```ts
import {
  decodeProjectFile,
  encodeProjectFile,
  maxProjectFileBytes,
} from "@cp949/projectfile";

// aesKey는 AES-GCM `CryptoKey`다. 키 관리는 호출자 몫이다.
const IV_BYTES = 12;
const TAG_BYTES = 16;

// 암호화: iv(12바이트) + 암호문(원문 + 태그 16바이트)을 Blob 하나로 묶는다.
async function seal(aesKey: CryptoKey): Promise<Blob | null> {
  const encoded = await encodeProjectFile({ kind, entries, rules, limits });
  if (!encoded.ok) return null;
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plain = await new Response(encoded.value).arrayBuffer();
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    plain,
  );
  return new Blob([iv, cipher]);
}

// 복호화: 복호화하기 전에 암호문 크기를 직접 검사한다.
async function open(sealed: Blob, aesKey: CryptoKey) {
  if (sealed.size > maxProjectFileBytes(limits) + IV_BYTES + TAG_BYTES) {
    // 한도 안의 파일이 만들 수 없는 크기다. 복호화하지 않고 거부한다.
    return null;
  }
  const buffer = await new Response(sealed).arrayBuffer();
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(buffer, 0, IV_BYTES) },
      aesKey,
      new Uint8Array(buffer, IV_BYTES),
    );
  } catch {
    // 키가 다르거나, 암호문이 바뀌었거나, IV보다 짧다.
    return null;
  }
  return decodeProjectFile(new Uint8Array(plain), { kind, rules, limits });
}
```

- IV는 암호화마다 새로 만든다. 같은 키로 IV를 다시 쓰면 AES-GCM의 기밀성과 인증이 깨진다.
- 키가 다르거나 암호문이 바뀌면 `decrypt`가 거부한다. 예는 이때 던지지 않고 `null`을 돌려준다.
- 복호화 전에 암호문 크기를 `maxProjectFileBytes(limits)` + 암호화 증가분으로 검사한다. `decodeProjectFile`의 입력 크기 검사는 복호화한 평문에만 걸리기 때문이다.
- 암호화 증가분은 쓰는 암호가 정한다. 위 예는 IV 12바이트와 인증 태그 16바이트다.
- WebCrypto의 `encrypt`와 `decrypt`는 스트리밍이 없다. 입력 전체와 결과가 메모리에 올라간다.
- 암호화한 파일은 `readProjectFileHeader`로 읽을 수 없다. 헤더가 암호문 안에 있다.

## test-vectors

저장소 루트 [`test-vectors/`](https://github.com/cp949/projectfile/tree/main/test-vectors)는 다른 언어 구현이 같은 결과를 내는지 확인하는 시험 파일과 기대 결과다. npm 패키지에는 들어가지 않는다. 용도는 [`docs/format.md`](https://github.com/cp949/projectfile/blob/main/docs/format.md)의 "test-vectors", 파일 형식은 [`test-vectors/README.md`](https://github.com/cp949/projectfile/blob/main/test-vectors/README.md)에 있다.

## 개발

```sh
pnpm --filter @cp949/projectfile test
pnpm --filter @cp949/projectfile test:browser
pnpm --filter @cp949/projectfile check-types
pnpm --filter @cp949/projectfile build
pnpm --filter @cp949/projectfile check:escompat
```

- `exports`는 `dist`를 가리킨다. 소비하기 전에 `build`가 필요하다.
- `check:escompat`은 `dist`를 검사한다. `build` 뒤에 실행한다.
- `test:browser`는 Chromium에서 `Blob` 경로 시험 일부를 실행한다. Chromium 설치와 범위는 저장소 루트 [`README.md`](https://github.com/cp949/projectfile/blob/main/README.md)와 [`docs/agents/extra-checks.md`](https://github.com/cp949/projectfile/blob/main/docs/agents/extra-checks.md)에 있다.
- `dist`는 Git에 넣지 않는다.
- 배포는 `pnpm --filter @cp949/projectfile publish:npm`다. 절차는 [`docs/release.md`](https://github.com/cp949/projectfile/blob/main/docs/release.md)에 있다.

## Worker에서 호출

큰 프로젝트는 Worker에서 호출한다. 메인 스레드를 비우려는 용도다.

- `encodeProjectFile`의 압축(deflate)은 `fflate`의 동기 함수 `deflateSync`다([`src/zip-write.ts`](https://github.com/cp949/projectfile/blob/main/packages/projectfile/src/zip-write.ts)).
- `decodeProjectFile`의 해제(inflate)는 `fflate`의 동기 클래스 `Inflate`다([`src/zip.ts`](https://github.com/cp949/projectfile/blob/main/packages/projectfile/src/zip.ts)).
- scramble 계산도 동기 처리다. 근거는 [`docs/format.md`](https://github.com/cp949/projectfile/blob/main/docs/format.md)의 "scramble"이다.
- 메인 스레드에서 호출하면 동기 계산이 도는 동안 그 스레드의 다른 작업이 멈춘다.
- Worker는 호출한 스레드를 비워 줄 뿐이다. 걸리는 전체 시간은 줄이지 않는다.

호출 하나가 끝날 때까지 걸린 시간이다. Chrome에서 쟀다([ADR-0001](https://github.com/cp949/projectfile/blob/main/docs/adr/0001-uncompressed-bytes-ceiling.md)):

| 입력(풀린 크기 256 MiB)                                          | 인코딩 | 디코딩 |
| ---------------------------------------------------------------- | ------ | ------ |
| 텍스트 위주: 코드 아닌 텍스트 224 MiB, 코드 16 MiB, asset 16 MiB | 5.42 s | 1.79 s |
| asset 위주: asset 240 MiB, 코드 16 MiB                           | 0.85 s | 0.14 s |

- 동기 계산만의 시간은 재지 않았다. 위 시간에는 `Blob` 읽기도 들어 있다.
- 텍스트 위주 입력은 낱말 19개를 섞은 텍스트라 압축이 잘 된다. 다른 압축률은 재지 않았다.
- asset 위주 입력이 짧은 이유는 asset 본문을 압축하지 않고 디코딩이 읽지도 않기 때문이라고 본다. 구간별로 나눠 재지 않은 추정이다.
- PC 한 대에서 잰 값이다. Linux(WSL2), Intel Core i9-14900KF, RAM 32 GiB, 헤드리스 Chrome이다. 정확한 환경은 [`docs/adr/0001-uncompressed-bytes-ceiling.md`](https://github.com/cp949/projectfile/blob/main/docs/adr/0001-uncompressed-bytes-ceiling.md)에 있다.

Worker에서 인코딩해 `Blob`을 메인에 돌려주는 예:

```ts
// encode.worker.ts
import {
  encodeProjectFile,
  type ProjectEntry,
  type ProjectFileResult,
} from "@cp949/projectfile";
// "사용"의 kind, rules, limits를 내보내는 모듈이다.
import { kind, limits, rules } from "./project-config";

export type WorkerReply = ProjectFileResult<Blob> | { error: string };

function reply(message: WorkerReply) {
  self.postMessage(message);
}

// rules는 함수를 담아 postMessage로 넘길 수 없다. Worker 안에서 만든 값을 쓴다.
self.onmessage = async (
  event: MessageEvent<{ entries: ProjectEntry[]; folders: string[] }>,
) => {
  try {
    // 실패(ok: false)는 던지지 않고 값으로 오므로 그대로 메인에 보낸다.
    reply(await encodeProjectFile({ ...event.data, kind, rules, limits }));
  } catch (error) {
    // 호출자 버그는 던진다. async 처리기에서 던지면 메인이 응답을 받지 못하므로 메시지로 보낸다.
    reply({ error: String(error) });
  }
};
```

```ts
// main.ts
import type { ProjectEntry } from "@cp949/projectfile";
import type { WorkerReply } from "./encode.worker";

const worker = new Worker(new URL("./encode.worker.ts", import.meta.url), {
  type: "module",
});

// 한 번에 하나만 보낸다.
function encodeInWorker(entries: ProjectEntry[], folders: string[]) {
  return new Promise<WorkerReply>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<WorkerReply>) =>
      resolve(event.data);
    worker.onerror = (event) =>
      reject(new Error(event.message || "Worker 오류"));
    worker.postMessage({ entries, folders });
  });
}

const result = await encodeInWorker(entries, ["media"]);
if ("error" in result) {
  // 호출자 버그. Worker가 던진 오류다.
} else if (result.ok) {
  // result.value는 Blob이다.
} else {
  // result.failure.reason으로 안내를 고른다.
}
```

- 디코딩도 같은 모양이다. 메인이 `Blob`을 보내고 Worker가 `decodeProjectFile`을 부른다.
- `Blob`은 `postMessage`로 구조화 복제되어 넘어간다.
- `Uint8Array`는 `postMessage`의 두 번째 인자 transfer 목록에 `buffer`를 넣으면 소유권이 넘어간다. 보낸 쪽 `buffer`는 쓸 수 없게 된다.
- Worker에도 라이브러리가 쓰는 전역(이 문서 첫머리)이 있어야 한다.
  - 저장소의 브라우저 시험이 Chromium의 Worker에서 인코딩과 디코딩이 도는 것을 확인한다.
  - Worker가 만든 파일을 메인이 디코딩한 항목이 Worker의 디코딩 결과와 같은 것도 확인한다.
  - 다른 브라우저와 지원 하한(Chrome 75)은 돌려 보지 않았다("지원 환경").
- 예제의 `type: "module"` Worker는 Chrome 80부터 지원된다. 지원 하한(Chrome 75)까지 맞추려면 Worker를 classic Worker로 만들어야 한다.
