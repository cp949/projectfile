/**
 * CRC32 구현 시험.
 * 구현이 블록 단위로 읽는 경로와 꼬리 경로를 모두 지나도록 길이, 시작 위치, 분할 위치를 바꿔
 * 시험 안의 비트 단위 참조 구현과 비교한다.
 */
import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { crc32 } from "../src/crc32";
import { noise } from "./helpers";

/** 표 없이 비트마다 계산하는 참조 구현. 느리지만 구현이 단순해 기준으로 쓴다. */
function referenceCrc32(data: Uint8Array, previous = 0): number {
  let crc = (previous ^ 0xffffffff) >>> 0;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// 8바이트 블록 경계의 앞뒤와 표 크기(256) 근처, 여러 블록에 걸치는 길이를 고른다.
const LARGE_LENGTHS = [
  63, 64, 65, 127, 128, 129, 255, 256, 257, 1000, 4095, 4096, 4097, 65535,
  65536, 65537,
];

describe("CRC32", () => {
  it("표준 값을 돌려준다", () => {
    expect(crc32(strToU8("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it("길이 0부터 40까지 참조 구현과 같다", () => {
    const data = noise(40);

    for (let length = 0; length <= 40; length += 1) {
      const part = data.subarray(0, length);
      expect(crc32(part), `길이 ${length}`).toBe(referenceCrc32(part));
    }
  });

  it("큰 길이도 참조 구현과 같다", () => {
    const data = noise(Math.max(...LARGE_LENGTHS));

    for (const length of LARGE_LENGTHS) {
      const part = data.subarray(0, length);
      expect(crc32(part), `길이 ${length}`).toBe(referenceCrc32(part));
    }
  });

  it("0xff와 0x00만 있는 입력도 참조 구현과 같다", () => {
    for (const fill of [0x00, 0xff]) {
      for (const length of [1, 7, 8, 9, 64, 1000]) {
        const part = new Uint8Array(length).fill(fill);
        expect(crc32(part), `채움 ${fill} 길이 ${length}`).toBe(
          referenceCrc32(part),
        );
      }
    }
  });

  it("byteOffset이 0이 아닌 subarray도 같은 값을 돌려준다", () => {
    const backing = noise(200);

    for (let offset = 0; offset <= 9; offset += 1) {
      for (const length of [0, 1, 7, 8, 9, 15, 16, 17, 100]) {
        const view = backing.subarray(offset, offset + length);
        const copy = new Uint8Array(view);
        expect(view.byteOffset).toBe(offset);
        expect(crc32(view), `시작 ${offset} 길이 ${length}`).toBe(
          referenceCrc32(copy),
        );
      }
    }
  });

  it("입력을 임의 위치에서 둘로 나눠 이어 계산해도 한 번에 계산한 값과 같다", () => {
    const data = noise(100);
    const whole = crc32(data);

    for (let split = 0; split <= data.length; split += 1) {
      const head = crc32(data.subarray(0, split));
      expect(crc32(data.subarray(split), head), `분할 ${split}`).toBe(whole);
    }
  });

  it("큰 입력도 블록 경계가 아닌 위치에서 나눠 이어 계산할 수 있다", () => {
    const data = noise(70000);
    const whole = crc32(data);

    for (const split of [1, 7, 8, 9, 4093, 4096, 33333, 69999]) {
      const head = crc32(data.subarray(0, split));
      expect(crc32(data.subarray(split), head), `분할 ${split}`).toBe(whole);
    }
  });

  it("여러 조각으로 나눠 이어 계산해도 같다", () => {
    const data = noise(1000);
    let crc = 0;

    for (let start = 0; start < data.length; start += 13) {
      crc = crc32(data.subarray(start, start + 13), crc);
    }

    expect(crc).toBe(referenceCrc32(data));
  });
});
