// 포맷 버전 2. ZIP 전체를 scramble한다. 메타데이터 범위만 섞는 버전 1은 `seal.ts`가 맡는다.
// - 봉인: 모든 조각을 섞고, 헤더 CRC는 섞기 전 ZIP 전체를 ZIP 위치 순서로 이어서 계산한다.
//   asset `Blob`은 조각(`CHUNK_BYTES`)으로 읽어 섞는다. 섞은 조각을 곧바로 `Blob`으로 만들어 `Uint8Array`를 오래 들지 않는다.
// - 열기: 읽는 즉시 평문으로 돌리는 읽기 수단을 만든다(`createUnscrambledReader`). 이후 단계는 두 버전이 같은 코드를 쓴다.
//   CRC는 ZIP 전체를 조각으로 읽어 따로 계산한다(`crcOfPayload`). asset의 `Blob`은 평문을 읽어 새로 만든다(`plainBlob`).
//   섞인 입력의 `slice`는 평문이 아니어서 버전 1처럼 쓸 수 없다. `docs/adr/0007-full-scramble-version.md`에 이유가 있다.
// - 규칙은 `docs/format.md`의 "scramble"과 "검사 순서"에 있다.
import { blobPartOf, readBlobBytes } from "./blob";
import { crc32 } from "./crc32";
import { FORMAT_VERSION_ALL, writeHeader, type ProjectKind } from "./header";
import type { ByteRange, RangeReader } from "./read-range";
import { createScrambler, keyCheckOf, type Scrambler } from "./scramble";
import { ZipSourceReadError, type WrittenZip } from "./zip-write";

/** 한 번에 읽어 섞거나 CRC를 계산하는 크기(바이트). 메모리에 올리는 `Uint8Array`의 상한이다. */
export const CHUNK_BYTES: number = 1024 * 1024;

/** 아무것도 하지 않는 섞기. 읽기 수단이 이미 평문으로 돌렸을 때 되돌리기를 건너뛰려고 쓴다. */
export const PLAIN_SCRAMBLER: Scrambler = {
  scramble: (data) => data,
  unscramble: (data) => data,
};

/**
 * 쓴 ZIP 전체를 `key`로 섞고 헤더를 맨 앞에 붙인 조각 목록을 돌려준다. `Blob`에 그대로 넘긴다.
 * - 입력 조각은 바꾸지 않는다. 호출자의 `Uint8Array`가 든 조각도 같다.
 * - asset `Blob` 조각은 `CHUNK_BYTES`씩 읽어 섞는다. 읽지 못하거나 짧게 읽히면 `ZipSourceReadError`로 거부한다.
 * - 헤더의 CRC는 섞기 전 ZIP 전체다. 그래서 헤더는 마지막에 만든다.
 */
export async function sealZipWhole(
  zip: WrittenZip,
  kind: ProjectKind,
  key: Uint8Array,
): Promise<BlobPart[]> {
  const scrambler = createScrambler(key);
  const sealed: BlobPart[] = [];
  let crc = 0;
  let position = 0;
  for (const part of zip.parts) {
    // `name`이 있는 조각이 asset `Blob`이다.
    if (!("name" in part)) {
      crc = crc32(part.bytes, crc);
      sealed.push(scrambler.scramble(part.bytes, position) as BlobPart);
      position += part.bytes.length;
      continue;
    }
    const blob = part.bytes;
    for (let start = 0; start < blob.size; start += CHUNK_BYTES) {
      const end = Math.min(start + CHUNK_BYTES, blob.size);
      let chunk: Uint8Array;
      try {
        chunk = await readBlobBytes(blob.slice(start, end));
      } catch {
        throw new ZipSourceReadError(part.name);
      }
      // 짧게 읽히면 위치가 어긋나 이후 조각이 모두 틀린다. 읽기 실패로 거부한다.
      if (chunk.length !== end - start) throw new ZipSourceReadError(part.name);
      crc = crc32(chunk, crc);
      sealed.push(
        new Blob([scrambler.scramble(chunk, position + start) as BlobPart]),
      );
    }
    position += blob.size;
  }
  const header = writeHeader(
    kind,
    FORMAT_VERSION_ALL,
    zip.length,
    crc,
    zip.centralStart,
    keyCheckOf(key),
  );
  return [header as BlobPart, ...sealed];
}

/**
 * 읽은 범위를 곧바로 평문으로 돌리는 읽기 수단을 만든다. 좌표는 파일 위치다.
 * - 키스트림이 ZIP 위치를 따르므로 `start - headerBytes`가 되돌리기의 시작 위치다.
 * - 돌려주는 배열은 새 배열이다. `source`가 돌려준 뷰와 입력은 바꾸지 않는다.
 */
export function createUnscrambledReader(
  source: RangeReader,
  headerBytes: number,
  key: Uint8Array,
): RangeReader {
  const scrambler = createScrambler(key);
  return {
    async read(ranges) {
      const raw = await source.read(ranges);
      return raw.map((bytes, index) =>
        scrambler.unscramble(
          bytes,
          (ranges[index] as ByteRange).start - headerBytes,
        ),
      );
    },
  };
}

/**
 * payload 전체의 평문 CRC32를 `CHUNK_BYTES`씩 읽어 이어서 계산한다.
 * - `reader`는 평문으로 돌리는 읽기 수단이다. `headerBytes`는 payload가 시작하는 파일 위치다.
 * - 읽지 못하거나 범위보다 짧게 읽히면 `null`이다.
 */
export async function crcOfPayload(
  reader: RangeReader,
  headerBytes: number,
  payloadLength: number,
): Promise<number | null> {
  let crc = 0;
  for (let at = 0; at < payloadLength; at += CHUNK_BYTES) {
    const end = Math.min(at + CHUNK_BYTES, payloadLength);
    try {
      const [chunk] = await reader.read([
        { start: headerBytes + at, end: headerBytes + end },
      ]);
      crc = crc32(chunk as Uint8Array, crc);
    } catch {
      return null;
    }
  }
  return crc;
}

/**
 * 파일 위치 `[start, end)`의 평문을 `Blob`으로 만든다. `CHUNK_BYTES`씩 읽어 조각 `Blob`으로 모은다.
 * 읽지 못하면 거부(reject)한다. 호출자가 `read-failed`로 바꾼다.
 */
export async function plainBlob(
  reader: RangeReader,
  start: number,
  end: number,
): Promise<Blob> {
  const parts: Blob[] = [];
  for (let at = start; at < end; at += CHUNK_BYTES) {
    const [chunk] = await reader.read([
      { start: at, end: Math.min(at + CHUNK_BYTES, end) },
    ]);
    parts.push(new Blob([blobPartOf(chunk as Uint8Array)]));
  }
  return new Blob(parts);
}
