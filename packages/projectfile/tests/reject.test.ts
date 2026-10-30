/**
 * 프로젝트 파일 거부 시험.
 * 사용자가 고른 파일이 틀려도 던지지 않고 이유를 구분해 돌려준다.
 */
import { strToU8, unzipSync, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { maxProjectFileBytes } from "../src/index";
import { MANIFEST_MAX_BYTES } from "../src/manifest";
import {
  craft,
  declareSize,
  decode,
  encodeBytes,
  flatten,
  KIND,
  LIMITS,
  OTHER_KIND,
  patchZip,
  restoreMetadata,
  richProject,
  value,
  wrap,
  zipWithText,
} from "./helpers";

describe("프로젝트 파일 거부", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("기대한 kind와 다르면 두 방향 모두 거부한다", async () => {
    const first = await encodeBytes(richProject(), KIND);
    const second = await encodeBytes(richProject(), OTHER_KIND);

    expect(await decode(first, OTHER_KIND)).toEqual({
      ok: false,
      failure: { reason: "kind-mismatch" },
    });
    expect(await decode(second, KIND)).toEqual({
      ok: false,
      failure: { reason: "kind-mismatch" },
    });
    expect((await decode(first, KIND)).ok).toBe(true);
    expect((await decode(second, OTHER_KIND)).ok).toBe(true);
  });

  it("manifest 손상 이유를 구분한다: manifest, manifest kind", async () => {
    const reason = async (bytes: Uint8Array) => {
      const result = await decode(bytes);
      return result.ok ? "ok" : result.failure.reason;
    };
    const entries = (manifest: string) =>
      zipSync({ "manifest.json": strToU8(manifest) });

    expect(await reason(wrap(entries("{")))).toBe("manifest-invalid");
    expect(
      await reason(wrap(entries(`{"formatVersion":1,"kind":"${KIND}"}`))),
    ).toBe("manifest-invalid");
    // kind 규칙을 어긴 manifest kind는 헤더와 비교하기 전에 형식 오류다.
    expect(
      await reason(
        craft([{ path: "a.js" }], { manifestKind: KIND.toUpperCase() }),
      ),
    ).toBe("manifest-invalid");
    expect(
      await reason(craft([{ path: "a.js" }], { manifestKind: OTHER_KIND })),
    ).toBe("manifest-kind-mismatch");
  });

  it("manifest에 없는 항목이나 ZIP에 없는 항목을 거부한다", async () => {
    const extra = zipSync({
      "manifest.json": strToU8(
        '{"formatVersion":1,"kind":"example.blocks","files":[]}',
      ),
      "files/a.js": strToU8("x"),
    });
    const missing = zipSync({
      "manifest.json": strToU8(
        '{"formatVersion":1,"kind":"example.blocks","files":[{"path":"a.js","type":"text"}]}',
      ),
    });

    expect(await decode(wrap(extra))).toEqual({
      ok: false,
      failure: { reason: "manifest-invalid" },
    });
    expect(await decode(wrap(missing))).toEqual({
      ok: false,
      failure: { reason: "manifest-invalid" },
    });
  });

  it.each([
    ["JSON이 객체가 아니다", "[]"],
    [
      "formatVersion이 헤더 버전과 다르다",
      '{"formatVersion":2,"kind":"example.blocks","files":[]}',
    ],
    [
      "kind가 규칙을 어긴다",
      '{"formatVersion":1,"kind":"Example.Blocks","files":[]}',
    ],
    [
      "files가 배열이 아니다",
      '{"formatVersion":1,"kind":"example.blocks","files":{}}',
    ],
    [
      "files 항목이 객체가 아니다",
      '{"formatVersion":1,"kind":"example.blocks","files":[1]}',
    ],
    [
      "path가 문자열이 아니다",
      '{"formatVersion":1,"kind":"example.blocks","files":[{"path":1,"type":"text"}]}',
    ],
    [
      "path가 겹친다",
      '{"formatVersion":1,"kind":"example.blocks","files":[{"path":"a.js","type":"text"},{"path":"a.js","type":"text"}]}',
    ],
    [
      "type이 text나 asset이 아니다",
      '{"formatVersion":1,"kind":"example.blocks","files":[{"path":"a.js","type":"binary"}]}',
    ],
  ])(
    "manifest 모양이 틀리면 manifest-invalid로 거부한다: %s",
    async (_title, manifest) => {
      const zip = zipSync({ "manifest.json": strToU8(manifest) });

      expect(await decode(wrap(zip))).toEqual({
        ok: false,
        failure: { reason: "manifest-invalid" },
      });
    },
  );

  it("ZIP 항목 이름이 겹치면 zip-corrupt로 거부한다", async () => {
    const zip = zipSync({
      "manifest.json": strToU8(
        '{"formatVersion":1,"kind":"example.blocks","files":[{"path":"a.js","type":"text"}]}',
      ),
      "files/a.js": strToU8("x"),
      "files/b.js": strToU8("y"),
    });
    // 지역 헤더와 중앙 디렉터리의 `files/b.js`를 `files/a.js`로 바꾼다.
    // 중앙 디렉터리에 같은 이름이 둘이면 목록 단계에서 거부한다.
    const from = strToU8("files/b.js");
    for (let i = 0; i + from.length <= zip.length; i += 1) {
      if (from.every((byte, k) => zip[i + k] === byte)) zip[i + 6] = 0x61;
    }

    expect(await decode(wrap(zip))).toEqual({
      ok: false,
      failure: { reason: "zip-corrupt" },
    });
  });

  it.each([
    ["단독 0xFF", [0xff, 0x41, 0x41]],
    ["잘린 멀티바이트 시퀀스", [0xe2, 0x82, 0x41]],
    ["대리쌍 영역 0xED 0xA0 0x80", [0xed, 0xa0, 0x80]],
  ])(
    "UTF-8 표시가 있어도 이름이 잘못된 UTF-8이면 Blob과 Uint8Array 모두 zip-corrupt로 거부한다: %s",
    async (_title, nameBytes) => {
      // 3바이트 문자(`€`)가 든 이름은 fflate가 UTF-8 표시를 켠다. 로컬 헤더와 중앙 디렉터리의 이름 바이트를 같은 값으로 바꾼다.
      // 로컬 헤더는 이름 길이만 검사하므로 이름 해석을 거부하는 곳은 중앙 디렉터리의 이름이다.
      const zip = zipWithText({ "files/€.txt": strToU8("x") });
      const from = strToU8("files/€.txt");
      for (let i = 0; i + from.length <= zip.length; i += 1) {
        if (from.every((byte, k) => zip[i + k] === byte)) {
          zip.set(nameBytes, i + "files/".length);
        }
      }
      const bytes = wrap(zip);

      const failure = { ok: false, failure: { reason: "zip-corrupt" } };
      expect(await decode(bytes)).toEqual(failure);
      expect(await decode(new Blob([bytes]))).toEqual(failure);
    },
  );

  it("UTF-8 표시가 없으면 올바른 UTF-8인 비 ASCII 이름도 zip-corrupt로 거부한다", async () => {
    const zip = () =>
      zipSync({
        "manifest.json": strToU8(
          `{"formatVersion":1,"kind":"${KIND}","files":[{"path":"€.txt","type":"text"}]}`,
        ),
        "files/€.txt": strToU8("x"),
      });
    // fflate가 켠 UTF-8 표시(비트 11)를 로컬 헤더와 중앙 디렉터리에서 끈다. 이름 바이트는 그대로다.
    const flagless = zip();
    const view = new DataView(flagless.buffer);
    // 서명별 일반 목적 플래그 위치: 로컬 헤더 +6, 중앙 디렉터리 항목 +8.
    const flagsAt = new Map([
      [0x04034b50, 6],
      [0x02014b50, 8],
    ]);
    for (let i = 0; i + 4 <= flagless.length; i += 1) {
      const at = flagsAt.get(view.getUint32(i, true));
      if (at !== undefined) {
        view.setUint16(i + at, view.getUint16(i + at, true) & ~0x0800, true);
      }
    }

    expect(await decode(wrap(flagless))).toEqual({
      ok: false,
      failure: { reason: "zip-corrupt" },
    });
    // 표시가 있으면 같은 이름을 연다. 거부 이유가 이름 바이트가 아니라 표시임을 보인다.
    expect((await decode(wrap(zip()))).ok).toBe(true);
  });

  it.each([
    [
      "선언보다 짧게 풀리는 항목",
      () =>
        declareSize(
          zipWithText({ "files/a.txt": strToU8("x") }),
          "files/a.txt",
          2,
        ),
      "zip-corrupt",
    ],
    [
      "암호화 표시(일반 목적 비트 0)가 켜진 항목",
      () =>
        patchZip((view, eocd) => {
          // 첫 중앙 디렉터리 항목(`manifest.json`)의 일반 목적 플래그는 +8이다.
          const flags = view.getUint32(eocd + 16, true) + 8;
          view.setUint16(flags, view.getUint16(flags, true) | 1, true);
        }),
      "zip-corrupt",
    ],
    [
      "UTF-8이 아닌 텍스트",
      () => zipWithText({ "files/a.txt": new Uint8Array([0xff]) }),
      "zip-corrupt",
    ],
    [
      "선언 크기가 상한을 넘는 manifest",
      () =>
        declareSize(
          zipWithText({ "files/a.txt": strToU8("x") }),
          "manifest.json",
          MANIFEST_MAX_BYTES + 1,
        ),
      "manifest-invalid",
    ],
    [
      "`files/` 밖 폴더 항목",
      () =>
        zipWithText({
          "files/a.txt": strToU8("x"),
          "other/": new Uint8Array(0),
        }),
      "manifest-invalid",
    ],
    [
      "이름 맨 앞에 U+FEFF가 붙은 항목",
      () => zipWithText({ "\uFEFFfiles/a.txt": strToU8("x") }),
      "manifest-invalid",
    ],
  ] as const)("거부한다: %s", async (_title, zip, reason) => {
    expect(await decode(wrap(zip()))).toEqual({
      ok: false,
      failure: { reason },
    });
  });

  // 끝 레코드와 중앙 디렉터리 위치는 복원 단계가 먼저 거부한다(`corrupt.test.ts`).
  // 아래는 복원을 통과한 뒤 ZIP 항목 목록을 읽는 단계의 범위 검사다.
  it.each([
    [
      "로컬 헤더 시그니처가 틀린 ZIP",
      () =>
        patchZip((view) => {
          view.setUint32(0, 0, true);
        }),
    ],
    [
      "압축 크기가 중앙 디렉터리 시작을 넘는 항목",
      () =>
        patchZip((view, eocd) => {
          const centralStart = view.getUint32(eocd + 16, true);
          // 둘째 중앙 디렉터리 항목은 `manifest.json`(이름 13바이트) 뒤다. 압축 크기는 +20이다.
          view.setUint32(centralStart + 46 + 13 + 20, 0x00ffffff, true);
        }),
    ],
  ] as const)(
    "ZIP 항목 범위가 어긋나면 zip-corrupt로 거부한다: %s",
    async (_title, zip) => {
      expect(await decode(wrap(zip()))).toEqual({
        ok: false,
        failure: { reason: "zip-corrupt" },
      });
    },
  );

  it("선언 크기보다 많이 풀리는 deflate 항목을 zip-corrupt로 거부한다", async () => {
    // 0 바이트 20 MiB를 deflate한 항목의 풀린 크기를 1바이트로 선언한다. 선언 크기 한도는 통과한다.
    const zip = declareSize(
      zipWithText({ "files/a.txt": new Uint8Array(20 * 1024 * 1024) }),
      "files/a.txt",
      1,
    );

    expect(await decode(wrap(zip))).toEqual({
      ok: false,
      failure: { reason: "zip-corrupt" },
    });
  });

  it("입력 크기가 상한을 넘으면 읽지 않고 거부한다", async () => {
    // `Blob`은 `Response`로 읽는다(`src/blob.ts`). `Response`가 만들어지면 읽은 것이다.
    const blob = new Blob([]);
    const read = vi.fn();
    class SpyResponse {
      constructor() {
        read();
      }
    }
    Object.defineProperty(blob, "size", {
      value: maxProjectFileBytes(LIMITS) + 1,
    });
    vi.stubGlobal("Response", SpyResponse);

    const result = await decode(blob);

    expect(result).toEqual({
      ok: false,
      failure: {
        reason: "input-too-large",
        maxBytes: maxProjectFileBytes(LIMITS),
      },
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("입력 크기가 상한과 같으면 읽고, 1바이트 넘으면 호출자 한도로 계산한 상한을 담아 거부한다", async () => {
    // 읽기를 실패시킨다. `read-failed`가 나오면 크기 검사를 지나 읽으려 한 것이다.
    class FailingResponse {
      arrayBuffer(): Promise<ArrayBuffer> {
        return Promise.reject(
          new DOMException("읽기 실패", "NotReadableError"),
        );
      }
    }
    vi.stubGlobal("Response", FailingResponse);
    const sized = (size: number) => {
      const blob = new Blob([]);
      Object.defineProperty(blob, "size", { value: size });
      return blob;
    };
    // 기본 시험 한도와 다른 값으로 `maxBytes`가 호출자 한도를 따르는지 본다.
    const limits = { maxUncompressedBytes: 1000 };
    const maxBytes = maxProjectFileBytes({ ...LIMITS, ...limits });

    expect(await decode(sized(maxBytes), KIND, limits)).toEqual({
      ok: false,
      failure: { reason: "read-failed" },
    });
    expect(await decode(sized(maxBytes + 1), KIND, limits)).toEqual({
      ok: false,
      failure: { reason: "input-too-large", maxBytes },
    });
  });

  it("입력을 읽지 못하면 던지지 않고 read-failed를 돌려준다", async () => {
    class FailingResponse {
      arrayBuffer(): Promise<ArrayBuffer> {
        return Promise.reject(
          new DOMException("읽기 실패", "NotReadableError"),
        );
      }
    }
    vi.stubGlobal("Response", FailingResponse);

    expect(await decode(new Blob([]))).toEqual({
      ok: false,
      failure: { reason: "read-failed" },
    });
  });
});

/**
 * manifest 본문 바이트를 JSON으로 읽는 시험.
 * 디코더는 맨 앞 BOM 하나만 무시하고, 올바른 UTF-8만 읽는다. 규칙은 `docs/format.md`의 "ZIP과 manifest"에 있다.
 */
describe("프로젝트 파일 manifest 본문의 BOM과 UTF-8", () => {
  const BOM = [0xef, 0xbb, 0xbf];
  const MANIFEST =
    '{"formatVersion":1,"kind":"example.blocks","files":[{"path":"a.js","type":"text"}]}';

  // 바이트 조각을 이어 manifest 본문으로 삼은 프로젝트 파일을 만든다. 본문 `files/a.js`는 "x"다.
  const withManifest = (...parts: (number[] | Uint8Array)[]) =>
    wrap(
      zipSync({
        "manifest.json": Uint8Array.from(parts.flatMap((part) => [...part])),
        "files/a.js": strToU8("x"),
      }),
    );

  it("맨 앞 BOM 하나는 무시하고 디코딩한다", async () => {
    const result = await decode(withManifest(BOM, strToU8(MANIFEST)));

    expect(await flatten(value(result))).toEqual(["text a.js x"]);
  });

  it("BOM이 둘이면 manifest-invalid다", async () => {
    expect(await decode(withManifest(BOM, BOM, strToU8(MANIFEST)))).toEqual({
      ok: false,
      failure: { reason: "manifest-invalid" },
    });
  });

  it("JSON 중간이나 끝의 U+FEFF는 JSON 문법 위반이라 manifest-invalid다", async () => {
    const middle = MANIFEST.replace('"kind"', '\uFEFF"kind"');

    expect(await decode(withManifest(strToU8(middle)))).toEqual({
      ok: false,
      failure: { reason: "manifest-invalid" },
    });
    expect(await decode(withManifest(strToU8(MANIFEST), BOM))).toEqual({
      ok: false,
      failure: { reason: "manifest-invalid" },
    });
  });

  it("JSON 문자열 안의 U+FEFF는 JSON이 허용하므로 경로의 일부로 읽는다", async () => {
    const path = "a\uFEFF.js";
    const manifest = MANIFEST.replace("a.js", path);
    const bytes = wrap(
      zipSync({
        "manifest.json": strToU8(manifest),
        [`files/${path}`]: strToU8("x"),
      }),
    );

    expect(await flatten(value(await decode(bytes)))).toEqual([
      `text ${path} x`,
    ]);
  });

  it("올바른 UTF-8이 아닌 manifest는 U+FFFD로 바꿔 읽지 않고 manifest-invalid다", async () => {
    // 경로의 `FF` 바이트를 U+FFFD로 바꿔 읽으면 ZIP 항목 `files/a\uFFFD.js`와 맞아 성공한다.
    const [before, after] = MANIFEST.split("a.js");
    const bytes = wrap(
      zipSync({
        "manifest.json": Uint8Array.from([
          ...strToU8(`${before}a`),
          0xff,
          ...strToU8(`.js${after}`),
        ]),
        "files/a\uFFFD.js": strToU8("x"),
      }),
    );

    expect(await decode(bytes)).toEqual({
      ok: false,
      failure: { reason: "manifest-invalid" },
    });
  });

  it("인코딩은 manifest 앞에 BOM을 쓰지 않는다", async () => {
    const { zip } = restoreMetadata(await encodeBytes(richProject(), KIND));
    const manifest = unzipSync(zip)["manifest.json"]!;

    expect(Array.from(manifest.subarray(0, 3))).not.toEqual(BOM);
    expect(manifest[0]).toBe("{".charCodeAt(0));
  });
});
