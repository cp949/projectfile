/**
 * 프로젝트 파일 디코딩 검사 순서 시험.
 * 여러 곳이 동시에 틀린 입력에서 처음 걸린 단계의 이유를 돌려주는지 고정한다.
 * 헤더 단계별 순서는 `docs/format.md`의 "검사 순서"에 있다.
 */
import { strToU8 } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import {
  decode,
  encodeBytes,
  headerBytesOf,
  KIND,
  noise,
  richProject,
  wrap,
  zipWithText,
} from "./helpers";

describe("프로젝트 파일 디코딩 검사 순서", () => {
  let good: Uint8Array;
  beforeAll(async () => {
    good = await encodeBytes(richProject());
  });

  const reasonOf = async (
    bytes: Uint8Array,
    keys?: readonly Uint8Array[],
  ): Promise<string> => {
    const result = await decode(bytes, KIND, {}, keys);
    return result.ok ? "ok" : result.failure.reason;
  };
  /** 복사본의 바이트를 고친다. `[위치, 값]` 목록이다. */
  const patched = (...edits: [number, number][]) => {
    const copy = good.slice();
    for (const [index, byte] of edits) copy[index] = byte;
    return copy;
  };
  /** 복사본의 uint32 필드를 고친다. */
  const withUint32 = (at: number, value: number) => {
    const copy = good.slice();
    new DataView(copy.buffer).setUint32(at, value, true);
    return copy;
  };

  it("magic이 틀리면 버전이 틀려도 bad-magic이다. 4바이트가 안 돼도 같다", async () => {
    expect(await reasonOf(patched([0, 0x58], [4, 9]))).toBe("bad-magic");
    expect(await reasonOf(good.subarray(0, 3))).toBe("bad-magic");
  });

  it("22바이트 미만이면 버전이 틀려도 length-mismatch이고 22바이트 이상이면 unsupported-version이다", async () => {
    expect(await reasonOf(patched([4, 9]).subarray(0, 21))).toBe(
      "length-mismatch",
    );
    expect(await decode(patched([4, 9]))).toEqual({
      ok: false,
      failure: { reason: "unsupported-version", version: 9 },
    });
  });

  it.each([0, 65])(
    "kind 길이가 %i이면 파일이 짧아도 kind-invalid다",
    async (length) => {
      expect(await reasonOf(patched([5, length]).subarray(0, 24))).toBe(
        "kind-invalid",
      );
    },
  );

  it("22 + N바이트 미만이면 kind 문자열이 규칙을 어겨도 length-mismatch다", async () => {
    // kind 문자열 첫 바이트를 대문자로 바꾸고 3바이트만 남긴다.
    expect(await reasonOf(patched([22, 0x45]).subarray(0, 25))).toBe(
      "length-mismatch",
    );
  });

  it.each([
    ["대문자", 0x45],
    ["공백", 0x20],
    ["ASCII가 아닌 바이트", 0xc3],
  ])(
    "kind 문자열에 %s가 있으면 payload 길이가 틀려도 kind-invalid다",
    async (_title, byte) => {
      const bytes = patched([22 + 3, byte]);
      new DataView(bytes.buffer).setUint32(6, 1, true);

      expect(await reasonOf(bytes)).toBe("kind-invalid");
    },
  );

  it("기대한 kind와 다르면 payload 길이가 틀려도 kind-mismatch다", async () => {
    const bytes = withUint32(6, 1);

    expect(await decode(bytes, "example.other")).toEqual({
      ok: false,
      failure: { reason: "kind-mismatch" },
    });
  });

  it("전체 크기가 22 + N + payload 길이와 다르면 키가 틀려도 length-mismatch다", async () => {
    const keys = [noise(16)];

    expect(await reasonOf(good.subarray(0, good.length - 1), keys)).toBe(
      "length-mismatch",
    );
    expect(await reasonOf(Uint8Array.from([...good, 0]), keys)).toBe(
      "length-mismatch",
    );
  });

  it("키 확인값과 같은 키가 없으면 CRC가 틀려도 scramble-key-mismatch다", async () => {
    const wrongCrc = withUint32(10, 0);

    expect(await reasonOf(wrongCrc, [noise(16)])).toBe("scramble-key-mismatch");
  });

  it("끝 레코드 항목 수가 상한을 넘으면 로컬 헤더를 읽기 전에 거부하므로 CRC가 틀려도 zip-corrupt다", async () => {
    // richProject는 ZIP 항목이 12개(manifest.json, files/, 폴더 3, 파일 7)다. 상한은 1 + 1 + 2 = 4다.
    const limits = { maxFiles: 1, maxFolders: 1 };
    const wrongCrc = withUint32(10, 0);

    expect(await decode(wrongCrc, KIND, limits)).toEqual({
      ok: false,
      failure: { reason: "zip-corrupt" },
    });
    expect(await decode(good, KIND, limits)).toEqual({
      ok: false,
      failure: { reason: "zip-corrupt" },
    });
    // 상한 안이면 같은 입력이 CRC 단계까지 간다.
    expect(await reasonOf(wrongCrc)).toBe("crc-mismatch");
  });

  it("맞는 키를 찾았고 CRC가 다르면 crc-mismatch다", async () => {
    expect(await reasonOf(withUint32(10, 0))).toBe("crc-mismatch");
    // 헤더 CRC 필드가 같아도 섞는 범위 안 바이트가 다르면 거부한다(`corrupt.test.ts`가 범위를 훑는다).
    expect(await reasonOf(patched([headerBytesOf() + 5, 0xff]))).toBe(
      "crc-mismatch",
    );
  });

  it("ZIP 항목 이름을 해석하지 못하면 CRC가 맞을 때 zip-corrupt이고 CRC가 다르면 crc-mismatch다", async () => {
    // 중앙 디렉터리의 `files/a.txt` 이름 한 바이트를 UTF-8 표시 없는 비 ASCII 바이트로 바꾼다.
    // 이름 해석은 CRC 비교 뒤라서 CRC가 다르면 이름 오류보다 crc-mismatch가 먼저 나와야 한다.
    const zip = zipWithText({ "files/a.txt": strToU8("x") });
    const central = Buffer.from(zip).lastIndexOf("files/a.txt");
    zip[central + "files/".length] = 0xe9;
    const sealed = wrap(zip);
    const wrongCrc = sealed.slice();
    new DataView(wrongCrc.buffer).setUint32(10, 0, true);

    expect(await reasonOf(sealed)).toBe("zip-corrupt");
    expect(await reasonOf(wrongCrc)).toBe("crc-mismatch");
  });
});
