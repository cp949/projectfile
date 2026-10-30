// 포맷의 scramble 범위. ZIP 메타데이터 범위와 manifest 본문만 섞고 나머지 파일 본문은 섞지 않는다.
// - 섞는 범위: 항목마다 로컬 헤더(30바이트 + 이름), `manifest.json` 항목의 본문(압축 바이트),
//   `centralStart`부터 ZIP 끝까지(중앙 디렉터리 + 끝 레코드).
// - manifest 본문을 섞는 이유: 모든 파일 경로가 들어 있다. 짧은 비 ASCII 이름은 deflate가 stored 블록으로 써서 평문이 남는다.
// - 키스트림이 위치만 따르므로 범위마다 `scrambler.scramble(조각, 시작 위치)`로 섞는다. 위치는 ZIP 안 위치다.
// - CRC는 섞기 전 평문의 범위를 ZIP 위치 순서대로 이어서 계산한다. 나머지 본문은 CRC에 들지 않는다.
// - 봉인은 `seal.ts`가 `zip-write.ts`가 표시한 섞는 조각마다 같은 범위를 섞는다. 이 파일은 열 때 범위를 정한다.
// - 열 때는 입력을 고치지 않는다. 읽어 둔 조각마다 `unscramble`이 돌려주는 새 배열이 평문이다.
//   그래서 `Uint8Array` 입력도 복사하지 않고, `Blob` 입력도 섞인 범위만 읽는다. 본문을 읽거나 복사하지 않는 것이 목적이다.
// - 열기는 3단계다. 중앙 디렉터리 레코드에서 로컬 헤더 위치 정하기(`localRefsOf`), 읽을 범위 정하기(`planScrambledRanges`),
//   읽은 조각 복원과 CRC(`restoreScrambled`). 중앙 디렉터리는 `zip.ts`의 `readCentralRecords`가 먼저 한 번 읽고,
//   사이의 읽기는 `seal.ts`의 `openZip`이 한다.
// - 이 코덱이 만든 ZIP만 받는다. 끝 레코드는 ZIP의 마지막 22바이트이고 ZIP 주석이 없다.
// - 로컬 헤더의 extra 길이는 0이다. 그래서 로컬 헤더 범위는 중앙 디렉터리의 이름 길이만으로 정해진다.
// - 규칙은 `docs/format.md`의 "scramble"과 "검사 순서"에 있다.
import { crc32 } from "./crc32";
import { MANIFEST_NAME } from "./manifest";
import type { Scrambler } from "./scramble";
import type { ByteRange } from "./read-range";
import type { CentralRecord } from "./zip";
import {
  LOCAL_BYTES,
  LOCAL_EXTRA_LENGTH_AT,
  LOCAL_NAME_LENGTH_AT,
} from "./zip-layout";

/** 중앙 디렉터리 항목이 가리키는 로컬 헤더. */
export interface LocalRef {
  /** ZIP 안 로컬 헤더 시작 위치. */
  start: number;

  /** 중앙 디렉터리가 적은 이름 길이. 로컬 헤더의 값과 같아야 한다. */
  nameLength: number;

  /** 중앙 디렉터리가 적은 압축 방식. 0은 저장, 8은 deflate다. */
  method: number;

  /** 중앙 디렉터리가 적은 압축 크기. manifest 본문의 길이이고, 열기는 deflate 본문 끝도 이 값으로 정한다. */
  size: number;

  /** 이름이 `manifest.json`인 항목이다. */
  manifest: boolean;
}

/**
 * 중앙 디렉터리 레코드에서 로컬 헤더 위치를 시작 위치 순서로 돌려준다. `records`는 바꾸지 않는다.
 * - `manifest.json` 항목이 하나가 아니면 `null`이다.
 */
export function localRefsOf(
  records: readonly CentralRecord[],
): LocalRef[] | null {
  const manifestName = new TextEncoder().encode(MANIFEST_NAME);
  let manifests = 0;
  const refs = records.map(
    ({ nameBytes, method, compressedSize, localStart }): LocalRef => {
      const manifest =
        nameBytes.length === manifestName.length &&
        manifestName.every((byte, k) => nameBytes[k] === byte);
      if (manifest) manifests += 1;
      return {
        start: localStart,
        nameLength: nameBytes.length,
        method,
        size: compressedSize,
        manifest,
      };
    },
  );
  if (manifests !== 1) return null;
  return refs.sort((a, b) => a.start - b.start);
}

/**
 * 로컬 헤더마다 섞는 범위 `[start, end)`를 정한다. `refs`와 같은 순서다.
 * - 범위는 로컬 헤더(30바이트 + 이름)이고, `manifest.json`이면 바로 뒤의 본문까지다.
 * - 범위가 서로 겹치거나 `centralStart`를 넘으면 `null`이다.
 *   `refs`는 시작 위치 순서여야 한다.
 */
export function planScrambledRanges(
  refs: readonly LocalRef[],
  centralStart: number,
): ByteRange[] | null {
  const ranges: ByteRange[] = [];
  let previousEnd = 0;
  for (const { start, nameLength, size, manifest } of refs) {
    if (start < previousEnd) return null;
    const end = start + LOCAL_BYTES + nameLength + (manifest ? size : 0);
    if (end > centralStart) return null;
    ranges.push({ start, end });
    previousEnd = end;
  }
  return ranges;
}

/** 복원한 로컬 헤더, manifest 본문, 헤더에 적을 CRC. */
export interface RestoredMetadata {
  /** 로컬 헤더 시작 위치별 평문 헤더(30바이트 + 이름). */
  locals: Map<number, Uint8Array>;

  /** manifest 본문(압축 바이트). */
  manifestBody: Uint8Array;

  /** 섞는 범위 전체의 CRC32. 헤더 값과 비교하는 것은 호출자다. */
  crc: number;
}

/**
 * 읽어 둔 섞인 조각을 되돌리고 CRC를 계산한다. 입력 조각은 바꾸지 않는다.
 * - `chunks[i]`는 `planScrambledRanges`가 정한 `i`번째 범위의 섞인 바이트다. 길이가 범위와 같아야 한다.
 * - `central`은 이미 되돌린 평문 중앙 디렉터리와 끝 레코드다.
 * - CRC는 되돌린 범위를 ZIP 위치 순서로 이어서 계산하고, 마지막에 `central`을 잇는다.
 * - 로컬 헤더의 이름 길이가 중앙 디렉터리와 다르거나 extra 길이가 0이 아니면 `null`이다.
 * - `refs`에 `manifest.json` 항목이 없으면 `null`이다. 둘 이상이면 `localRefsOf`가 먼저 거른다.
 */
export function restoreScrambled(
  scrambler: Scrambler,
  refs: readonly LocalRef[],
  chunks: readonly Uint8Array[],
  central: Uint8Array,
): RestoredMetadata | null {
  const locals = new Map<number, Uint8Array>();
  let manifestBody: Uint8Array | null = null;
  let crc = 0;
  for (let index = 0; index < refs.length; index += 1) {
    const { start, nameLength, manifest } = refs[index] as LocalRef;
    const plain = scrambler.unscramble(chunks[index] as Uint8Array, start);
    const view = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
    if (
      view.getUint16(LOCAL_NAME_LENGTH_AT, true) !== nameLength ||
      view.getUint16(LOCAL_EXTRA_LENGTH_AT, true) !== 0
    ) {
      return null;
    }
    crc = crc32(plain, crc);
    locals.set(start, plain.subarray(0, LOCAL_BYTES + nameLength));
    if (manifest) manifestBody = plain.subarray(LOCAL_BYTES + nameLength);
  }
  if (manifestBody === null) return null;
  return { locals, manifestBody, crc: crc32(central, crc) };
}
