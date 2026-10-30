// 압축한 ZIP 바이트를 압축 유틸리티로 바로 열지 못하게 섞는다. 암호가 아니다.
// - 목표는 기밀성이 아니다. 복원 규칙이 클라이언트에 있어 분석하면 풀 수 있다.
// - 바이트마다 `치환표[바이트 ^ 키스트림(위치)]`다. 출력 바이트는 입력 바이트와 위치만 따른다.
//   그래서 입력을 나눠 처리해도 한 번에 처리한 결과와 같다. 나눈 조각의 시작 위치를 `offset`으로 넘긴다.
// - 키는 16바이트다. LE uint32 4개로 읽어 0~2번 워드는 키스트림에, 3번 워드는 치환표 시드에 쓴다.
// - 헤더가 키 확인값(키의 CRC32)을 적는다. 열 때 확인값이 같은 키를 고른다.
// - 섞는 범위는 `metadata-scramble.ts`가 정한다. 이 파일은 범위를 모른다.
// - 규칙은 `docs/format.md`의 "scramble"에 있다.
import { crc32 } from "./crc32";

/** scramble 키의 길이(바이트). */
export const SCRAMBLE_KEY_BYTES: number = 16;

/**
 * 기본 scramble 키. `scrambleKey`와 `scrambleKeys`를 비우면 이 키를 쓴다.
 * 키 값은 공개되어도 된다. scramble은 기밀성을 약속하지 않는다.
 */
export const DEFAULT_SCRAMBLE_KEY: Uint8Array = Uint8Array.of(
  0x45,
  0x2d,
  0xc1,
  0xbd,
  0xbf,
  0x5f,
  0x97,
  0x97,
  0x66,
  0xf8,
  0x37,
  0x06,
  0x64,
  0x82,
  0xd4,
  0x7e,
);

/**
 * 코덱이 쓰는 기본 키 사본. 호출자가 내보낸 `DEFAULT_SCRAMBLE_KEY`를 바꿔도 기본 동작이 변하지 않게 한다.
 */
export const DEFAULT_KEY: Uint8Array = DEFAULT_SCRAMBLE_KEY.slice();

/** 키 확인값. 키의 CRC32다. 헤더가 적는다. */
export function keyCheckOf(key: Uint8Array): number {
  return crc32(key);
}

function assertKey(key: unknown, name: string): asserts key is Uint8Array {
  if (!(key instanceof Uint8Array) || key.length !== SCRAMBLE_KEY_BYTES) {
    throw new RangeError(
      `${name}는 길이 ${SCRAMBLE_KEY_BYTES}의 Uint8Array여야 한다`,
    );
  }
}

/** 인코딩 키가 잘못되면 던진다. 호출자 버그다. */
export function assertScrambleKey(key: unknown): asserts key is Uint8Array {
  assertKey(key, "scrambleKey");
}

/**
 * 디코딩 키 목록이 잘못되면 던진다. 호출자 버그다.
 * - 배열이고 비어 있지 않아야 한다.
 * - 키마다 길이 16의 `Uint8Array`여야 한다.
 * - 키 확인값이 같은 키가 둘 이상이면 어느 키로 풀지 정할 수 없어 던진다.
 */
export function assertScrambleKeys(
  keys: unknown,
): asserts keys is readonly Uint8Array[] {
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new RangeError("scrambleKeys는 키가 하나 이상인 배열이어야 한다");
  }
  const seen = new Set<number>();
  for (const key of keys as unknown[]) {
    assertKey(key, "scrambleKeys의 키");
    const check = keyCheckOf(key);
    if (seen.has(check)) {
      throw new RangeError("scrambleKeys에 키 확인값이 같은 키가 둘 이상이다");
    }
    seen.add(check);
  }
}

/** 키 확인값이 `keyCheck`인 키. 없으면 `null`이다. */
export function findKey(
  keys: readonly Uint8Array[],
  keyCheck: number,
): Uint8Array | null {
  return keys.find((key) => keyCheckOf(key) === keyCheck) ?? null;
}

/** 한 키로 섞고 되돌리는 함수 한 쌍. 치환표는 만들 때 한 번 계산한다. */
export interface Scrambler {
  /** `data`를 섞은 새 배열을 돌려준다. `offset`은 `data`가 전체에서 시작하는 위치다. */
  scramble(data: Uint8Array, offset?: number): Uint8Array;

  /** `scramble`을 되돌린다. `offset`의 뜻은 같다. */
  unscramble(data: Uint8Array, offset?: number): Uint8Array;
}

type Words = readonly [number, number, number, number];

/** 시드에서 256칸 1:1 치환표를 만든다. Fisher-Yates를 mulberry32로 돌린다. */
function buildForward(seed: number): Uint8Array {
  const table = Uint8Array.from({ length: 256 }, (_, index) => index);
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let r = Math.imul(state ^ (state >>> 15), 1 | state);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 255; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    const held = table[i] as number;
    table[i] = table[j] as number;
    table[j] = held;
  }
  return table;
}

/** 위치 하나의 키스트림 바이트. 위치만 따르므로 어느 위치에서 시작해도 같다. */
function streamByte(words: Words, position: number): number {
  let x = (position ^ words[0]) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13) ^ words[1], 0xc2b2ae35);
  x ^= x >>> 16;
  x = Math.imul(x ^ words[2], 0x27d4eb2f);
  return (x ^ (x >>> 15)) & 0xff;
}

/** 키로 `Scrambler`를 만든다. 키가 16바이트인지는 호출자가 `assertScrambleKey`로 확인한다. */
export function createScrambler(key: Uint8Array): Scrambler {
  const view = new DataView(key.buffer, key.byteOffset, SCRAMBLE_KEY_BYTES);
  const words: Words = [
    view.getUint32(0, true),
    view.getUint32(4, true),
    view.getUint32(8, true),
    view.getUint32(12, true),
  ];
  const forward = buildForward(words[3]);
  const inverse = new Uint8Array(256);
  forward.forEach((value, index) => {
    inverse[value] = index;
  });
  return {
    scramble(data, offset = 0) {
      const out = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i += 1) {
        out[i] = forward[
          (data[i] as number) ^ streamByte(words, offset + i)
        ] as number;
      }
      return out;
    },
    unscramble(data, offset = 0) {
      const out = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i += 1) {
        out[i] =
          (inverse[data[i] as number] as number) ^
          streamByte(words, offset + i);
      }
      return out;
    },
  };
}
