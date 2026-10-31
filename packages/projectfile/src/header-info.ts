// 헤더만 읽는 공개 함수와, 디코딩과 공유하는 헤더 읽기.
// - 서버는 키가 없다. 키 없이 magic, 버전, kind 형식, 전체 길이까지만 본다. CRC와 payload는 보지 않는다.
// - `Blob` 입력은 앞 `MAX_HEADER_BYTES`바이트만 읽는다.
// - 디코딩의 헤더 단계와 같은 `readHead`를 쓴다. 두 함수의 실패 이유가 어긋나지 않게 한다.
// - 규칙은 `docs/format.md`의 "헤더"와 "검사 순서"에 있다.
import { fail, type ProjectFileResult } from "./errors";
import {
  MAX_HEADER_BYTES,
  readHeader,
  type ProjectFileHeader,
  type ProjectKind,
} from "./header";
import { createRangeSource, type RangeSource } from "./read-range";

/** `readProjectFileHeader`가 돌려주는 헤더 정보. */
export interface ProjectFileHeaderInfo {
  /** 포맷 버전. 1(메타데이터 범위만 scramble)이나 2(ZIP 전체 scramble)다. */
  version: number;

  /** 헤더의 kind 문자열. 규칙은 `ProjectKind`다. */
  kind: ProjectKind;

  /** payload(ZIP 전체) 길이(바이트). */
  payloadLength: number;

  /** 헤더 길이(바이트). 22 + kind 길이. payload가 시작하는 위치다. */
  headerBytes: number;

  /** 봉인한 scramble 키의 CRC32. */
  keyCheck: number;
}

/**
 * 입력 앞부분을 읽고 헤더를 검사한다. 디코딩 1단계의 헤더 읽기와 2~5단계다.
 * - 앞 `MAX_HEADER_BYTES`바이트(입력이 짧으면 전체)만 읽는다. 읽지 못하면 `read-failed`다.
 * - kind가 규칙을 어기면 `kind-invalid`다. `expectedKind`를 주면 규칙을 지킨 kind가 다를 때 `kind-mismatch`다.
 */
export async function readHead(
  source: RangeSource,
  inputBytes: number,
  expectedKind?: ProjectKind,
): Promise<ProjectFileResult<ProjectFileHeader>> {
  let head: Uint8Array;
  try {
    [head] = (await source.read([
      { start: 0, end: Math.min(inputBytes, MAX_HEADER_BYTES) },
    ])) as [Uint8Array];
  } catch {
    return fail({ reason: "read-failed" });
  }
  return readHeader(head, inputBytes, expectedKind);
}

/**
 * 키 없이 헤더만 읽는다. 어떤 입력도 던지지 않고 거부 이유를 돌려준다.
 * - 검사: magic, 헤더 길이, 버전, kind 규칙, 전체 크기(22 + N + payload 길이).
 * - 실패 이유는 `decodeProjectFile`의 해당 단계와 같다: `bad-magic`, `length-mismatch`,
 *   `unsupported-version`, `kind-invalid`, 읽지 못하면 `read-failed`.
 * - 입력 크기 상한(`input-too-large`)과 기대한 kind는 보지 않는다. 한도와 kind는 `decodeProjectFile`의 몫이다.
 * - 통과해도 파일이 열린다는 뜻이 아니다. 키 확인값, CRC, payload는 `decodeProjectFile`이 본다.
 */
export async function readProjectFileHeader(
  input: Blob | Uint8Array,
): Promise<ProjectFileResult<ProjectFileHeaderInfo>> {
  const inputBytes = input instanceof Uint8Array ? input.length : input.size;
  const result = await readHead(createRangeSource(input), inputBytes);
  if (!result.ok) return result;
  const { formatVersion, kind, payloadLength, headerBytes, keyCheck } =
    result.value;
  return {
    ok: true,
    value: {
      version: formatVersion,
      kind,
      payloadLength,
      headerBytes,
      keyCheck,
    },
  };
}
