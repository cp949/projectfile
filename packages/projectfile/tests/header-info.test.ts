/**
 * `readProjectFileHeader` 시험.
 * 키 없이 헤더만 읽고, `Blob` 입력은 앞 86바이트까지만 읽는다.
 * 실패 이유는 `decodeProjectFile`의 같은 단계와 같다.
 * 규칙은 `docs/format.md`의 "헤더"와 "검사 순서"에 있다.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { MAX_HEADER_BYTES, readProjectFileHeader } from "../src/index";
import { DEFAULT_KEY, keyCheckOf } from "../src/scramble";
import {
  decode,
  encodeBytes,
  headerBytesOf,
  KIND,
  noise,
  richProject,
} from "./helpers";

describe("readProjectFileHeader", () => {
  let good: Uint8Array<ArrayBuffer>;
  beforeAll(async () => {
    good = await encodeBytes(richProject());
  });

  /** 복사본의 바이트를 고친다. `[위치, 값]` 목록이다. */
  const patched = (...edits: [number, number][]) => {
    const copy = good.slice();
    for (const [index, byte] of edits) copy[index] = byte;
    return copy;
  };

  it("MAX_HEADER_BYTES는 kind가 가장 긴 헤더 길이 86이다", () => {
    expect(MAX_HEADER_BYTES).toBe(86);
  });

  it("정상 파일에서 버전, kind, payload 길이, 헤더 길이, 키 확인값을 돌려준다", async () => {
    const expected = {
      ok: true,
      value: {
        version: 1,
        kind: KIND,
        payloadLength: good.length - headerBytesOf(),
        headerBytes: headerBytesOf(),
        keyCheck: keyCheckOf(DEFAULT_KEY),
      },
    };

    expect(await readProjectFileHeader(good)).toEqual(expected);
    expect(await readProjectFileHeader(new Blob([good]))).toEqual(expected);
  });

  it("사용처 키로 만든 파일도 키 없이 읽고 키 확인값만 다르다", async () => {
    const key = noise(16);
    const custom = await encodeBytes(richProject(), KIND, key);
    const base = await readProjectFileHeader(good);
    if (!base.ok) throw new Error("기본 키 파일의 헤더를 읽지 못했다");

    expect(await readProjectFileHeader(custom)).toEqual({
      ok: true,
      value: { ...base.value, keyCheck: keyCheckOf(key) },
    });
    expect(keyCheckOf(key)).not.toBe(base.value.keyCheck);
  });

  it("kind 길이 1과 64의 헤더 길이를 22 + N으로 돌려준다", async () => {
    for (const kind of ["a", "a".repeat(64)]) {
      const bytes = await encodeBytes({ entries: [], folders: [] }, kind);

      expect(await readProjectFileHeader(bytes)).toMatchObject({
        ok: true,
        value: { kind, headerBytes: 22 + kind.length },
      });
    }
  });

  it("Blob 입력은 앞 86바이트까지만 읽는다", async () => {
    const blob = new Blob([good]);
    const sliced: [number, number][] = [];
    const slice = blob.slice.bind(blob);
    blob.slice = (start = 0, end = blob.size) => {
      sliced.push([start, end]);
      return slice(start, end);
    };

    const result = await readProjectFileHeader(blob);

    expect(result.ok).toBe(true);
    expect(good.length).toBeGreaterThan(MAX_HEADER_BYTES);
    expect(sliced).toEqual([[0, MAX_HEADER_BYTES]]);
  });

  it("payload와 CRC는 보지 않는다. 헤더만 맞으면 성공한다", async () => {
    // 헤더 CRC 필드와 섞는 범위 안 바이트를 고친다. decodeProjectFile은 crc-mismatch로 거부한다.
    const broken = patched([10, 0], [headerBytesOf() + 5, 0xff]);

    expect(await readProjectFileHeader(broken)).toMatchObject({ ok: true });
    expect(await decode(broken)).toEqual({
      ok: false,
      failure: { reason: "crc-mismatch" },
    });
  });

  it("읽지 못하는 Blob은 read-failed다", async () => {
    const blob = new Blob([good]);
    blob.slice = () => {
      throw new Error("읽기 실패");
    };

    expect(await readProjectFileHeader(blob)).toEqual({
      ok: false,
      failure: { reason: "read-failed" },
    });
  });

  // 헤더 단계 실패는 decodeProjectFile과 같은 이유여야 한다. 두 함수가 어긋나면 서버가 받은 파일을 클라이언트가 거부한다.
  describe("실패 이유가 decodeProjectFile의 같은 단계와 같다", () => {
    const withUint32 = (at: number, value: number) => {
      const copy = good.slice();
      new DataView(copy.buffer).setUint32(at, value, true);
      return copy;
    };
    // `good`는 beforeAll 뒤에 생기므로 입력은 시험 안에서 만든다.
    const cases: [string, () => Uint8Array<ArrayBuffer>, string][] = [
      ["magic이 틀림", () => patched([0, 0x58]), "bad-magic"],
      ["4바이트가 안 됨", () => good.slice(0, 3), "bad-magic"],
      ["빈 입력", () => new Uint8Array(0), "bad-magic"],
      ["22바이트 미만", () => good.slice(0, 21), "length-mismatch"],
      ["모르는 버전", () => patched([4, 9]), "unsupported-version"],
      ["kind 길이 0", () => patched([5, 0]), "kind-invalid"],
      ["kind 길이 65", () => patched([5, 65]), "kind-invalid"],
      ["22 + N 미만", () => good.slice(0, 25), "length-mismatch"],
      ["kind 대문자", () => patched([22, 0x45]), "kind-invalid"],
      [
        "kind 끝 줄바꿈",
        () => patched([22 + KIND.length - 1, 0x0a]),
        "kind-invalid",
      ],
      ["잘림", () => good.slice(0, good.length - 1), "length-mismatch"],
      ["덧붙음", () => Uint8Array.from([...good, 0]), "length-mismatch"],
      [
        "payload 길이 필드가 큼",
        () => withUint32(6, 2 ** 32 - 1),
        "length-mismatch",
      ],
    ];

    it.each(cases)("%s", async (_title, make, reason) => {
      const bytes = make();
      const decoded = await decode(bytes);
      const fromBytes = await readProjectFileHeader(bytes);
      const fromBlob = await readProjectFileHeader(new Blob([bytes]));

      expect(decoded.ok).toBe(false);
      expect(fromBytes).toEqual(decoded);
      expect(fromBlob).toEqual(decoded);
      expect(!fromBytes.ok && fromBytes.failure.reason).toBe(reason);
    });
  });
});
