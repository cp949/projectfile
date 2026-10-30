/**
 * 프로젝트 파일 scramble 범위 시험.
 * ZIP 메타데이터(로컬 헤더, 중앙 디렉터리, 끝 레코드)와 manifest 본문만 섞는다. 나머지 본문은 섞지 않아 열 때 읽는 양이 준다.
 * 규칙은 `docs/format.md`의 "scramble"에 있다.
 */
import { strToU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { restoreScrambled } from "../src/metadata-scramble";
import { createScrambler, DEFAULT_KEY } from "../src/scramble";
import {
  decode,
  encodeBytes,
  listEntries,
  type Project,
  restoreMetadata,
  richProject,
} from "./helpers";

/** 바이트열에서 조각이 처음 나오는 위치. 없으면 -1이다. */
function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    if (needle.every((byte, k) => haystack[i + k] === byte)) return i;
  }
  return -1;
}

describe("프로젝트 파일: 메타데이터와 manifest 본문만 scramble", () => {
  it("centralStart와 CRC32가 메타데이터 복원 결과와 맞고 복원한 ZIP이 표준 ZIP이다", async () => {
    const bytes = await encodeBytes(richProject());
    const view = new DataView(bytes.buffer);

    const { zip, crc, centralStart } = restoreMetadata(bytes);

    expect(crc).toBe(view.getUint32(10, true));
    expect(centralStart).toBe(view.getUint32(14, true));
    // 끝 레코드가 가리키는 중앙 디렉터리 시작 위치와 헤더가 같다.
    expect(new DataView(zip.buffer).getUint32(zip.length - 22 + 16, true)).toBe(
      centralStart,
    );
    expect(Object.keys(unzipSync(zip))).toContain("manifest.json");
  });

  it("manifest 본문이 stored 블록이어도 파일 이름이 평문으로 보이지 않는다", async () => {
    // 무작위 한글 음절 30자 이름이다. 항목이 하나뿐인 짧은 manifest는 deflate가 stored 블록을 고른다.
    // fflate 0.8.3 기준이다. 버전을 올려 아래 전제 단언이 깨지면 stored 블록이 되는 이름을 다시 고른다.
    const name =
      "뙴뀤훙갋벮뭓떼튣꿃끐퉪퍐붳뾳꺱쫷꿂뾒꼜읎챿왿뻞틳꼂뚌뱹슃챟쨖.js";
    const project: Project = {
      folders: [],
      entries: [{ path: name, type: "text", data: "x" }],
    };
    // kind를 짧게 둔다. manifest가 길면 deflate가 Huffman 블록을 고른다.
    const bytes = await encodeBytes(project, "ex");

    // 전제: 섞기 전 ZIP의 manifest 본문에 이름이 그대로 들어 있다.
    const { zip, centralStart } = restoreMetadata(bytes);
    const manifest = listEntries(zip, centralStart).find(
      (entry) => entry.name === "manifest.json",
    );
    const body = zip.subarray(
      manifest!.dataStart,
      manifest!.dataStart + manifest!.compressedSize,
    );
    expect(indexOfBytes(body, strToU8(name))).not.toBe(-1);

    expect(indexOfBytes(bytes, strToU8(name))).toBe(-1);
    expect((await decode(bytes, "ex")).ok).toBe(true);
  });

  it("ZIP 시그니처와 파일 이름이 평문으로 보이지 않는다", async () => {
    const bytes = await encodeBytes(richProject());
    const signatures = [
      [0x50, 0x4b, 3, 4],
      [0x50, 0x4b, 1, 2],
      [0x50, 0x4b, 5, 6],
    ];
    const names = [
      "manifest.json",
      "files/",
      "index.html",
      "sketch.js",
      "고양이.png",
      "빈폴더",
      "data.json",
      "big.txt",
    ];

    for (const signature of signatures) {
      expect(indexOfBytes(bytes, Uint8Array.from(signature))).toBe(-1);
    }
    for (const name of names) {
      expect(indexOfBytes(bytes, strToU8(name))).toBe(-1);
    }
  });

  it("같은 트리는 같은 바이트가 된다", async () => {
    expect(await encodeBytes(richProject())).toEqual(
      await encodeBytes(richProject()),
    );
  });

  it("호출자가 넘긴 Uint8Array를 바꾸지 않고 연다", async () => {
    const bytes = await encodeBytes(richProject());
    const before = bytes.slice();

    expect((await decode(bytes)).ok).toBe(true);

    expect(bytes).toEqual(before);
  });
});

describe("restoreScrambled", () => {
  it("manifest.json 항목이 없는 로컬 참조는 복원하지 않고 null이다", () => {
    // 이름 1바이트, extra 0바이트인 로컬 헤더다. 공개 API로는 만들 수 없는 입력이라 직접 부른다.
    const plain = new Uint8Array(31);
    new DataView(plain.buffer).setUint16(26, 1, true);
    const scrambler = createScrambler(DEFAULT_KEY);
    const ref = { start: 0, nameLength: 1, method: 0, size: 0 };
    const chunks = [scrambler.scramble(plain, 0)];
    const central = new Uint8Array(22);

    expect(
      restoreScrambled(
        scrambler,
        [{ ...ref, manifest: false }],
        chunks,
        central,
      ),
    ).toBeNull();
    expect(
      restoreScrambled(
        scrambler,
        [{ ...ref, manifest: true }],
        chunks,
        central,
      ),
    ).not.toBeNull();
  });
});
