/**
 * 프로젝트 파일 구조 시험.
 * 서버가 읽는 헤더 위치, scramble의 청크 불변 성질, asset 비압축을 고정한다.
 * 규칙은 `docs/format.md`의 "헤더"에 있다.
 */
import { describe, expect, it } from "vitest";
import { crc32 } from "../src/crc32";
import { DEFAULT_SCRAMBLE_KEY } from "../src/index";
import { createScrambler } from "../src/scramble";
import {
  baseEntries,
  encodeBytes,
  headerBytesOf,
  KIND,
  noise,
  type Project,
  restoreMetadata,
  richProject,
} from "./helpers";

describe("프로젝트 파일 구조", () => {
  it("헤더가 magic, 버전, kind 길이, payload 길이, CRC32, centralStart, 키 확인값, kind 문자열 자리에 있다", async () => {
    const bytes = await encodeBytes(richProject());
    const view = new DataView(bytes.buffer);
    const { crc, centralStart } = restoreMetadata(bytes);

    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("OCOD");
    expect(bytes[4]).toBe(1);
    expect(bytes[5]).toBe(KIND.length);
    expect(view.getUint32(6, true)).toBe(bytes.length - headerBytesOf());
    expect(view.getUint32(10, true)).toBe(crc);
    expect(view.getUint32(14, true)).toBe(centralStart);
    expect(view.getUint32(18, true)).toBe(crc32(DEFAULT_SCRAMBLE_KEY));
    expect(new TextDecoder().decode(bytes.subarray(22, 22 + KIND.length))).toBe(
      KIND,
    );
  });

  it("헤더 길이는 22 + kind 길이이고 kind 길이 64의 헤더는 86바이트다", async () => {
    const kind = "k".repeat(64);
    const bytes = await encodeBytes(richProject(), kind);
    const payloadLength = new DataView(bytes.buffer).getUint32(6, true);

    expect(bytes.length - payloadLength).toBe(86);
    expect(bytes[5]).toBe(64);
  });

  it("scrambleKey를 주면 헤더의 키 확인값이 그 키의 CRC32다", async () => {
    const key = noise(16);

    const bytes = await encodeBytes(richProject(), KIND, key);

    expect(new DataView(bytes.buffer).getUint32(18, true)).toBe(crc32(key));
    expect(crc32(key)).not.toBe(crc32(DEFAULT_SCRAMBLE_KEY));
  });

  it("scramble은 입력을 둘로 나눠 이어 처리해도 한 번에 처리한 결과와 같다", () => {
    const data = noise(1000);
    const scrambler = createScrambler(noise(16));
    const whole = scrambler.scramble(data);
    const head = scrambler.scramble(data.subarray(0, 333), 0);
    const tail = scrambler.scramble(data.subarray(333), 333);

    expect([...head, ...tail]).toEqual([...whole]);
    expect(scrambler.unscramble(whole)).toEqual(data);
  });

  it("asset은 압축하지 않아 출력이 입력 크기에 고정 오버헤드를 더한 값 이하다", async () => {
    const size = 100_000;
    for (const content of [noise(size), new Uint8Array(size)]) {
      const project: Project = {
        folders: [],
        entries: [
          ...baseEntries(),
          { path: "x.png", type: "asset", data: new Blob([content]) },
        ],
      };
      const initial = (
        await encodeBytes({ folders: [], entries: baseEntries() })
      ).length;

      const length = (await encodeBytes(project)).length;

      // 0으로 채운 asset도 줄지 않는다.
      expect(length - initial).toBeGreaterThanOrEqual(size);
      expect(length - initial).toBeLessThanOrEqual(size + 512);
    }
  });
});
