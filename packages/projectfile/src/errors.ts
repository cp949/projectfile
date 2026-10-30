// 프로젝트 파일 코덱의 거부 이유. 호출자가 `reason`으로 안내를 고른다.
// - 열 수 없는 파일은 던지지 않고 결과로 돌려준다. 사용자가 고른 파일이 틀릴 수 있다.
import type { ProjectFileLimits } from "./limits";

/**
 * 이름 규칙을 어긴 이유.
 * - 코덱이 직접 판정하는 값: `empty`, `invalid-char`, `duplicate`, `path-too-long`.
 * - 호출자의 `checkSegment`가 돌려주는 값: 나머지 전부와 앞의 네 값도 쓸 수 있다.
 */
export type ProjectNameCause =
  | "empty"
  | "too-long"
  | "invalid-char"
  | "invalid-extension"
  | "invalid-asset-extension"
  | "duplicate"
  | "folder-dot"
  | "path-too-long";

/** 거부 이유와 그 이유가 가진 정보. */
export type ProjectFileFailure =
  /** `Blob`을 읽지 못했다. 예: 디스크의 원본이 바뀌었거나 지워졌다. */
  | {
      reason: "read-failed";

      /** 인코딩이 읽지 못한 asset의 경로. 디코딩은 입력 파일 하나를 읽으므로 없다. */
      path?: string;
    }

  /** 앞 4바이트가 `OCOD`가 아니다. 이 포맷의 파일이 아니다. */
  | { reason: "bad-magic" }

  /** 헤더의 포맷 버전을 모른다. */
  | { reason: "unsupported-version"; version: number }

  /** 헤더의 kind 길이나 문자열이 kind 규칙을 어겼다. 기대한 kind와 비교하기 전에 걸린다. */
  | { reason: "kind-invalid" }

  /** 헤더의 kind는 규칙을 지켰지만 호출자가 기대한 kind와 다르다. */
  | { reason: "kind-mismatch" }

  /** 헤더가 말하는 payload 길이와 실제 길이가 다르다. 잘렸거나 뒤에 덧붙었다. */
  | { reason: "length-mismatch" }

  /** 헤더의 키 확인값과 같은 키가 호출자가 준 키 가운데 없다. */
  | { reason: "scramble-key-mismatch" }

  /** 메타데이터 범위를 되돌린 CRC32가 헤더 값과 다르다. */
  | { reason: "crc-mismatch" }

  /** ZIP을 읽을 수 없거나 항목 수가 `maxFiles + maxFolders + 2`를 넘거나 항목 내용이 선언과 다르다. asset 항목이 저장(방식 0)이 아닌 경우도 여기다. */
  | { reason: "zip-corrupt" }

  /** `manifest.json`이 크기 상한을 넘거나 형식이 틀리거나 ZIP 항목과 맞지 않는다. */
  | { reason: "manifest-invalid" }

  /** 헤더의 kind와 manifest의 kind가 다르다. */
  | { reason: "manifest-kind-mismatch" }

  /** 인코딩할 manifest가 크기 상한(`MANIFEST_MAX_BYTES`)을 넘는다. 디코딩은 돌려주지 않는다. */
  | { reason: "manifest-too-large" }

  /** 이름 규칙에 어긋난 항목이다. */
  | {
      reason: "invalid-name";

      /** 문제의 항목 경로. */
      path: string;
      cause: ProjectNameCause;
    }

  /**
   * 디코딩 입력 크기가 `maxProjectFileBytes(limits)`를 넘었다. 읽기 전에 거부한다.
   * 풀기 전 항목의 선언 크기 합계가 `maxUncompressedBytes`를 넘는 경우는 `limit-exceeded`다.
   */
  | {
      reason: "input-too-large";

      /** 넘은 입력 크기 상한(바이트). 그 시점의 `maxProjectFileBytes(limits)`다. */
      maxBytes: number;
    }

  /**
   * 호출자가 넘긴 한도를 넘었다. `limit`에 넘은 한도 이름이 있다.
   * - `maxUncompressedBytes`는 파일 내용 합계가 그 한도를 넘었다는 뜻이다.
   * - 디코딩 입력 크기 상한은 `input-too-large`로 따로 알린다.
   * - 예외: 인코딩 결과가 입력 크기 상한을 넘는 방어 검사도 `maxUncompressedBytes`로 알린다.
   */
  | { reason: "limit-exceeded"; limit: keyof ProjectFileLimits };

/** 성공하면 `value`, 아니면 `failure`다. */
export type ProjectFileResult<T> =
  | { ok: true; value: T }
  | { ok: false; failure: ProjectFileFailure };

/** 실패 결과를 만든다. */
export function fail(failure: ProjectFileFailure): {
  ok: false;
  failure: ProjectFileFailure;
} {
  return { ok: false, failure };
}
