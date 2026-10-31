// 프로젝트 파일의 ZIP을 조각 목록으로 쓴다. 읽기는 `zip.ts`가 맡는다.
// - 출력은 바이트 하나가 아니라 조각 목록이다. asset `Blob`을 읽어 복사하지 않고 그대로 조각에 둔다.
// - 필드는 이 코덱이 읽는 모양으로 고정한다.
//   - 이름은 UTF-8이고 일반 목적 비트 11을 켠다. 수정 시각은 1980-01-01이다.
//   - 로컬 헤더와 중앙 디렉터리의 extra 길이, 중앙 디렉터리의 주석 길이는 0이다.
//   - 텍스트는 deflate(방식 8), asset과 폴더는 저장(방식 0)이다. ZIP64를 쓰지 않는다.
// - 항목 순서는 호출자가 정한다. 같은 입력이면 같은 조각이 나온다.
// - 섞는 조각은 `scramble`이 참이다: 로컬 헤더, 표시한 항목의 본문, 중앙 디렉터리와 끝 레코드.
//   포맷 버전 1은 이 표시대로 `seal.ts`가 섞는다(`metadata-scramble.ts`가 같은 범위를 푼다).
//   포맷 버전 2는 표시와 상관없이 모든 조각을 섞는다(`full-scramble.ts`).
// - 규칙은 `docs/format.md`의 "ZIP과 manifest"에 있다.
import { deflateSync } from "fflate";
import { readBlobBytes } from "./blob";
import { crc32 } from "./crc32";
import {
  CENTRAL_BYTES,
  CENTRAL_COMPRESSED_SIZE_AT,
  CENTRAL_CRC_AT,
  CENTRAL_DATE_AT,
  CENTRAL_FLAGS_AT,
  CENTRAL_LOCAL_OFFSET_AT,
  CENTRAL_METHOD_AT,
  CENTRAL_NAME_LENGTH_AT,
  CENTRAL_SIGNATURE,
  CENTRAL_SIZE_AT,
  CENTRAL_TIME_AT,
  CENTRAL_VERSION_MADE_AT,
  CENTRAL_VERSION_NEEDED_AT,
  EOCD_BYTES,
  EOCD_CENTRAL_OFFSET_AT,
  EOCD_CENTRAL_SIZE_AT,
  EOCD_DISK_ENTRIES_AT,
  EOCD_ENTRIES_AT,
  EOCD_SIGNATURE,
  LOCAL_BYTES,
  LOCAL_COMPRESSED_SIZE_AT,
  LOCAL_CRC_AT,
  LOCAL_DATE_AT,
  LOCAL_EXTRA_LENGTH_AT,
  LOCAL_FLAGS_AT,
  LOCAL_METHOD_AT,
  LOCAL_NAME_LENGTH_AT,
  LOCAL_SIGNATURE,
  LOCAL_SIZE_AT,
  LOCAL_TIME_AT,
  LOCAL_VERSION_AT,
  METHOD_DEFLATE,
  METHOD_STORED,
  UTF8_FLAG,
} from "./zip-layout";

/** `Blob` 본문의 CRC32를 읽는 단위(바이트). 한 번에 메모리에 올리는 양의 상한이다. */
const CRC_CHUNK_BYTES = 1024 * 1024;

/** 만든 버전과 필요한 버전. 20은 deflate와 폴더 항목을 쓰는 ZIP 2.0이다. */
const ZIP_VERSION = 20;

/** DOS 날짜 1980-01-01. DOS 시각은 0(00:00:00)이다. */
const FIXED_DOS_DATE = 0x0021;

/** ZIP에 쓸 항목. */
export type ZipSource = {
  /** 항목 이름. 폴더는 `/`로 끝난다. */
  name: string;

  /** 본문까지 섞는 범위에 든다. `manifest.json`이다. */
  scrambleBody?: boolean;
} & (
  | {
      /** 본문을 deflate한다. */
      deflate: true;

      /** 풀린 본문 바이트 */
      data: Uint8Array;
    }
  | {
      /** 본문을 그대로 저장한다. `Blob`은 복사하지 않고 조각으로 둔다. */
      deflate: false;

      /** 저장할 본문. 폴더는 빈 `Uint8Array` */
      data: Uint8Array | Blob;
    }
);

/** 출력 조각. 이어 붙이면 ZIP이다. */
export type ZipPart =
  | {
      /** 조각 바이트. 섞기 전 평문 */
      bytes: Uint8Array;

      /** 섞는 범위다. */
      scramble: boolean;
    }
  | {
      /** 입력 asset `Blob` 그대로 */
      bytes: Blob;

      /** 섞지 않는 범위. asset 본문은 늘 평문. ZIP 전체를 섞는 버전은 `full-scramble.ts`가 따로 섞는다. */
      scramble: false;

      /** 항목의 ZIP 이름. 섞으려고 `Blob`을 다시 읽다 실패하면 `ZipSourceReadError`에 담는다. */
      name: string;
    };

/** 쓴 ZIP. */
export interface WrittenZip {
  /** ZIP 순서의 조각. 길이가 0인 조각은 없다. */
  parts: ZipPart[];

  /** ZIP 전체 길이(바이트). */
  length: number;

  /** 중앙 디렉터리가 시작하는 위치. */
  centralStart: number;
}

/** 항목의 헤더 필드. */
interface EntryFields {
  /** UTF-8 항목 이름 */
  name: Uint8Array;

  /** ZIP 압축 방식 번호. 0은 저장, 8은 deflate */
  method: 0 | 8;

  /** 풀린 본문의 CRC32 */
  crc: number;

  /** ZIP에 담긴 본문 바이트 수 */
  compressedSize: number;

  /** 풀린 본문 바이트 수 */
  size: number;

  /** 로컬 헤더가 시작하는 위치. */
  offset: number;
}

/**
 * 항목 본문 `Blob`을 읽지 못했다.
 * - `writeZip`이 거부한다. 호출자 버그로 던지는 다른 오류와 가르려고 별도 클래스를 쓴다.
 * - 읽기 실패만 이 클래스로 바꾼다. `Blob` 읽기 밖의 오류는 그대로 거부한다.
 */
export class ZipSourceReadError extends Error {
  /** 읽지 못한 항목의 ZIP 이름. `ZipSource.name`이다. */
  readonly sourceName: string;

  constructor(sourceName: string) {
    super(`항목 본문을 읽지 못했다: ${sourceName}`);
    this.name = "ZipSourceReadError";
    this.sourceName = sourceName;
  }
}

/** `Blob`의 CRC32를 조각으로 읽으며 이어서 계산한다. 읽기가 거부되면 `ZipSourceReadError`다. */
async function crcOfBlob(blob: Blob, sourceName: string): Promise<number> {
  let crc = 0;
  for (let start = 0; start < blob.size; start += CRC_CHUNK_BYTES) {
    const slice = blob.slice(start, start + CRC_CHUNK_BYTES);
    let chunk: Uint8Array;
    try {
      chunk = await readBlobBytes(slice);
    } catch {
      throw new ZipSourceReadError(sourceName);
    }
    crc = crc32(chunk, crc);
  }
  return crc;
}

/** 로컬 헤더(30바이트 + 이름). */
function writeLocal(fields: EntryFields): Uint8Array {
  const out = new Uint8Array(LOCAL_BYTES + fields.name.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, LOCAL_SIGNATURE, true);
  view.setUint16(LOCAL_VERSION_AT, ZIP_VERSION, true);
  view.setUint16(LOCAL_FLAGS_AT, UTF8_FLAG, true);
  view.setUint16(LOCAL_METHOD_AT, fields.method, true);
  view.setUint16(LOCAL_TIME_AT, 0, true);
  view.setUint16(LOCAL_DATE_AT, FIXED_DOS_DATE, true);
  view.setUint32(LOCAL_CRC_AT, fields.crc, true);
  view.setUint32(LOCAL_COMPRESSED_SIZE_AT, fields.compressedSize, true);
  view.setUint32(LOCAL_SIZE_AT, fields.size, true);
  view.setUint16(LOCAL_NAME_LENGTH_AT, fields.name.length, true);
  view.setUint16(LOCAL_EXTRA_LENGTH_AT, 0, true);
  out.set(fields.name, LOCAL_BYTES);
  return out;
}

/** 중앙 디렉터리 항목(46바이트 + 이름). */
function writeCentral(fields: EntryFields): Uint8Array {
  const out = new Uint8Array(CENTRAL_BYTES + fields.name.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, CENTRAL_SIGNATURE, true);
  view.setUint16(CENTRAL_VERSION_MADE_AT, ZIP_VERSION, true);
  view.setUint16(CENTRAL_VERSION_NEEDED_AT, ZIP_VERSION, true);
  view.setUint16(CENTRAL_FLAGS_AT, UTF8_FLAG, true);
  view.setUint16(CENTRAL_METHOD_AT, fields.method, true);
  view.setUint16(CENTRAL_TIME_AT, 0, true);
  view.setUint16(CENTRAL_DATE_AT, FIXED_DOS_DATE, true);
  view.setUint32(CENTRAL_CRC_AT, fields.crc, true);
  view.setUint32(CENTRAL_COMPRESSED_SIZE_AT, fields.compressedSize, true);
  view.setUint32(CENTRAL_SIZE_AT, fields.size, true);
  view.setUint16(CENTRAL_NAME_LENGTH_AT, fields.name.length, true);
  view.setUint32(CENTRAL_LOCAL_OFFSET_AT, fields.offset, true);
  out.set(fields.name, CENTRAL_BYTES);
  return out;
}

/** 끝 레코드(22바이트). ZIP 주석이 없다. */
function writeEocd(count: number, size: number, start: number): Uint8Array {
  const out = new Uint8Array(EOCD_BYTES);
  const view = new DataView(out.buffer);
  view.setUint32(0, EOCD_SIGNATURE, true);
  view.setUint16(EOCD_DISK_ENTRIES_AT, count, true);
  view.setUint16(EOCD_ENTRIES_AT, count, true);
  view.setUint32(EOCD_CENTRAL_SIZE_AT, size, true);
  view.setUint32(EOCD_CENTRAL_OFFSET_AT, start, true);
  return out;
}

/**
 * 항목을 ZIP 조각 목록으로 쓴다.
 * - `Blob` 본문은 읽어서 CRC32만 계산한다. 조각 단위로 읽어 한 번에 올리는 양이 `CRC_CHUNK_BYTES` 이하다.
 * - `Blob`을 읽지 못하면 `ZipSourceReadError`로 거부(reject)한다. 항목 순서에서 처음 읽지 못한 항목이다.
 * - 항목 수와 위치가 ZIP64 없이 표현되는지는 호출자가 한도로 막는다.
 */
export async function writeZip(
  sources: readonly ZipSource[],
): Promise<WrittenZip> {
  const encoder = new TextEncoder();
  const parts: ZipPart[] = [];
  const central: Uint8Array[] = [];
  let centralSize = 0;
  let offset = 0;
  for (const source of sources) {
    const { data } = source;
    // `data`를 꺼내면 `deflate`와의 짝이 사라져 `source.data`로 좁힌다.
    const body = source.deflate ? deflateSync(source.data) : source.data;
    const fields: EntryFields = {
      name: encoder.encode(source.name),
      method: source.deflate ? METHOD_DEFLATE : METHOD_STORED,
      crc:
        data instanceof Uint8Array
          ? crc32(data)
          : await crcOfBlob(data, source.name),
      compressedSize: body instanceof Uint8Array ? body.length : body.size,
      size: data instanceof Uint8Array ? data.length : data.size,
      offset,
    };
    const local = writeLocal(fields);
    parts.push({ bytes: local, scramble: true });
    if (fields.compressedSize > 0) {
      parts.push(
        body instanceof Uint8Array
          ? { bytes: body, scramble: source.scrambleBody === true }
          : { bytes: body, scramble: false, name: source.name },
      );
    }
    const entry = writeCentral(fields);
    central.push(entry);
    centralSize += entry.length;
    offset += local.length + fields.compressedSize;
  }

  // 중앙 디렉터리와 끝 레코드는 하나의 섞는 조각이다.
  const tail = new Uint8Array(centralSize + EOCD_BYTES);
  let at = 0;
  for (const entry of central) {
    tail.set(entry, at);
    at += entry.length;
  }
  tail.set(writeEocd(central.length, centralSize, offset), at);
  parts.push({ bytes: tail, scramble: true });
  return { parts, length: offset + tail.length, centralStart: offset };
}
