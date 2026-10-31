/**
 * 프로젝트 파일 손상 시험.
 * 메타데이터와 manifest 본문은 헤더 CRC와 범위 검사가, 텍스트 본문은 ZIP 항목 CRC32가 잡는다. asset 본문은 검사하지 않는다.
 */
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { writeHeader } from "../src/header";
import { createScrambler, DEFAULT_KEY, keyCheckOf } from "../src/scramble";
import {
  decode,
  encodeBytes,
  flatten,
  headerBytesOf,
  KIND,
  richProject,
  value,
  zipEntriesOf,
} from "./helpers";

describe("프로젝트 파일 손상", () => {
  const HEADER_BYTES = headerBytesOf();
  const reasonOf = async (bytes: Uint8Array) => {
    const result = await decode(bytes);
    return result.ok ? "ok" : result.failure.reason;
  };
  const flipped = (bytes: Uint8Array, index: number, mask = 0xff) => {
    const copy = bytes.slice();
    copy[index] = copy[index]! ^ mask;
    return copy;
  };
  /** 항목 본문이 파일 안에서 시작하는 위치와 길이. */
  const bodyOf = (bytes: Uint8Array, name: string) => {
    const entry = zipEntriesOf(bytes).find((item) => item.name === name);
    if (entry === undefined) throw new Error(`항목이 없다: ${name}`);
    return {
      at: HEADER_BYTES + entry.dataStart,
      length: entry.compressedSize,
    };
  };

  it("로컬 헤더 한 곳과 중앙 디렉터리·끝 레코드의 어느 한 바이트를 고쳐도 crc-mismatch나 zip-corrupt다", async () => {
    const bytes = await encodeBytes(richProject());
    const centralStart = new DataView(bytes.buffer).getUint32(14, true);
    const positions = [
      ...Array.from({ length: 30 }, (_, k) => HEADER_BYTES + k),
      ...Array.from(
        { length: bytes.length - HEADER_BYTES - centralStart },
        (_, k) => HEADER_BYTES + centralStart + k,
      ),
    ];

    for (const index of positions) {
      expect(["crc-mismatch", "zip-corrupt"]).toContain(
        await reasonOf(flipped(bytes, index)),
      );
    }
  });

  it.each([
    ["deflate한 긴 텍스트", "files/img/big.txt"],
    ["짧은 텍스트", "files/sketch.js"],
  ])(
    "%s 본문의 한 바이트를 같은 길이로 고치면 거부한다",
    async (_title, name) => {
      const bytes = await encodeBytes(richProject());
      const body = bodyOf(bytes, name);

      for (const mask of [0x01, 0xff]) {
        expect(["zip-corrupt", "crc-mismatch"]).toContain(
          await reasonOf(
            flipped(bytes, body.at + Math.floor(body.length / 2), mask),
          ),
        );
      }
    },
  );

  it("manifest 본문의 한 바이트를 고치면 헤더 CRC가 crc-mismatch로 잡는다", async () => {
    const bytes = await encodeBytes(richProject());
    const body = bodyOf(bytes, "manifest.json");

    for (const offset of [0, Math.floor(body.length / 2), body.length - 1]) {
      expect(await reasonOf(flipped(bytes, body.at + offset))).toBe(
        "crc-mismatch",
      );
    }
  });

  it("asset 본문이 고쳐져도 열린다. 열 때 asset 손상은 검사하지 않는다", async () => {
    const project = richProject();
    const bytes = await encodeBytes(project);
    const body = bodyOf(bytes, "files/img/고양이.png");

    const restored = value(await decode(flipped(bytes, body.at + 100)));

    const before = await flatten(project);
    const after = await flatten(restored);
    expect(after.length).toBe(before.length);
    expect(after).not.toEqual(before);
  });

  it("centralStart가 ZIP 밖이거나 끝 레코드와 다르면 zip-corrupt다", async () => {
    const bytes = await encodeBytes(richProject());
    const view = new DataView(bytes.buffer);
    const centralStart = view.getUint32(14, true);
    const payloadLength = bytes.length - HEADER_BYTES;
    const withCentralStart = (value: number) => {
      const copy = bytes.slice();
      new DataView(copy.buffer).setUint32(14, value, true);
      return copy;
    };

    for (const bad of [
      0,
      centralStart - 1,
      centralStart + 1,
      payloadLength - 21,
      payloadLength,
      2 ** 32 - 1,
    ]) {
      expect(await reasonOf(withCentralStart(bad))).toBe("zip-corrupt");
    }
  });

  // 키가 클라이언트에 있어 메타데이터를 조작한 파일도 만들 수 있다. 범위를 정하는 단계가 던지지 않고 거부해야 한다.
  // ZIP 전체를 위치대로 섞어 두면 디코더가 어느 범위를 풀든 평문이 나온다. 헤더 CRC는 보지 않는 값이다.
  // 그래서 범위 검사를 통과한 입력은 `crc-mismatch`가 된다.
  const patchedFile = (
    patch: (view: DataView, central: number[], centralStart: number) => void,
  ) => {
    // 항목 순서: manifest.json(이름 13바이트), files/a.js(10바이트), files/b.js.js(13바이트).
    const zip = zipSync({
      "manifest.json": strToU8("{}"),
      "files/a.js": strToU8("a"),
      "files/b.js.js": strToU8("b"),
    });
    const view = new DataView(zip.buffer);
    const centralStart = view.getUint32(zip.length - 22 + 16, true);
    const central: number[] = [];
    for (let at = centralStart; central.length < 3;) {
      central.push(at);
      at +=
        46 +
        view.getUint16(at + 28, true) +
        view.getUint16(at + 30, true) +
        view.getUint16(at + 32, true);
    }
    patch(view, central, centralStart);
    const file = new Uint8Array(HEADER_BYTES + zip.length);
    file.set(
      writeHeader(
        KIND,
        1,
        zip.length,
        0,
        centralStart,
        keyCheckOf(DEFAULT_KEY),
      ),
      0,
    );
    file.set(createScrambler(DEFAULT_KEY).scramble(zip), HEADER_BYTES);
    return file;
  };

  it.each<
    [string, (view: DataView, central: number[], centralStart: number) => void]
  >([
    [
      "로컬 헤더의 extra 길이가 범위 안이어도 0이 아니면",
      (view, central) => {
        // 마지막 항목이라 extra 1바이트가 본문 안에 머문다. 범위 검사만으로는 거부되지 않는다.
        const last = view.getUint32(central[2]! + 42, true);
        view.setUint16(last + 28, 1, true);
      },
    ],
    [
      "로컬 헤더가 앞 로컬 헤더와 겹치면",
      (view, central) => view.setUint32(central[1]! + 42, 1, true),
    ],
    [
      "마지막 로컬 헤더의 이름이 centralStart를 넘으면",
      (view, central, centralStart) => {
        // 로컬 헤더를 centralStart 30바이트 앞으로 옮기고 이름 길이를 중앙 디렉터리와 맞춘다.
        const moved = centralStart - 30;
        view.setUint32(central[2]! + 42, moved, true);
        view.setUint16(moved + 26, 13, true);
        view.setUint16(moved + 28, 0, true);
      },
    ],
    [
      "중앙 디렉터리의 로컬 헤더 위치가 centralStart를 넘으면",
      (view, central, centralStart) =>
        view.setUint32(central[1]! + 42, centralStart, true),
    ],
    [
      "로컬 헤더의 이름 길이가 중앙 디렉터리와 다르면",
      (view) => view.setUint16(26, 14, true),
    ],
    [
      "끝 레코드의 항목 수가 실제보다 많으면",
      (view) => {
        const eocd = view.byteLength - 22;
        view.setUint16(eocd + 8, 4, true);
        view.setUint16(eocd + 10, 4, true);
      },
    ],
    [
      "끝 레코드 앞에 항목 고정부(46바이트)보다 짧은 꼬리가 서명으로 시작하면",
      (view, central) => {
        // 마지막 항목의 이름 길이를 5로 줄여 끝 레코드 앞 8바이트를 항목 밖에 남기고 거기에 항목 서명을 쓴다.
        // 고정부를 읽기 전에 범위를 보지 않으면 DataView가 끝을 넘어 읽다 던진다.
        view.setUint16(central[2]! + 28, 5, true);
        view.setUint32(central[2]! + 46 + 5, 0x02014b50, true);
        const eocd = view.byteLength - 22;
        view.setUint16(eocd + 8, 4, true);
        view.setUint16(eocd + 10, 4, true);
      },
    ],
    [
      "끝 레코드의 항목 수가 실제보다 적어 마지막 항목이 끝 레코드 앞에 남으면",
      (view) => {
        const eocd = view.byteLength - 22;
        view.setUint16(eocd + 8, 2, true);
        view.setUint16(eocd + 10, 2, true);
      },
    ],
    // 아래 넷은 필드 위치를 리터럴로 적는다. 코덱 상수가 엉뚱한 위치를 읽으면 범위 검사를 통과해 crc-mismatch가 된다.
    [
      "끝 레코드의 디스크 번호가 0이 아니면",
      (view) => view.setUint16(view.byteLength - 22 + 4, 1, true),
    ],
    [
      "끝 레코드의 중앙 디렉터리 시작 디스크 번호가 0이 아니면",
      (view) => view.setUint16(view.byteLength - 22 + 6, 1, true),
    ],
    [
      "중앙 디렉터리 항목의 extra 길이가 뒤따르는 바이트와 맞지 않으면",
      (view, central) => view.setUint16(central[0]! + 30, 1, true),
    ],
    [
      "중앙 디렉터리 항목의 주석 길이가 뒤따르는 바이트와 맞지 않으면",
      (view, central) => view.setUint16(central[0]! + 32, 1, true),
    ],
    [
      "중앙 디렉터리 항목의 서명이 틀리면",
      (view, central) => view.setUint32(central[1]!, 0, true),
    ],
    [
      "중앙 디렉터리의 이름 길이가 범위를 넘으면",
      (view, central) => view.setUint16(central[0]! + 28, 0xffff, true),
    ],
    [
      "마지막 항목인 manifest 본문의 압축 크기가 ZIP 밖까지 가면",
      (view, central) => {
        // manifest가 마지막 로컬 헤더를 가리키게 맞바꾼다. 앞 항목이면 다음 로컬 헤더와의 겹침 검사가 먼저 잡는다.
        // 두 이름이 모두 13바이트라 로컬 헤더의 이름 길이 검사는 통과한다.
        const manifestLocal = view.getUint32(central[0]! + 42, true);
        view.setUint32(
          central[0]! + 42,
          view.getUint32(central[2]! + 42, true),
          true,
        );
        view.setUint32(central[2]! + 42, manifestLocal, true);
        view.setUint32(central[0]! + 20, 0xffffffff, true);
      },
    ],
    [
      "manifest 본문이 다음 로컬 헤더와 겹치면",
      (view, central) => {
        const next = view.getUint32(central[1]! + 42, true);
        // manifest의 본문은 로컬 헤더(30 + 이름 13바이트) 바로 뒤에서 시작한다.
        view.setUint32(central[0]! + 20, next - 43 + 1, true);
      },
    ],
    [
      "manifest 항목이 없으면",
      (view, central) =>
        new Uint8Array(view.buffer).set(
          strToU8("manifest.jsoX"),
          central[0]! + 46,
        ),
    ],
    [
      "manifest 항목이 둘이면",
      (view, central) =>
        new Uint8Array(view.buffer).set(
          strToU8("manifest.json"),
          central[2]! + 46,
        ),
    ],
  ])("%s zip-corrupt다", async (_title, patch) => {
    expect(await reasonOf(patchedFile(patch))).toBe("zip-corrupt");
  });

  it("마지막 로컬 헤더가 centralStart에서 바로 끝나면 범위 검사를 통과해 CRC 비교까지 간다", async () => {
    // 경계(로컬 헤더 끝 = centralStart)를 받는지 본다. 넘을 때 거부하는 쪽은 위 표가 본다.
    // 마지막 항목의 이름 13바이트를 주석으로 돌려 이름 길이를 0으로 만들고 로컬 헤더를 centralStart 30바이트 앞으로 옮긴다.
    // 압축 크기를 0으로 두고 로컬 헤더 서명을 써서 8단계 검사와 섞이지 않게 한다.
    const file = patchedFile((view, central, centralStart) => {
      view.setUint16(central[2]! + 28, 0, true);
      view.setUint16(central[2]! + 32, 13, true);
      view.setUint32(central[2]! + 20, 0, true);
      const moved = centralStart - 30;
      view.setUint32(central[2]! + 42, moved, true);
      view.setUint32(moved, 0x04034b50, true);
      view.setUint16(moved + 26, 0, true);
      view.setUint16(moved + 28, 0, true);
    });

    expect(await reasonOf(file)).toBe("crc-mismatch");
  });

  // 아래 손상은 8단계(ZIP 항목 목록)가 CRC 비교 뒤에 본다. 헤더 CRC가 0이라 CRC 비교에서 먼저 걸려야 한다.
  // 범위 검사를 통과하는 손상이라 CRC가 맞으면 `zip-corrupt`다(`reject.test.ts`).
  it.each<
    [string, (view: DataView, central: number[], centralStart: number) => void]
  >([
    [
      "암호화 표시가 켜진 항목",
      (view, central) =>
        view.setUint16(
          central[1]! + 8,
          view.getUint16(central[1]! + 8, true) | 1,
          true,
        ),
    ],
    [
      "이름이 겹치는 항목",
      (view, central) => {
        // 마지막 항목 이름을 `files/a.js`(10바이트)로 줄이고 남는 3바이트는 주석으로 돌린다.
        // 로컬 헤더의 이름 길이도 맞춰야 7단계를 통과한다.
        view.setUint16(central[2]! + 28, 10, true);
        view.setUint16(central[2]! + 32, 3, true);
        view.setUint8(central[2]! + 46 + 6, 0x61);
        view.setUint16(view.getUint32(central[2]! + 42, true) + 26, 10, true);
      },
    ],
    [
      "로컬 헤더 서명이 틀린 항목",
      (view, central) =>
        view.setUint32(view.getUint32(central[1]! + 42, true), 0, true),
    ],
    [
      "압축 크기가 centralStart를 넘는 항목",
      (view, central) => view.setUint32(central[1]! + 20, 0x00ffffff, true),
    ],
  ])(
    "%s은 CRC가 틀리면 zip-corrupt보다 crc-mismatch가 먼저다",
    async (_title, patch) => {
      expect(await reasonOf(patchedFile(patch))).toBe("crc-mismatch");
    },
  );
});
