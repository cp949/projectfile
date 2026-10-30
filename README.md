# projectfile

`@cp949/projectfile`은 프로젝트 파일의 인코더와 디코더다. 항목 목록(경로, 종류, 내용)을 `Blob` 하나로 만들고, 그 `Blob`을 항목 목록으로 되돌린다. 브라우저와 Node에서 돈다.

ZIP 메타데이터와 `manifest.json` 본문을 섞는(scramble) 목적은 인라인 보안 검사 장비의 오탐을 피하는 것이다. 기밀성과 변조 방지를 약속하지 않는다.

- 사용법: [packages/projectfile/README.md](packages/projectfile/README.md)
- 파일 포맷과 검사 규칙: [docs/format.md](docs/format.md)
- 기여 방법: [CONTRIBUTING.md](CONTRIBUTING.md)
- 취약점 신고: [SECURITY.md](SECURITY.md)
- 라이선스: [LICENSE](LICENSE) (MIT)

## 저장소 구성

이 저장소는 pnpm + Turborepo 모노레포다.

| 경로                   | 패키지               | 내용                          |
| ---------------------- | -------------------- | ----------------------------- |
| `packages/projectfile` | `@cp949/projectfile` | 프로젝트 파일 인코더와 디코더 |
| `apps/basic`           | `example-basic`      | 기본 scramble 키 사용 예제    |
| `apps/custom-key`      | `example-custom-key` | 사용처 scramble 키 사용 예제  |

`apps/`의 예제는 배포하지 않는다(`private: true`). 실행 방법은 각 예제의 README에 있다.

## 명령

```sh
pnpm install
pnpm build
pnpm test
pnpm --filter @cp949/projectfile test:coverage
pnpm --filter @cp949/projectfile test:browser
pnpm check-types
pnpm check:escompat
pnpm check:license
pnpm check:consume
pnpm check:package
pnpm lint
pnpm format:check
pnpm verify
pnpm --filter @cp949/projectfile measure:ceiling
pnpm --filter @cp949/projectfile measure:sections
```

`test:coverage`는 `src`의 커버리지를 터미널과 `packages/projectfile/coverage/`(HTML)에 낸다. `verify`에는 들어가지 않는다.

`check-types`는 `tsc` 두 번에 이어 `packages/projectfile/scripts/check-readme.mjs`를 실행한다. 패키지 README의 `ts` 코드 블록을 타입 검사한다. 범위는 [docs/agents/extra-checks.md](docs/agents/extra-checks.md)의 "README 예제 검사"에 있다.

`check:escompat`은 `build`가 만든 `dist`가 Chrome 75 문법(ES2019)인지 검사한다. 기준은 [packages/projectfile/README.md](packages/projectfile/README.md)의 "지원 환경"이다.

`check:license`는 루트 `LICENSE`와 `packages/projectfile/LICENSE`가 같은지, `npm pack --dry-run` 파일 목록에 `LICENSE`가 있는지 검사한다. 루트 `LICENSE`가 원본이다. 어긋나면 루트 파일을 패키지 디렉터리로 복사한다.

`check:consume`은 `npm pack` tarball을 임시 디렉터리에 설치하고 패키지 이름으로 import해 왕복 등 최소 검사를 실행한다. 먼저 `pnpm build`가 필요하고 `fflate`를 받으므로 네트워크가 필요하다. tarball 경로를 인자로 주면 pack을 건너뛴다. `verify`에는 들어가지 않고 CI의 `consume` 작업이 Node 버전별로 실행한다. 범위와 이유는 [docs/agents/extra-checks.md](docs/agents/extra-checks.md)의 "소비 검사"에 있다.

`check:package`는 `npm pack` tarball을 publint(`--strict`)와 attw로 검사한다. `exports`, `files`, `types`가 가리키는 파일과 node10, node16, bundler 해석별 타입 선언을 본다. 먼저 `pnpm build`가 필요하다. 네트워크는 필요 없다. tarball 경로를 인자로 주면 pack을 건너뛴다. `verify`에는 들어가지 않고 CI의 `verify` 작업이 `pnpm verify` 뒤에 실행한다. 범위와 이유는 [docs/agents/extra-checks.md](docs/agents/extra-checks.md)의 "패키지 검사"에 있다.

`measure:ceiling`은 풀린 크기 256 MiB 프로젝트를 시나리오별로 Node와 Chrome에서 인코딩·디코딩해 시간과 메모리를 잰다. Linux에서만 동작한다. 먼저 `pnpm build`가 필요하고 Playwright의 Chromium이 설치되어 있어야 한다. 시나리오 이름을 인자로 주면 그 시나리오만 돈다. `verify`에는 들어가지 않는다. 방법과 결과는 [docs/adr/0001-uncompressed-bytes-ceiling.md](docs/adr/0001-uncompressed-bytes-ceiling.md)에 있다.

`measure:sections`는 `text-heavy` 시나리오의 인코딩·디코딩 시간을 UTF-8 변환, CRC32, deflate, inflate 구간으로 나눠 Node와 Chrome에서 잰다. 먼저 `pnpm build`가 필요하고 Playwright의 Chromium이 설치되어 있어야 한다. 반복 횟수(5 이상)를 인자로 줄 수 있다. `verify`에는 들어가지 않는다. 방법과 결과는 같은 ADR의 "텍스트 위주 시간 구간"에 있다.

```sh
pnpm --filter @cp949/projectfile exec playwright-core install chromium
```

`test:browser`는 `Blob` 읽기 경로 시험 두 파일(`tests/decode-read.test.ts`, `tests/roundtrip.test.ts`)과 `packages/projectfile/tests-browser/`의 시험을 Chromium에서 실행한다. 위 명령으로 설치한 Chromium이 필요하다. `verify`에는 들어가지 않고 CI의 `browser` 작업이 실행한다. 범위와 이유는 [docs/agents/extra-checks.md](docs/agents/extra-checks.md)의 "브라우저 시험"에 있다.

`pnpm verify`는 `lint`, `format:check`, `check-types`, `test`, `build`, `check:escompat`, `check:license`를 차례로 실행한다. 하나라도 실패하면 멈춘다.

CI(`.github/workflows/ci.yml`)는 pull request와 `main`·`dev` push에서 세 작업을 병렬로 실행한다. 배포하지 않는다.

- `verify`: `pnpm install --frozen-lockfile`, `pnpm verify`, `pnpm check:package`.
- `browser`: `pnpm install --frozen-lockfile`, Chromium 설치, `test:browser`.
- `consume`: `pnpm install --frozen-lockfile`, `pnpm build`, `npm pack`. 이어서 matrix의 Node 버전별로 바꿔 소비 검사 스크립트만 실행한다.

## 도구

- TypeScript
- Turborepo
- tsdown
- oxlint, oxfmt
- vitest, fast-check(속성 기반 시험)
- changesets

배포 절차는 `docs/release.md`를 따른다.
