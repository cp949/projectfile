// 프로젝트 파일 헤더. scramble하지 않는다. 길이는 22 + kind 길이 N바이트다.
// - 서버는 키가 없다. 헤더만으로 magic, 버전, kind, 길이, 키 확인값을 검사한다. CRC는 열 때 검사한다.
// - kind는 사용처가 정하는 문자열이다. 라이브러리는 kind 목록을 갖지 않고 형식만 검사한다.
// - 규칙은 `docs/format.md`의 "헤더"에 있다.
//
// ```txt
// [0..3]    magic "OCOD"
// [4]       포맷 버전 (1 또는 2)
// [5]       kind 길이 N (1 이상 64 이하)
// [6..9]    payload 길이 (LE uint32). payload는 ZIP 전체다
// [10..13]  CRC32 (LE uint32). scramble 전 평문 기준. 버전 1은 ZIP 메타데이터 범위와 manifest 본문(`metadata-scramble.ts`),
//           버전 2는 ZIP 전체
// [14..17]  centralStart: ZIP 안 중앙 디렉터리 시작 위치 (LE uint32)
// [18..21]  키 확인값: scramble 키 16바이트의 CRC32 (LE uint32)
// [22..21+N] kind 문자열 (ASCII)
// [22+N..]  payload = scramble한 ZIP. 버전 1은 메타데이터 범위와 manifest 본문만, 버전 2는 전체
// ```
import { fail, type ProjectFileResult } from "./errors";

/**
 * 프로젝트 종류. 사용처가 정하는 문자열이다.
 * - 규칙은 정규식 `^[a-z0-9][a-z0-9._-]{0,63}$`다. 대문자를 받지 않는다.
 * - 다른 사용처와 겹치지 않게 `acme.blocks`처럼 앞에 이름을 붙이는 것을 권한다.
 */
export type ProjectKind = string;

/** 포맷 버전 1. ZIP 메타데이터 범위와 manifest 본문만 scramble한다. */
export const FORMAT_VERSION_METADATA = 1;

/** 포맷 버전 2. ZIP 전체를 scramble한다. */
export const FORMAT_VERSION_ALL = 2;

/**
 * scramble하는 범위. 인코딩 옵션이고 헤더의 포맷 버전으로 파일에 남는다.
 * - `"metadata"`: ZIP 메타데이터 범위와 manifest 본문(버전 1).
 * - `"all"`: ZIP 전체(버전 2).
 */
export type ScrambleScope = "metadata" | "all";

/** 범위에 맞는 포맷 버전. */
export function formatVersionOf(scope: ScrambleScope): number {
  return scope === "all" ? FORMAT_VERSION_ALL : FORMAT_VERSION_METADATA;
}

/** kind를 뺀 고정 헤더 길이. */
export const FIXED_HEADER_BYTES: number = 22;

/** kind 문자열의 최대 길이. */
export const MAX_KIND_LENGTH: number = 64;

/** 헤더의 최대 길이. kind가 가장 긴 경우다. */
export const MAX_HEADER_BYTES: number = FIXED_HEADER_BYTES + MAX_KIND_LENGTH;

/** kind 길이가 `kindLength`인 헤더의 길이. 헤더 길이 계산은 여기 한 곳이다. */
export function headerLengthOf(kindLength: number): number {
  return FIXED_HEADER_BYTES + kindLength;
}

const MAGIC = [0x4f, 0x43, 0x4f, 0x44];

const KIND_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** 값이 kind 규칙을 지키는 문자열이면 참이다. */
export function isProjectKind(value: unknown): value is ProjectKind {
  return typeof value === "string" && KIND_PATTERN.test(value);
}

/** 읽어 낸 헤더. magic, 버전, kind, 전체 길이를 검사한 값이다. */
export interface ProjectFileHeader {
  /** 헤더의 kind 문자열. 규칙을 지킨 값 */
  kind: ProjectKind;

  /** payload(ZIP 전체) 길이(바이트) */
  payloadLength: number;

  /** 포맷 버전. 1 또는 2 */
  formatVersion: number;

  /** scramble 전 평문의 CRC32. 범위는 버전을 따른다. */
  crc: number;

  /** ZIP 안 중앙 디렉터리 시작 위치 */
  centralStart: number;

  /** 봉인한 scramble 키의 CRC32 */
  keyCheck: number;

  /** 헤더 길이. 22 + kind 길이. payload가 시작하는 위치다. */
  headerBytes: number;
}

/** 헤더를 만든다. kind는 규칙을 지킨 값이고 `formatVersion`은 1이나 2여야 한다. */
export function writeHeader(
  kind: ProjectKind,
  formatVersion: number,
  payloadLength: number,
  crc: number,
  centralStart: number,
  keyCheck: number,
): Uint8Array {
  const header = new Uint8Array(headerLengthOf(kind.length));
  const view = new DataView(header.buffer);
  header.set(MAGIC, 0);
  header[4] = formatVersion;
  header[5] = kind.length;
  view.setUint32(6, payloadLength, true);
  view.setUint32(10, crc, true);
  view.setUint32(14, centralStart, true);
  view.setUint32(18, keyCheck, true);
  for (let i = 0; i < kind.length; i += 1) {
    header[FIXED_HEADER_BYTES + i] = kind.charCodeAt(i);
  }
  return header;
}

/**
 * 파일 앞부분에서 헤더를 읽고 검사한다. 처음 걸린 이유를 돌려준다.
 * 1. 앞 4바이트가 magic이 아니거나 4바이트가 안 되면 `bad-magic`.
 * 2. 22바이트 미만이면 `length-mismatch`, 1이나 2가 아닌 버전이면 `unsupported-version`.
 * 3. kind 길이가 0이거나 64를 넘으면 `kind-invalid`.
 *    22 + N바이트 미만이면 `length-mismatch`.
 *    kind 문자열이 규칙을 어기면 `kind-invalid`, 규칙을 지켰지만 `expectedKind`와 다르면 `kind-mismatch`.
 * 4. 전체 크기가 22 + N + payload 길이와 다르면 `length-mismatch`.
 *
 * `bytes`는 파일 앞부분이다. 파일이 `MAX_HEADER_BYTES`보다 길면 그만큼만 읽어도 된다.
 * 길이 검사는 `bytes`가 아니라 파일 전체 크기 `fileLength`로 한다.
 */
export function readHeader(
  bytes: Uint8Array,
  fileLength: number,
  expectedKind?: ProjectKind,
): ProjectFileResult<ProjectFileHeader> {
  if (!MAGIC.every((byte, index) => bytes[index] === byte)) {
    return fail({ reason: "bad-magic" });
  }
  if (fileLength < FIXED_HEADER_BYTES) {
    return fail({ reason: "length-mismatch" });
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint8(4);
  if (version !== FORMAT_VERSION_METADATA && version !== FORMAT_VERSION_ALL) {
    return fail({ reason: "unsupported-version", version });
  }
  const kindLength = view.getUint8(5);
  if (kindLength === 0 || kindLength > MAX_KIND_LENGTH) {
    return fail({ reason: "kind-invalid" });
  }
  const headerBytes = headerLengthOf(kindLength);
  if (fileLength < headerBytes) return fail({ reason: "length-mismatch" });
  const kind = String.fromCharCode(
    ...bytes.subarray(FIXED_HEADER_BYTES, headerBytes),
  );
  if (!isProjectKind(kind)) return fail({ reason: "kind-invalid" });
  if (expectedKind !== undefined && kind !== expectedKind) {
    return fail({ reason: "kind-mismatch" });
  }
  const payloadLength = view.getUint32(6, true);
  if (fileLength !== headerBytes + payloadLength) {
    return fail({ reason: "length-mismatch" });
  }
  return {
    ok: true,
    value: {
      kind,
      formatVersion: version,
      payloadLength,
      crc: view.getUint32(10, true),
      centralStart: view.getUint32(14, true),
      keyCheck: view.getUint32(18, true),
      headerBytes,
    },
  };
}
