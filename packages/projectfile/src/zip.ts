// 프로젝트 파일의 ZIP을 읽는다. 중앙 디렉터리의 선언만 믿고, 항목은 선언 크기까지만 푼다.
// - 중앙 디렉터리는 `readCentralRecords`가 한 번 읽는다. 범위 계획(`metadata-scramble.ts`)과 항목 목록(`readZipEntries`)이 같은 레코드를 쓴다.
// - 레코드에는 구조 검사만 둔다(CRC 비교 앞). 이름 해석과 항목 값 검사는 CRC 비교 뒤 `readZipEntries`가 한다. 그래야 손상 이유가 검사 순서를 따른다.
// - fflate `unzipSync`는 선언 크기 버퍼에 풀지만 넘치는 deflate 스트림도 끝까지 해제한다.
//   메모리는 막고 CPU는 막지 못한다. 그래서 목록은 직접 읽고 해제는 `Inflate`를 조각으로 민다.
// - 평문 조각을 읽는다. 중앙 디렉터리와 로컬 헤더는 복원한 뒤 넘긴다(`metadata-scramble.ts`). 파일 전체를 받지 않는다.
// - 이 코덱이 만드는 ZIP만 받는다. 암호화 항목, UTF-8 표시 없는 비 ASCII 이름, 저장·deflate 밖 압축은 거부한다.
// - 규칙은 `docs/format.md`의 "검사 순서"에 있다.
import { Inflate } from "fflate";
import {
  CENTRAL_BYTES,
  CENTRAL_COMMENT_LENGTH_AT,
  CENTRAL_COMPRESSED_SIZE_AT,
  CENTRAL_CRC_AT,
  CENTRAL_EXTRA_LENGTH_AT,
  CENTRAL_FLAGS_AT,
  CENTRAL_LOCAL_OFFSET_AT,
  CENTRAL_METHOD_AT,
  CENTRAL_NAME_LENGTH_AT,
  CENTRAL_SIGNATURE,
  CENTRAL_SIZE_AT,
  ENCRYPTED_FLAG,
  EOCD_BYTES,
  EOCD_CENTRAL_DISK_AT,
  EOCD_CENTRAL_OFFSET_AT,
  EOCD_CENTRAL_SIZE_AT,
  EOCD_COMMENT_LENGTH_AT,
  EOCD_DISK_AT,
  EOCD_DISK_ENTRIES_AT,
  EOCD_ENTRIES_AT,
  EOCD_SIGNATURE,
  LOCAL_BYTES,
  LOCAL_SIGNATURE,
  METHOD_DEFLATE,
  METHOD_STORED,
  UTF8_FLAG,
} from "./zip-layout";

/** `Inflate`에 한 번에 미는 압축 바이트. 한 번에 풀리는 출력은 이 값의 약 1,032배 이하다. */
const INFLATE_CHUNK_BYTES = 16 * 1024;

/** 중앙 디렉터리의 항목 하나. */
export interface ZipEntry {
  name: string;

  /** 압축 방식. 0은 저장, 8은 deflate다. */
  method: number;

  /** 압축한 바이트. */
  compressedSize: number;

  /** 풀었을 때의 바이트. 선언 값이다. */
  size: number;

  /** 풀었을 때의 CRC32. 선언 값이다. */
  crc: number;

  /** 압축 데이터가 시작하는 위치. */
  dataStart: number;
}

/** 중앙 디렉터리 항목이 적은 값. 이름은 해석하지 않은 바이트다. */
export interface CentralRecord {
  /** 이름 바이트. `central`의 구간을 가리키고 복사하지 않는다. */
  nameBytes: Uint8Array;

  /** 일반 목적 플래그. */
  flags: number;

  /** 압축 방식. 0은 저장, 8은 deflate다. */
  method: number;

  /** 압축한 바이트. */
  compressedSize: number;

  /** 풀었을 때의 바이트. 선언 값이다. */
  size: number;

  /** 풀었을 때의 CRC32. 선언 값이다. */
  crc: number;

  /** ZIP 안 로컬 헤더 시작 위치. */
  localStart: number;
}

/**
 * 중앙 디렉터리를 한 번 읽어 항목 레코드를 중앙 디렉터리 순서로 돌려준다. 이름도 내용도 해석하지 않는다.
 * - `central`은 `centralStart`부터 ZIP 끝까지(중앙 디렉터리 + 끝 레코드)다. 평문이어야 한다.
 * - 끝 레코드가 중앙 디렉터리 시작 위치와 다르거나 범위가 어긋나면 `null`이다.
 * - 끝 레코드의 항목 수가 `maxEntries`를 넘으면 항목을 읽지 않고 `null`이다.
 *   항목마다 객체를 만들기 전에 거르려고 끝 레코드의 수를 기준으로 한다.
 *   수가 실제 항목 수와 다르면 어차피 `null`이라 기준이 달라져도 결과는 같다.
 * - 항목의 서명, 길이 합, 로컬 헤더 위치가 범위를 벗어나도 `null`이다.
 */
export function readCentralRecords(
  central: Uint8Array,
  centralStart: number,
  maxEntries: number,
): CentralRecord[] | null {
  const eocd = central.length - EOCD_BYTES;
  if (eocd < 0) return null;
  const view = new DataView(
    central.buffer,
    central.byteOffset,
    central.byteLength,
  );
  const u16 = (at: number) => view.getUint16(at, true);
  const u32 = (at: number) => view.getUint32(at, true);

  if (u32(eocd) !== EOCD_SIGNATURE) return null;
  const count = u16(eocd + EOCD_ENTRIES_AT);
  if (
    count > maxEntries ||
    u16(eocd + EOCD_DISK_AT) !== 0 ||
    u16(eocd + EOCD_CENTRAL_DISK_AT) !== 0 ||
    u16(eocd + EOCD_DISK_ENTRIES_AT) !== count ||
    u16(eocd + EOCD_COMMENT_LENGTH_AT) !== 0 ||
    u32(eocd + EOCD_CENTRAL_OFFSET_AT) !== centralStart ||
    u32(eocd + EOCD_CENTRAL_SIZE_AT) !== eocd
  ) {
    return null;
  }

  const records: CentralRecord[] = [];
  let at = 0;
  for (let index = 0; index < count; index += 1) {
    // `next > eocd`가 `at <= eocd`를 지켜도 끝 레코드 앞 꼬리가 46바이트보다 짧을 수 있다. 고정부를 읽기 전에 막아야 DataView가 던지지 않는다.
    if (at + CENTRAL_BYTES > eocd || u32(at) !== CENTRAL_SIGNATURE) {
      return null;
    }
    const nameLength = u16(at + CENTRAL_NAME_LENGTH_AT);
    const next =
      at +
      CENTRAL_BYTES +
      nameLength +
      u16(at + CENTRAL_EXTRA_LENGTH_AT) +
      u16(at + CENTRAL_COMMENT_LENGTH_AT);
    const localStart = u32(at + CENTRAL_LOCAL_OFFSET_AT);
    if (next > eocd || localStart + LOCAL_BYTES > centralStart) return null;
    records.push({
      nameBytes: central.subarray(
        at + CENTRAL_BYTES,
        at + CENTRAL_BYTES + nameLength,
      ),
      flags: u16(at + CENTRAL_FLAGS_AT),
      method: u16(at + CENTRAL_METHOD_AT),
      compressedSize: u32(at + CENTRAL_COMPRESSED_SIZE_AT),
      size: u32(at + CENTRAL_SIZE_AT),
      crc: u32(at + CENTRAL_CRC_AT),
      localStart,
    });
    at = next;
  }
  return at === eocd ? records : null;
}

/** 항목 이름을 읽는다. UTF-8 표시가 없으면 ASCII만 받는다. 읽지 못하면 `null`이다. */
function readName(bytes: Uint8Array, utf8: boolean): string | null {
  if (!utf8 && bytes.some((byte) => byte >= 0x80)) return null;
  try {
    // 맨 앞 U+FEFF를 BOM으로 떼지 않는다. 떼면 다른 항목과 같은 이름이 된다.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    return null;
  }
}

/**
 * 중앙 디렉터리 레코드를 항목 목록으로 바꾼다. 내용은 풀지 않는다.
 * - `records`는 `readCentralRecords`가 돌려준 값이다. 서명과 범위는 거기서 이미 검사했다.
 * - `locals`는 로컬 헤더 시작 위치마다 읽어 둔 헤더(30바이트 + 이름)다. 평문이어야 한다.
 *   로컬 헤더의 extra 길이는 0이다(`metadata-scramble.ts`가 검사한다). 그래서 본문 시작은 중앙 디렉터리의 이름 길이로 정한다.
 * - 이름 해석은 CRC 비교 뒤인 여기서 한다. 그래서 이름이 틀린 파일도 CRC가 다르면 `crc-mismatch`다.
 * 암호화 항목, 읽지 못하는 이름, 겹치는 이름, 로컬 헤더나 본문이 범위를 벗어나면 `null`이다.
 */
export function readZipEntries(
  records: readonly CentralRecord[],
  centralStart: number,
  locals: ReadonlyMap<number, Uint8Array>,
): ZipEntry[] | null {
  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  for (const record of records) {
    if (record.flags & ENCRYPTED_FLAG) return null;
    const name = readName(record.nameBytes, (record.flags & UTF8_FLAG) !== 0);
    if (name === null || names.has(name)) return null;

    const head = locals.get(record.localStart);
    if (head === undefined) return null;
    if (
      new DataView(head.buffer, head.byteOffset).getUint32(0, true) !==
      LOCAL_SIGNATURE
    ) {
      return null;
    }
    const dataStart = record.localStart + LOCAL_BYTES + record.nameBytes.length;
    if (dataStart + record.compressedSize > centralStart) return null;

    names.add(name);
    entries.push({
      name,
      method: record.method,
      compressedSize: record.compressedSize,
      size: record.size,
      crc: record.crc,
      dataStart,
    });
  }
  return entries;
}

/**
 * 항목을 푼다. 풀린 길이가 선언 크기와 다르면 `null`이다.
 * - `data`는 항목의 압축 바이트(`dataStart`부터 `compressedSize`바이트)다. 바꾸지 않는다.
 * - deflate는 조각으로 밀고, 출력이 선언 크기를 넘는 순간 멈춘다. 해제 CPU가 선언 크기에 묶인다.
 * - 저장 항목은 압축 크기와 선언 크기가 같아야 한다.
 */
export function inflateEntry(
  data: Uint8Array,
  entry: ZipEntry,
): Uint8Array | null {
  if (entry.method === METHOD_STORED) {
    return data.length === entry.size ? data.slice() : null;
  }
  if (entry.method !== METHOD_DEFLATE) return null;

  const out = new Uint8Array(entry.size);
  let written = 0;
  let overflow = false;
  const inflate = new Inflate((chunk) => {
    if (written + chunk.length > out.length) {
      overflow = true;
      return;
    }
    out.set(chunk, written);
    written += chunk.length;
  });
  try {
    for (
      let start = 0;
      !overflow && start < data.length;
      start += INFLATE_CHUNK_BYTES
    ) {
      const end = Math.min(start + INFLATE_CHUNK_BYTES, data.length);
      inflate.push(data.subarray(start, end), end === data.length);
    }
  } catch {
    return null;
  }
  return !overflow && written === out.length ? out : null;
}
