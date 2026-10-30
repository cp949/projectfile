// 프로젝트 파일 한도. 호출자가 모든 항목을 넘긴다. 코덱은 기본값을 두지 않는다.
// - 인코딩과 디코딩이 같은 한도로 검사한다. 만든 파일을 같은 한도로 못 여는 일이 없다.
// - 코드와 asset의 구분은 호출자의 `isCode`가 정한다(`rules.ts`).
// - 규칙은 `docs/format.md`의 "한도"에 있다.
import { MAX_HEADER_BYTES } from "./header";
import { FILES_DIR, MANIFEST_MAX_BYTES } from "./manifest";
import { CENTRAL_BYTES, EOCD_BYTES, LOCAL_BYTES } from "./zip-layout";

/** 프로젝트 파일 한도. */
export interface ProjectFileLimits {
  /** 파일(텍스트와 asset) 개수. 폴더는 세지 않는다. */
  maxFiles: number;

  /** 폴더 개수. 경로로만 생기는 조상 폴더도 센다. 입력 크기 상한의 항목 수를 묶는다. */
  maxFolders: number;

  /** asset 하나의 바이트. `isCode`가 거짓인 텍스트 파일도 하나로 센다. */
  maxAssetBytes: number;

  /** 모든 asset의 바이트 합. `isCode`가 거짓인 텍스트 파일도 더한다. */
  maxAssetsTotalBytes: number;

  /** `isCode`가 참인 텍스트의 UTF-8 바이트 합. */
  maxCodeBytes: number;

  /** 압축을 풀었을 때 모든 파일의 바이트 합. 풀기 전에 ZIP 헤더의 값으로 검사한다. */
  maxUncompressedBytes: number;
}

/** 한도 항목 이름. 검사와 오류 문구가 쓴다. */
const LIMIT_KEYS = [
  "maxFiles",
  "maxFolders",
  "maxAssetBytes",
  "maxAssetsTotalBytes",
  "maxCodeBytes",
  "maxUncompressedBytes",
] as const satisfies readonly (keyof ProjectFileLimits)[];

/**
 * `maxUncompressedBytes`의 절대 상한(256 MiB). 넘는 한도는 호출자 버그라서 인코딩과 디코딩이 던진다.
 * - 입력 크기 상한(`maxProjectFileBytes`)과 해제 메모리가 이 값으로 묶인다.
 * - 올려도 포맷은 바뀌지 않는다. 다만 올린 버전이 만든 파일을 옛 버전이 `input-too-large`나 `limit-exceeded`로 거부할 수 있다.
 */
export const MAX_UNCOMPRESSED_BYTES_CEILING: number = 256 * 1024 * 1024;

/** ZIP 끝 레코드가 적을 수 있는 최대 항목 수. 항목 수는 uint16이다. ZIP64는 쓰지 않는다. */
export const MAX_ZIP_ENTRIES = 0xffff;

/**
 * 한도 안의 프로젝트를 인코딩한 ZIP의 최대 항목 수. `manifest.json`, `files/` 폴더 항목, 폴더, 파일이다.
 * 디코딩은 끝 레코드의 항목 수가 이 값을 넘으면 로컬 헤더를 읽지 않고 거부한다.
 */
export function maxZipEntries(limits: ProjectFileLimits): number {
  return limits.maxFiles + limits.maxFolders + 2;
}

/**
 * 한도가 잘못되면 던진다. 호출자 버그다.
 * - 항목은 0 이상의 정수여야 한다. NaN이나 음수는 검사를 조용히 무력화한다.
 * - `maxUncompressedBytes`는 `MAX_UNCOMPRESSED_BYTES_CEILING` 이하여야 한다.
 * - `maxFiles` + `maxFolders` + 2(`manifest.json`, `files/` 폴더 항목)는 `MAX_ZIP_ENTRIES` 이하여야 한다.
 *   넘으면 ZIP 항목 수가 넘쳐 인코딩이 던지거나 열 수 없는 파일을 만든다.
 */
export function assertLimits(limits: ProjectFileLimits): void {
  for (const key of LIMIT_KEYS) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 0) {
      throw new RangeError(`${key}는 0 이상의 정수여야 한다: ${limits[key]}`);
    }
  }
  if (limits.maxUncompressedBytes > MAX_UNCOMPRESSED_BYTES_CEILING) {
    throw new RangeError(
      `maxUncompressedBytes는 ${MAX_UNCOMPRESSED_BYTES_CEILING} 이하여야 한다: ${limits.maxUncompressedBytes}`,
    );
  }
  if (maxZipEntries(limits) > MAX_ZIP_ENTRIES) {
    throw new RangeError(
      `maxFiles + maxFolders + 2는 ${MAX_ZIP_ENTRIES} 이하여야 한다: ${maxZipEntries(limits)}`,
    );
  }
}

/** `rules.maxPathLength`의 상한(UTF-16 코드 유닛). 입력 크기 상한이 이 값으로 이름 길이를 잡는다. */
export const MAX_PATH_LENGTH_CEILING = 1024;

/**
 * ZIP 항목 이름의 최대 UTF-8 바이트. `files/`, 경로, 폴더 끝 `/`다. UTF-16 코드 유닛 하나는 3바이트 이하다.
 * 경로 길이는 `MAX_PATH_LENGTH_CEILING`다. `rules.maxPathLength`는 이 값 이하여야 상한이 성립한다.
 */
const MAX_ENTRY_NAME_BYTES =
  FILES_DIR.length + 1 + 3 * MAX_PATH_LENGTH_CEILING + 1;

/**
 * 읽기 전에 받는 입력 크기 상한. 한도 안의 항목을 인코딩한 파일은 이 크기를 넘지 않는다.
 * - 데이터: 파일 내용 합계(`maxUncompressedBytes`)와 manifest 상한이다.
 * - deflate 여유: 항목마다 10바이트, 데이터 7,000바이트마다 5바이트다.
 *   fflate 0.8.3이 항목마다 잡는 출력 버퍼 `n + 5 * (1 + ceil(n / 7000))`에서 나온다.
 * - 항목마다 지역 헤더 30바이트, 중앙 디렉터리 46바이트, 이름 두 번이다.
 * - 항목 수는 `maxFiles` + `maxFolders` + 2(`manifest.json`, `files/` 폴더 항목)다.
 * - 헤더와 ZIP 끝 레코드 22바이트를 더한다. 헤더는 최대 길이(`MAX_HEADER_BYTES`)로 잡는다.
 * - 한도가 잘못되면 인코딩·디코딩과 같이 던진다. 서버 크기 검사처럼 디코딩 없이 쓸 때 NaN이 비교를 통과시키지 않게 한다.
 */
export function maxProjectFileBytes(limits: ProjectFileLimits): number {
  assertLimits(limits);
  const data = limits.maxUncompressedBytes + MANIFEST_MAX_BYTES;
  const perEntry = LOCAL_BYTES + CENTRAL_BYTES + 2 * MAX_ENTRY_NAME_BYTES + 10;
  const entries = maxZipEntries(limits);
  return (
    MAX_HEADER_BYTES +
    EOCD_BYTES +
    data +
    Math.ceil((5 * data) / 7000) +
    entries * perEntry
  );
}
