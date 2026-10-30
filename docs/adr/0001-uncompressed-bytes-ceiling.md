# 풀린 크기의 절대 상한을 256 MiB로 둔다

라이브러리가 `maxUncompressedBytes`의 절대 상한 `MAX_UNCOMPRESSED_BYTES_CEILING`을 256 MiB(268,435,456바이트)로 강제한다.
넘는 한도는 호출자 버그라서 `encodeProjectFile`, `decodeProjectFile`, `maxProjectFileBytes`가 던진다.
풀린 크기가 정확히 이 값인 프로젝트가 측정한 모든 시나리오에서 Node와 Chrome 모두 인코딩, 디코딩, 내용 대조까지 성공했다.
시나리오는 asset 위주 구성과 텍스트 위주 구성을 나눈다. 재지 않은 입력 구성은 "메모리 측정 방법과 놓치는 범위"에 있다.

## 이유

- 한도는 호출자가 넘긴다. 상한이 없으면 호출자가 잘못 넘긴 큰 값이 입력 크기 상한(`maxProjectFileBytes`)과 해제 메모리를 함께 키운다.
- 상한은 포맷 계약이 아니다. 올려도 포맷 버전은 바뀌지 않는다.
- 올린 버전이 만든 파일을 옛 버전이 `input-too-large`나 `limit-exceeded`로 거부할 수 있다.
- 포맷의 길이 필드는 uint32이고 ZIP64를 쓰지 않는다. 입력 크기 상한이 uint32 안에 들어야 한다(`docs/format.md` "입력 크기 상한").

## 버린 대안

- 상한 없음: 위 이유로 버렸다.
- 256 MiB보다 낮은 상한: 측정한 시나리오가 모두 256 MiB에서 성공해서 낮출 근거가 없다.
- 256 MiB보다 높은 상한: 재지 않은 값은 약속하지 않는다.
  - 올릴 때는 측정 입력 크기도 함께 올려 다시 잰다.
  - `docs/format.md` "한도"에 따라 uint32 검토도 다시 한다.

## 측정

명령:

```sh
pnpm build
pnpm --filter @cp949/projectfile measure:ceiling
```

- 시나리오 이름을 인자로 주면 그 시나리오만 돈다. 이름이 없으면 모두 돈다.
- 코드는 `packages/projectfile/scripts/measure-ceiling/`에 있다.
- `pnpm test`와 `pnpm verify`에 들어가지 않는다.
- Linux에서만 동작한다. Node와 Chrome 모두 `/proc`에서 메모리를 읽는다.
- 종료 코드:
  - 0: 모든 시나리오가 두 환경에서 성공했다.
  - 1: 하나라도 실패했다(예외, 메모리 부족, 내용 불일치). 이유와 실패한 단계를 출력한다.
  - 2: 준비 오류다(`dist` 없음, 측정 크기와 상한 불일치, 알 수 없는 시나리오 이름).

입력:

- 난수와 시각 없이 고정 시드로 만든다. 같은 입력이 매번 나온다.
- 풀린 크기 합계는 시나리오마다 268,435,456바이트다.
- 코드 텍스트는 `.js` 64개이고 256 KiB씩 합계 16 MiB다. 인코더가 deflate한다.
- asset은 인코더가 늘 저장(method 0)한다. asset 본문은 PRNG 바이트다.
- 한도는 입력이 통과하는 최소 범위다. 코드가 아닌 텍스트는 asset 한도로 센다(`docs/format.md` "한도").
- 규칙은 `maxPathLength`가 가장 긴 경로 길이이고, 경로가 `.js`로 끝나면 코드다.

시나리오:

| 이름                 | 구성                                                            | asset 입력   | 디코딩 입력  | 인코딩 입력 참조 |
| -------------------- | --------------------------------------------------------------- | ------------ | ------------ | ---------------- |
| `asset-blob`         | 코드 16 MiB, asset 240 MiB(64 MiB 3개, 1 MiB 48개)              | `Blob`       | `Blob`       | 대조 전까지 쥔다 |
| `asset-bytes-encode` | `asset-blob`과 같다                                             | `Uint8Array` | `Blob`       | 대조 전까지 쥔다 |
| `asset-bytes-decode` | `asset-blob`과 같다                                             | `Blob`       | `Uint8Array` | 인코딩 뒤 놓는다 |
| `asset-bytes-all`    | `asset-blob`과 같다                                             | `Uint8Array` | `Uint8Array` | 대조 전까지 쥔다 |
| `text-heavy`         | 코드 아닌 텍스트 224 MiB(8 MiB 28개), 코드 16 MiB, asset 16 MiB | `Blob`       | `Blob`       | 대조 전까지 쥔다 |

- 디코딩 입력이 `Uint8Array`이면 인코딩 출력 `Blob`을 `Uint8Array`로 바꾼 뒤 디코딩한다. 변환 시간은 재지 않는다.
- `asset-bytes-decode`만 인코딩 직후 인코딩 입력 항목의 참조를 놓는다. 이유는 "Chrome Blob 저장 한계"에 있다.
- 입력을 쥔 채 `Uint8Array`로 디코딩하는 변형은 측정 명령에 넣지 않는다.

절차:

1. 인코딩한다.
2. 디코딩한다. 입력 형태는 시나리오를 따른다.
3. 모든 항목의 경로와 종류, 텍스트 전체, asset 바이트 전체를 입력과 대조한다.

시간은 1, 2번만 잰다. 대조 시간은 포함하지 않는다.

환경:

| 항목   | 값                                                           |
| ------ | ------------------------------------------------------------ |
| OS     | Linux 6.6.114.1-microsoft-standard-WSL2 (x64)                |
| CPU    | Intel Core i9-14900KF, 논리 코어 12개                        |
| RAM    | 32 GiB                                                       |
| Node   | v24.20.0                                                     |
| Chrome | Chrome for Testing 156.0.8078.4, 헤드리스, Playwright가 구동 |

결과:

- 메모리는 RSS다. Chrome은 PSS를 함께 적는다.
- "대조 전까지"는 입력 생성, 인코딩, 변환, 디코딩 단계 최고점의 최댓값이다.
- "대조 포함"은 대조 단계까지의 최고점이다.
- 시간 열과 메모리 열은 다른 실행에서 잰 값이다. 시간 열은 현재 CRC32 계산으로 잰 값이다. 메모리 열은 현재 코드로 다시 재지 않았다.

| 시나리오             | 환경   | 인코딩 | 디코딩 | 최고점, 대조 전까지            | 최고점, 대조 포함              |
| -------------------- | ------ | ------ | ------ | ------------------------------ | ------------------------------ |
| `asset-blob`         | Node   | 0.62 s | 0.10 s | 469.0 MiB                      | 545.3 MiB                      |
| `asset-blob`         | Chrome | 0.85 s | 0.14 s | RSS 1452.1 MiB, PSS 874.0 MiB  | RSS 1507.9 MiB, PSS 929.2 MiB  |
| `asset-bytes-encode` | Node   | 0.62 s | 0.12 s | 694.3 MiB                      | 788.6 MiB                      |
| `asset-bytes-encode` | Chrome | 0.61 s | 0.21 s | RSS 1639.5 MiB, PSS 1051.5 MiB | RSS 1983.6 MiB, PSS 1395.4 MiB |
| `asset-bytes-decode` | Node   | 0.62 s | 0.13 s | 888.7 MiB                      | 963.1 MiB                      |
| `asset-bytes-decode` | Chrome | 0.85 s | 0.25 s | RSS 1541.9 MiB, PSS 951.0 MiB  | RSS 1960.3 MiB, PSS 1371.2 MiB |
| `asset-bytes-all`    | Node   | 0.60 s | 0.16 s | 1134.1 MiB                     | 1134.1 MiB                     |
| `asset-bytes-all`    | Chrome | 0.61 s | 0.25 s | RSS 1765.2 MiB, PSS 1176.7 MiB | RSS 2210.8 MiB, PSS 1626.7 MiB |
| `text-heavy`         | Node   | 5.52 s | 1.16 s | 1154.8 MiB                     | 1875.4 MiB                     |
| `text-heavy`         | Chrome | 5.42 s | 1.79 s | RSS 2215.7 MiB, PSS 1630.6 MiB | RSS 2215.7 MiB, PSS 1630.6 MiB |

- 인코딩 출력은 asset 위주 시나리오에서 253,944,384바이트(242.2 MiB)다. 텍스트 위주는 50,257,911바이트(47.9 MiB)다.
- 모든 시나리오에서 두 환경의 내용 대조가 일치했다. 합격이다.
- asset 위주에서 `Blob` 입력 디코딩은 Node 0.10~0.12 s, Chrome 0.14~0.21 s다.
  - 디코딩이 asset 본문을 읽지 않고 입력의 범위를 `slice`만 하기 때문에 asset 240 MiB와 거의 무관한 시간이다.
  - 시간은 ZIP 디렉터리 읽기와 코드 텍스트 inflate에서 나온다고 본다. 구간별로 나눠 재지 않은 추정이다.
- asset 위주에서 `Uint8Array` 입력 디코딩은 Node 0.13~0.16 s, Chrome 0.25 s다. asset 범위를 `new Blob`으로 복사하는 시간이 들어 있다.
- 텍스트 위주의 인코딩과 디코딩 시간은 asset 위주보다 길다. 구간별 시간은 "텍스트 위주 시간 구간"에 있다.
- 같은 asset 위주 구성에서 `Uint8Array`를 쓰는 시나리오의 최고점이 `Blob`만 쓰는 `asset-blob`보다 크다. Node 대조 전까지 기준으로 `asset-blob` 469.0 MiB, `asset-bytes-all` 1134.1 MiB다.

## Chrome Blob 저장 한계

사실. 측정 조건은 이 PC, Chrome for Testing 156.0.8078.4, Playwright가 구동한 기본 컨텍스트다:

- 살아 있는 `Blob` 총량이 약 500 MiB를 넘으면, 그 뒤에 만든 `Blob`을 읽을 때 `NotReadableError`가 난다. 먼저 만든 `Blob`은 계속 읽힌다.
  - 4 MiB `Blob`을 쌓았을 때 누적 496 MiB까지는 모두 읽혔다.
  - 누적 500~504 MiB 구간에서 만든 `Blob`부터 읽기가 실패했다.
  - 경계는 4 MiB 단위로만 좁혔다.
- 라이브러리 없이 1 MiB 난수 조각을 이어 붙인 `Blob`만으로 같은 경계가 재현된다.
- 임시 프로필을 쓰는 persistent context에서도 같은 경계였다. 이 프로필에는 `blob_storage` 디렉터리가 생기지 않았다.
- Chromium의 blob 저장 문서(`storage/browser/blob/README.md`)는 64비트 데스크톱의 메모리 한도를 2 GB로 적고, 넘으면 디스크로 옮긴다고 한다.
  - 관측한 경계와 맞지 않는다. 이유는 확인하지 못했다.
  - 문서만 읽었고 Chromium 코드는 읽지 않았다.
- 인코딩 입력 asset `Blob`을 쥔 채 `Uint8Array`로 디코딩하면 `NotReadableError`로 실패했다.
  - 실패 위치는 대조 단계에서 첫 asset의 21번째 MiB였다.
  - 입력 참조를 쥔 경우 3회 모두 실패했다(기본 컨텍스트 2회, persistent context 1회).
  - 입력 참조를 놓은 경우 기본 컨텍스트에서 5회 모두 통과했다.
- `asset-blob`은 기본 컨텍스트에서 4회 모두 통과했다.

추정. 직접 재지 않았다:

- 입력을 쥔 채 `Uint8Array`로 디코딩할 때 살아 있는 `Blob` 총량은 약 722 MiB다.
  - 입력 asset 240 MiB, 인코딩 출력 242.2 MiB, 디코딩이 복사한 asset 240 MiB를 더한 값이다.
  - 인코딩 출력은 참조를 놓아도 가비지 수집 전까지 남는다고 가정한다.
- `asset-blob`의 살아 있는 `Blob` 총량은 약 482 MiB다.
  - 입력 asset 240 MiB와 인코딩 출력 242.2 MiB를 더한 값이다. `Blob` 입력 디코딩은 `slice`라서 복사가 없다고 가정한다.
  - 관측한 경계와 약 18 MiB 차이라서 여유가 작다.
- 경계는 기기, Chrome 빌드, 실행 옵션에 따라 다를 수 있다. 이유를 확인하지 못했기 때문이다.

이 한계에도 256 MiB를 유지하는 이유:

- 실패는 상한 값보다 호출자가 쥔 `Blob` 총량에 달려 있다. 입력 asset `Blob`과 디코딩 결과를 합친 양을 줄이는 것은 호출자 책임이다.
- 사용자가 고른 파일에서 온 `File`과 `Blob`은 디스크 파일을 가리키므로 이 메모리 한계에 덜 걸릴 것으로 본다. 확인하지 않은 추정이다.
- 상한을 올리면 `asset-blob`이 먼저 한계에 닿을 수 있다. 올릴 때는 이 절의 총량 추정을 다시 잰다.

## 메모리 측정 방법과 놓치는 범위

Node:

- 측정을 별도 프로세스로 돌린다. 커널이 기록하는 최고 상주 메모리(`/proc/self/status`의 `VmHWM`)를 단계 끝마다 읽는다. 표본 주기가 없어 짧은 급등도 잡는다.
- 값은 프로세스 시작부터의 누적 최고점이다. 단계별 증가분은 나눌 수 없다.
- 최고점에는 측정 코드의 입력 생성(256 MiB)과 대조용 임시 버퍼가 든다. 라이브러리만의 값이 아니다.
- 작업 시작 직전(`dist`를 불러오고 입력 구성표를 만든 뒤, 입력 생성 전)까지의 누적 최고점은 55.4 MiB다.

Chrome:

- 브라우저 프로세스 트리(브라우저, 렌더러, GPU, 유틸리티) 전체의 RSS와 PSS를 50 ms 주기로 합산해 단계별 최고값을 잡는다.
- 50 ms 사이의 급등은 놓친다.
- RSS 합계는 프로세스 사이 공유 페이지를 중복해서 더한다. 실제 사용량보다 크다. PSS는 공유 페이지를 나눠서 더한다.
- 단계는 `browser`, `page`, 작업 단계 순서다.
  - `browser`는 브라우저 시작부터 페이지를 열기 전까지다. `asset-blob` 실행에서 RSS 496.1 MiB, PSS 199.9 MiB다.
  - `page`는 페이지를 열고 모듈을 불러온 구간이다. 같은 실행에서 RSS 907.0 MiB, PSS 337.6 MiB다.
- 시나리오를 바꿔 다시 띄운 브라우저의 `browser`, `page` 값은 10 MiB 안쪽으로 달랐다.
- `Blob` 데이터가 디스크 파일로 옮겨지면 RSS와 PSS에 잡히지 않는다. 위 측정에서 옮겨졌는지는 확인하지 못했다. "Chrome Blob 저장 한계"의 persistent context 관측에서는 옮긴 흔적이 없었다.

공통:

- 같은 시나리오를 다시 실행하면 최고점이 달라진다. `asset-blob`의 Node 대조 포함 최고점은 여러 번 실행에서 최대 약 20 MiB 차이가 났다.
- RAM 32 GiB인 PC에서만 쟀다. 메모리가 작은 기기에서의 동작은 확인하지 않았다.
- 재지 않은 입력 구성:
  - 텍스트 위주 구성에서 `Uint8Array` 입력 디코딩과 `Uint8Array` asset 인코딩.
  - 압축률이 다른 텍스트. 측정 텍스트는 낱말 19개를 섞은 것이라 압축이 잘 된다. 인코딩 출력 47.9 MiB에서 asset 16 MiB를 빼면 텍스트 240 MiB가 약 32 MiB가 됐다.
  - 항목 수가 한도에 가까운 프로젝트.
  - scramble 키를 쓰는 경우.
- Chrome 75 같은 옛 브라우저, Firefox, Safari, Windows, macOS는 재지 않았다.

## 텍스트 위주 시간 구간

사실. `text-heavy` 시나리오의 인코딩과 디코딩 시간을 구간으로 나눠 쟀다.

명령:

```sh
pnpm build
pnpm --filter @cp949/projectfile measure:sections
```

- 코드는 `packages/projectfile/scripts/measure-ceiling/`의 `sections.mjs`와 `sections-run.mjs`에 있다.
- `pnpm test`와 `pnpm verify`에 들어가지 않는다.
- 반복 횟수를 인자로 줄 수 있다. 기본은 워밍업 1회에 이어 5회다. 표의 시간은 워밍업을 뺀 회차의 중앙값이다.
- 환경은 "측정"의 환경 표와 같다. Node와 Chrome 모두 같은 코드를 돌린다.

방법:

- 입력은 `text-heavy`와 같다. 텍스트 UTF-8 바이트 합계는 251,658,240바이트(240.0 MiB)다.
- 구간은 라이브러리가 항목마다 부르는 호출을 같은 인자로 따로 돈다. 구간 시간은 `performance.now`로 잰다.
- 인코딩 구간:
  - UTF-8 변환: 입력 문자열을 `TextEncoder.encode`로 바이트로 바꾼다.
  - CRC32: `src/crc32.ts`의 `crc32`로 텍스트 바이트를 계산한다.
  - deflate: fflate `deflateSync`를 기본 수준으로 항목마다 한 번에 돈다. 텍스트 deflate 바이트 합계는 33,467,280바이트(31.9 MiB)다.
- 디코딩 구간:
  - inflate: 인코딩 구간의 deflate 결과를 fflate `Inflate`에 16 KiB씩 밀어 선언 크기 버퍼에 푼다.
  - CRC32: 풀린 바이트를 계산한다.
  - UTF-8 변환: `TextDecoder`(`fatal`, `ignoreBOM`)로 문자열로 바꾼다.
- 전체는 `encodeProjectFile`과 `decodeProjectFile`을 부른 시간이다. 디코딩 입력은 인코딩 출력 `Blob`이다.
- 구간과 전체는 같은 회차 안에서 따로 돈다. 같은 호출을 두 번 하는 셈이라 회차 간 변동이 각각 들어간다.
- 전체 대비는 구간 중앙값을 전체 중앙값으로 나눈 값이다. 구간 비율의 합은 100%와 다를 수 있다.
- `crc32`는 `src/crc32.ts`의 타입을 지운 코드다. 측정 전에 `node:zlib`의 CRC32와 같은 값을 내는지 대조한다.
- 구간 코드가 만든 텍스트와 라이브러리가 디코딩한 텍스트는 입력과 문자열 전체가 같은지 워밍업에서 대조한다.

인코딩:

| 구간       | 환경   | 중앙값 (s) | 전체 대비 |
| ---------- | ------ | ---------- | --------- |
| UTF-8 변환 | Node   | 0.305      | 6.9%      |
| CRC32      | Node   | 0.152      | 3.4%      |
| deflate    | Node   | 3.946      | 89.4%     |
| 전체       | Node   | 4.414      | 100%      |
| UTF-8 변환 | Chrome | 0.504      | 10.4%     |
| CRC32      | Chrome | 0.158      | 3.3%      |
| deflate    | Chrome | 4.096      | 84.8%     |
| 전체       | Chrome | 4.832      | 100%      |

디코딩:

| 구간       | 환경   | 중앙값 (s) | 전체 대비 |
| ---------- | ------ | ---------- | --------- |
| inflate    | Node   | 0.734      | 67.7%     |
| CRC32      | Node   | 0.158      | 14.5%     |
| UTF-8 변환 | Node   | 0.175      | 16.1%     |
| 전체       | Node   | 1.085      | 100%      |
| inflate    | Chrome | 1.055      | 64.4%     |
| CRC32      | Chrome | 0.155      | 9.5%      |
| UTF-8 변환 | Chrome | 0.371      | 22.6%     |
| 전체       | Chrome | 1.639      | 100%      |

사실:

- 세 구간 합은 전체의 약 97~100%다.
- 세 구간 밖의 시간(ZIP 조립, manifest, scramble, `Blob` 생성과 읽기, 한도 검사)은 회차 간 변동보다 작아서 따로 값을 내지 않는다.
  - 전체에서 세 구간 합을 빼면 Node 인코딩에서는 음수가 나오는 회차가 있다.
  - deflate의 회차 간 변동이 그 차이보다 크기 때문이다.
- 인코딩에서 deflate가 전체의 Node 89.4%, Chrome 84.8%다. 240.0 MiB 텍스트를 Node 3.946 s, Chrome 4.096 s에 deflate했다.
- 디코딩에서 inflate가 전체의 Node 67.7%, Chrome 64.4%다.
- CRC32는 인코딩과 디코딩 모두 두 환경에서 0.15~0.16 s다.
- UTF-8 변환은 Chrome이 Node보다 길다. 인코딩 0.504 s 대 0.305 s, 디코딩 0.371 s 대 0.175 s다.
- 인코딩 전체에 든 asset `Blob`(16 MiB) 읽기와 CRC32는 Node 0.020 s, Chrome 0.025 s다.
- "측정"의 `text-heavy` 시간(Node 5.52 s와 1.16 s, Chrome 5.42 s와 1.79 s)은 이 절의 전체 중앙값보다 길다.
  - "측정"은 시나리오마다 새 프로세스에서 워밍업 없이 한 번 잰 값이다. 같은 실행에서 메모리도 잰다.
  - 차이의 원인은 확인하지 않았다.
- Node의 UTF-8 변환은 워밍업 뒤 처음 두 회차가 이후 회차보다 길다. 중앙값은 이후 회차에서 나온다. 원인은 확인하지 않았다.

해석:

- 이 측정 텍스트와 fflate 기본 수준에서 텍스트 위주 인코딩 시간의 대부분은 deflate라고 본다. 근거는 deflate가 전체의 84.8~89.4%인 위 표다.
- 같은 조건에서 텍스트 위주 디코딩 시간의 가장 큰 몫은 inflate라고 본다. 근거는 inflate가 전체의 64.4~67.7%인 위 표다.
- 압축률이 다른 텍스트나 다른 deflate 수준에서도 같은 비율인지는 알 수 없다. 아래 "재지 않은 것"에 있다.

재지 않은 것:

- fflate 기본 수준 외의 deflate 수준. 시간과 압축 크기 모두 재지 않았다.
- 압축률이 다른 텍스트. 측정 텍스트는 낱말 19개를 섞은 것이라 압축이 잘 된다("메모리 측정 방법과 놓치는 범위").
- `Uint8Array` 입력 디코딩, scramble 키를 쓰는 경우, 세 구간 밖 시간의 세부.
- 이 PC 한 대. 다른 기기에서의 시간은 확인하지 않았다.
