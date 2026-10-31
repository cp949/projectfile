// 봉인과 열기. ZIP과 헤더 사이의 변환이다.
// - 봉인(버전 1): 헤더(22 + N바이트) + 메타데이터 범위와 manifest 본문만 scramble한 ZIP. 조각 목록으로 만든다.
//   섞는 조각만 새 버퍼가 되고 나머지(asset `Blob` 포함)는 그대로 둔다. 버전 2의 봉인은 `full-scramble.ts`다.
// - 열기: 헤더가 가리키는 범위만 읽어 되돌리고 CRC32를 헤더와 비교한다. 입력은 고치지 않는다.
//   버전 2는 읽는 즉시 되돌리는 읽기 수단(`createUnscrambledReader`)을 받는다. 그러면 읽은 조각이 이미 평문이다.
//   CRC 범위만 다르다. 버전 1은 메타데이터 범위, 버전 2는 ZIP 전체다.
// - 규칙은 `docs/format.md`의 "헤더"와 "검사 순서"에 있다.
import { blobPartOf } from "./blob";
import { crc32 } from "./crc32";
import { fail, type ProjectFileResult } from "./errors";
import { crcOfPayload, PLAIN_SCRAMBLER } from "./full-scramble";
import {
  FORMAT_VERSION_ALL,
  FORMAT_VERSION_METADATA,
  writeHeader,
  type ProjectFileHeader,
  type ProjectKind,
} from "./header";
import {
  localRefsOf,
  planScrambledRanges,
  restoreScrambled,
  type LocalRef,
} from "./metadata-scramble";
import type { ByteRange, RangeReader } from "./read-range";
import { createScrambler, keyCheckOf } from "./scramble";
import { readCentralRecords, readZipEntries, type ZipEntry } from "./zip";
import { EOCD_BYTES, METHOD_STORED } from "./zip-layout";
import type { WrittenZip } from "./zip-write";

/**
 * 포맷 버전 1. 쓴 ZIP의 섞는 조각을 `key`로 섞고 헤더를 맨 앞에 붙인 조각 목록을 돌려준다. `Blob`에 그대로 넘긴다.
 * - 섞는 조각은 새 버퍼가 된다. 입력 조각은 바꾸지 않는다. 호출자의 `Uint8Array`가 든 조각도 같다.
 * - 섞지 않는 `Uint8Array` 조각은 그대로 넘긴다. `SharedArrayBuffer` 뷰만 복사한다(`blobPartOf`).
 * - 헤더의 CRC는 섞기 전 평문의 섞는 조각을 ZIP 순서로 이어서 계산한다. 그래서 헤더는 마지막에 만든다.
 */
export function sealZip(
  zip: WrittenZip,
  kind: ProjectKind,
  key: Uint8Array,
): BlobPart[] {
  const scrambler = createScrambler(key);
  const sealed: BlobPart[] = [];
  let crc = 0;
  let position = 0;
  for (const part of zip.parts) {
    if (part.scramble) {
      crc = crc32(part.bytes, crc);
      sealed.push(scrambler.scramble(part.bytes, position) as BlobPart);
    } else {
      sealed.push(
        part.bytes instanceof Uint8Array ? blobPartOf(part.bytes) : part.bytes,
      );
    }
    position +=
      part.bytes instanceof Uint8Array ? part.bytes.length : part.bytes.size;
  }
  const header = writeHeader(
    kind,
    FORMAT_VERSION_METADATA,
    zip.length,
    crc,
    zip.centralStart,
    keyCheckOf(key),
  );
  return [header as BlobPart, ...sealed];
}

/** 열기 결과. 중앙 디렉터리의 항목 목록과 읽어 둔 압축 본문. */
export interface OpenedZip {
  entries: ZipEntry[];

  /** `manifest.json` 항목의 본문(압축 바이트). 섞는 범위에 들어 있어 되돌린 값이다. */
  manifestBody: Uint8Array;

  /**
   * 읽어 둔 그 밖의 항목 본문(압축 바이트). 키는 항목의 `dataStart`다.
   * 방식이 0이 아닌(deflate) 항목만 들고 `manifest.json`은 없다. 저장(0) 항목 본문은 읽지 않는다.
   */
  bodies: Map<number, Uint8Array>;
}

/**
 * 메타데이터 범위와 manifest 본문을 읽어 되돌리고 CRC를 비교한다. 입력은 바꾸지 않는다.
 * - `source`는 헤더 버전 1이면 입력 그대로, 2이면 읽는 즉시 평문으로 돌리는 읽기 수단이다(`createUnscrambledReader`).
 * - 헤더 버전 2의 CRC는 ZIP 전체를 조각으로 읽어 이어서 계산한다. 구조 검사(`zip-corrupt`)가 CRC 비교보다 앞이다.
 * - 읽는 범위: `centralStart`부터 끝까지, 항목마다 로컬 헤더와 `manifest.json` 본문.
 *   방식이 0이 아닌 항목은 로컬 헤더 바로 뒤 본문도 같은 범위로 묶어 읽는다.
 *   인코더는 텍스트를 deflate, asset을 저장으로 쓴다. 그래서 asset 본문은 읽지 않는다.
 *   저장한 텍스트 본문은 여기서 읽지 않는다. 호출자가 manifest를 보고 필요하면 읽는다.
 * - 읽기 호출은 `read`가 붙은 범위를 묶는다. 이 함수의 호출 수는 중앙 디렉터리 1회 + 항목 수 이하다.
 *   헤더는 호출자가 `readHead`로 먼저 읽는다.
 * - 끝 레코드의 항목 수가 `maxEntries`를 넘으면 로컬 헤더를 읽기 전에 `zip-corrupt`다.
 *   인코더는 한도 안에서 이 수를 넘는 파일을 만들지 않는다. 호출자는 `maxZipEntries(limits)`를 넘긴다.
 * - 읽지 못하면 `read-failed`, 범위를 정할 수 없으면 `zip-corrupt`, CRC가 다르면 `crc-mismatch`다.
 *   그 뒤 항목 목록을 읽을 수 없으면 `zip-corrupt`다.
 */
export async function openZip(
  source: RangeReader,
  header: ProjectFileHeader,
  key: Uint8Array,
  maxEntries: number,
): Promise<ProjectFileResult<OpenedZip>> {
  const { headerBytes, centralStart, payloadLength: zipLength } = header;
  // 범위는 ZIP 안 위치로 다루고, 읽을 때 파일 안 위치로 바꾼다.
  const readZip = async (ranges: readonly ByteRange[]) => {
    try {
      return await source.read(
        ranges.map(({ start, end }) => ({
          start: headerBytes + start,
          end: headerBytes + end,
        })),
      );
    } catch {
      return null;
    }
  };
  if (centralStart > zipLength - EOCD_BYTES)
    return fail({ reason: "zip-corrupt" });

  // 버전 2는 읽는 쪽이 이미 평문으로 돌린다. 되돌리기를 다시 하지 않도록 아무것도 하지 않는 되돌리기를 쓴다.
  const whole = header.formatVersion === FORMAT_VERSION_ALL;
  const scrambler = whole ? PLAIN_SCRAMBLER : createScrambler(key);
  const tail = await readZip([{ start: centralStart, end: zipLength }]);
  if (tail === null) return fail({ reason: "read-failed" });
  const central = scrambler.unscramble(tail[0] as Uint8Array, centralStart);
  // 중앙 디렉터리는 여기서 한 번만 읽는다. 레코드 구조 검사는 CRC 비교 앞이고, 이름 해석과 로컬 헤더 대조는 CRC 비교 뒤 `readZipEntries`가 한다.
  const records = readCentralRecords(central, centralStart, maxEntries);
  const refs = records && localRefsOf(records);
  const ranges = refs && planScrambledRanges(refs, centralStart);
  if (records === null || refs === null || ranges === null) {
    return fail({ reason: "zip-corrupt" });
  }

  // 섞는 범위 뒤에 deflate 본문이 바로 이어진다. 본문이 `centralStart`를 넘으면 읽지 않고 항목 목록 단계가 거부한다.
  const reads = ranges.map(({ start, end }, index) => {
    const { manifest, method, size } = refs[index] as LocalRef;
    const bodyEnd = end + size;
    return manifest || method === METHOD_STORED || bodyEnd > centralStart
      ? { start, end }
      : { start, end: bodyEnd };
  });
  const chunks = await readZip(reads);
  if (chunks === null) return fail({ reason: "read-failed" });
  const restored = restoreScrambled(
    scrambler,
    refs,
    chunks.map((chunk, index) =>
      chunk.subarray(
        0,
        (ranges[index] as ByteRange).end - (ranges[index] as ByteRange).start,
      ),
    ),
    central,
  );
  if (restored === null) return fail({ reason: "zip-corrupt" });
  let crc = restored.crc;
  if (whole) {
    const total = await crcOfPayload(source, headerBytes, zipLength);
    if (total === null) return fail({ reason: "read-failed" });
    crc = total;
  }
  if (crc !== header.crc) return fail({ reason: "crc-mismatch" });

  const entries = readZipEntries(records, centralStart, restored.locals);
  if (entries === null) return fail({ reason: "zip-corrupt" });
  // 범위를 늘려 읽은 항목만 든다. manifest는 범위를 늘리지 않으므로 들지 않는다.
  const bodies = new Map<number, Uint8Array>();
  reads.forEach((read, index) => {
    const rangeEnd = (ranges[index] as ByteRange).end;
    if (read.end > rangeEnd) {
      bodies.set(
        rangeEnd,
        (chunks[index] as Uint8Array).subarray(rangeEnd - read.start),
      );
    }
  });
  return {
    ok: true,
    value: { entries, manifestBody: restored.manifestBody, bodies },
  };
}
