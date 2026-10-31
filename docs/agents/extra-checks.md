# 추가 검사

Node 시험(`packages/projectfile/tests/`) 밖에서 도는 검사의 범위와 규칙이다. 테스트 작성 판단은 [testing.md](./testing.md)를 따른다.

## 브라우저 시험

`Blob` 읽기 경로를 Node와 Chromium 두 환경에서 확인한다. 라이브러리의 대상 환경이 브라우저이기 때문이다.

위치:

- `vitest.browser.config.mts`: 브라우저 시험 설정. `vitest.config.mts`(Node)는 이 설정을 읽지 않고 커버리지도 Node 시험만 잰다.
- `tests/decode-read.test.ts`, `tests/roundtrip.test.ts`, `tests/full-scramble.test.ts`: Node 시험 파일을 그대로 브라우저에서도 돈다. 파일을 복제하지 않는다.
- `tests-browser/`: 브라우저에서만 돌리는 시험. 환경 단언(`environment.test.ts`), 인코딩의 `Blob` asset 읽기(`encode-blob.test.ts`), Worker 왕복(`worker-roundtrip.test.ts`, `codec.worker.ts`)이 있다.

실행:

```sh
pnpm --filter @cp949/projectfile exec playwright-core install chromium
pnpm --filter @cp949/projectfile test:browser
```

범위:

- 전체 시험을 옮기지 않는다. 브라우저에서 동작이 달라질 수 있는 부분만 돈다. `Blob.slice`, `Response` 읽기, `TextEncoder`·`TextDecoder`, Worker 안의 전역이다.
- 바이트 계산(CRC, scramble, 검사 순서, 한도)은 환경과 무관하다. Node 시험이 이미 확인한다.
- 같은 시험을 두 환경에서 도는 것은 중복이 아니라 환경별 검증이다.
- 브라우저 대상에 시험 파일을 더하려면 `vitest.browser.config.mts`의 `include`에 직접 적는다.
- 돌리는 브라우저는 설치한 Chromium의 Chrome Headless Shell이다. headless로 띄우기 때문이다. `README.md`의 "지원 환경" 하한 브라우저는 돌리지 않는다.
- 포맷 버전 1에서 인코딩의 `Blob` asset CRC는 디코딩이 확인하지 않는다. asset 본문을 읽지 않기 때문이다. `encode-blob.test.ts`가 같은 내용의 `Uint8Array` 인코딩과 바이트를 비교한다.

규칙:

- `verify`에 넣지 않는다. 로컬 `verify`가 Chromium 다운로드에 의존하지 않게 하기 위해서다. CI의 `browser` 작업이 실행한다.
- `tests-browser/environment.test.ts`는 시험이 실제로 브라우저에서 도는지 단언한다. 이 단언 없이 통과만 있으면 Node에서 돈 것과 구분되지 않는다.
- 설정은 cross-origin isolation 헤더를 켠다. 브라우저에서 `SharedArrayBuffer`는 이 조건에서만 생기고, 왕복 시험이 쓴다.
- `playwright`와 `playwright-core`는 같은 버전을 유지한다. `playwright`는 `playwright-core`를 정확한 버전으로 의존하고, 두 패키지의 버전이 다르면 `playwright-core`가 두 벌 설치된다.
- Worker는 소스(`src`)를 직접 import한다. `dist`를 쓰면 `build`가 먼저 필요하다.

## 소비 검사

배포 tarball을 설치해 Node 버전별로 쓸 수 있는지 확인한다. 소비자는 `src`가 아니라 `dist`와 `exports` 맵을 거쳐 패키지를 쓰기 때문이다.

위치: `packages/projectfile/scripts/check-consume.mjs`

실행:

```sh
pnpm build
pnpm check:consume
```

범위:

- vitest 없이 Node 내장 모듈만 쓰고 `node:assert`로 단언한다. 전체 시험은 `verify`의 Node 한 버전에서만 돌고, matrix의 각 Node에서는 이 검사만 돈다.
- 임시 디렉터리에 `npm pack` tarball을 설치하고 패키지 이름으로 import한다. 워크스페이스의 `src`와 `dist`는 거치지 않는다.
- 검사 항목은 최소 집합이다.
  - `package.json`의 `main`·`types`·`exports`가 가리키는 파일이 tarball에 있는지.
  - 값 export 이름 집합.
  - 텍스트·asset `Blob`·빈 폴더의 인코딩과 디코딩 왕복. 폴더 순서도 본다.
  - `Uint8Array` 입력 디코딩.
  - `readProjectFileHeader`.
  - 거부 값(`ok: false`) 1건.
  - 인코더 결과가 Node 전역 `Blob`인지.
- 동작 규칙(검사 순서, 한도, 이름 규칙)은 `tests/`가 확인한다. 이 검사에 규칙 시험을 더하지 않는다.
- `package.json`의 `exports` 형식(ESM 또는 CJS)이 바뀌면 스크립트가 실패한다. 스크립트의 import 방식을 새 형식에 맞춘다.

규칙:

- `verify`에 넣지 않는다. 설치 단계가 npm 레지스트리에서 `fflate`를 받으므로 로컬 `verify`가 네트워크에 의존하게 된다. CI의 `consume` 작업이 실행한다.
- 배포 직전에는 `docs/release.md`의 "절차" 3단계가 로컬에서 실행한다. 현재 Node 한 버전만 시험하고 네트워크가 필요하다.
- CI는 `verify`와 같은 Node로 빌드하고 `npm pack`한 뒤, `setup-node`로 matrix 버전으로 바꿔 tarball 경로를 인자로 스크립트에 준다. 인자가 있으면 스크립트는 pack을 건너뛴다.
- matrix는 선언한 범위(`engines.node`) 안의 최저 버전, 24 계열, 현재 최신 메이저를 시험한다. 24 계열은 runner 이미지에 캐시된 24.x다. 버전 목록의 원천은 `.github/workflows/ci.yml`이다. `packages/projectfile/README.md`의 "지원 환경"은 이를 따른다.

## 패키지 검사

배포 tarball의 `package.json` 메타데이터와 타입 해석이 맞는지 확인한다. `exports`나 `files`를 잘못 쓰면 시험과 소비 검사는 통과해도 일부 소비자 설정에서 타입이 풀리지 않을 수 있기 때문이다.

위치: `packages/projectfile/scripts/check-package.mjs`

실행:

```sh
pnpm build
pnpm check:package
```

범위:

- 같은 `npm pack` tarball을 publint(`--strict`)와 attw에 준다. 한 도구가 실패해도 다른 도구를 실행하고, 하나라도 실패하면 비정상 종료한다.
- publint는 `exports`, `files`, `main`, `types`가 가리키는 파일이 tarball에 있는지와 형식을 본다. 경고도 실패로 취급한다.
- attw는 node10, node16(CJS·ESM), bundler 해석별로 타입 선언이 풀리는지 본다.
- attw의 `cjs-resolves-to-esm` 규칙만 무시한다. 이 패키지는 ESM 전용이라 node16(CJS) 해석이 ESM으로 풀리는 것이 의도다. 다른 규칙과 해석 방식은 그대로 검사한다.
- attw의 `--profile esm-only`는 쓰지 않는다. node10 해석을 통째로 빼서 `main`이나 `types`가 빠져도 통과하기 때문이다.
- attw에는 `--no-definitely-typed`를 준다. 이 패키지는 자기 타입을 싣고 있어 `@types`를 찾는 단계가 필요 없고, 끄면 네트워크가 필요 없다.
- attw는 tarball에 타입 선언이 없으면 종료 코드 0으로 끝낸다. `types`나 `exports`의 `types` 조건이 없는 파일을 가리키면 publint가 실패시킨다. 타입 필드와 선언 파일을 함께 빼면 두 도구 모두 통과한다.

규칙:

- `verify`에 넣지 않는다. 검사 대상이 `build` 산출물을 묶은 tarball이라 `build` 뒤에 따로 실행하는 배포 전 검사다.
- CI는 `verify` 작업이 `pnpm verify` 뒤에 실행한다. 결과가 Node 버전에 따라 달라지지 않아 matrix를 도는 `consume` 작업에 넣지 않는다.
- 배포 직전에는 `docs/release.md`의 "절차" 3단계가 로컬에서 실행한다.
- 이 패키지의 지원 범위(ESM 전용)가 바뀌면 무시하는 규칙을 다시 정한다.

## README 예제 검사

`packages/projectfile/README.md`의 `ts` 코드 블록이 현재 공개 API로 타입 검사를 통과하는지 확인한다. API 이름이나 타입을 바꿔도 예제가 조용히 낡지 않게 하기 위해서다.

위치: `packages/projectfile/scripts/check-readme.mjs`, 선언 파일 `packages/projectfile/scripts/readme-types/`

범위:

- `check-types`의 마지막 단계다. `verify`와 CI의 `verify` 작업이 실행한다.
- 블록마다 별도 모듈로 쓰고 `tsc --noEmit` 한 번으로 검사한다. 엄격도와 `lib`은 `packages/projectfile/tsconfig.json`을 따른다.
- `@cp949/projectfile`은 `src/index.ts`로 해석한다. `build` 없이 돈다.
- 예제가 설명 없이 쓰는 이름(`entries`, `catBlob` 등)과 `./project-config`는 선언 파일이 채운다. 타입은 `src`를 가리키고 `any`로 채우지 않는다.
- 앞 블록의 import를 이어 쓰는 블록은 스크립트의 `CONTINUATION_SECTIONS` 절에 있고 import 문이 없는 블록이다. 그 블록에만 `decodeProjectFile`, `encodeProjectFile`, `ProjectFileRules` import를 블록 끝에 붙인다.
- 첫 줄이 `// encode.worker.ts` 같은 파일명 주석인 블록은 그 이름의 모듈이 된다. 다른 블록이 `./encode.worker`로 import할 수 있다.
- 목록 안의 들여쓴 펜스와 `~~~` 펜스도 블록으로 본다.
- `ts` 블록이 0개면 실패한다. `typescript`, `tsx`, `mts`, `cts`와 대소문자만 다른 `ts`(`TS` 등) 표기도 실패한다. 검사에서 조용히 빠지지 않게 하기 위해서다.
- 예제를 실행하지 않는다. 타입만 본다.
- Worker 블록(`encode.worker.ts`)도 `DOM` lib으로 검사한다. `DOM`과 `WebWorker`의 전역 타입 차이(예: `self.postMessage`의 인자)는 잡지 않는다.

규칙:

- 스크립트는 README 경로를 인자로 받는다. 사본으로 실패를 확인할 때 쓴다.
- 예제에 설명 없이 쓰는 이름이 생기면 선언 파일에 더한다. 블록이 import하는 이름은 전역으로 열지 않는다. import를 빠뜨린 예제가 통과하기 때문이다.
- 이어 쓰는 블록을 다른 절에 더하거나 절 제목을 바꾸면 `CONTINUATION_SECTIONS`를 고친다. 고치지 않으면 그 블록이 이름을 찾지 못해 실패한다.
