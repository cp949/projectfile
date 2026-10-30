/**
 * 저장소 루트 `test-vectors/` 시험.
 * 다른 언어 구현이 가져가는 파일이라 두 가지를 고정한다.
 * - `vectors.json`의 기대 값이 `readProjectFileHeader`와 `decodeProjectFile`의 결과와 같다.
 * - 생성 스크립트를 다시 돌린 결과가 커밋된 파일과 바이트까지 같다.
 * 규칙은 `docs/format.md`의 "헤더"와 "검사 순서"에 있다.
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildVectors } from "../scripts/build-vectors.mjs";
import * as lib from "../src/index";
import { crc32 } from "../src/crc32";
import { createScrambler } from "../src/scramble";
import {
  decodeProjectFile,
  readProjectFileHeader,
  type ProjectFileLimits,
} from "../src/index";

const DIR = new URL("../../../test-vectors/", import.meta.url);

type Header =
  | {
      ok: true;
      version: number;
      kind: string;
      payloadLength: number;
      headerBytes: number;
      keyCheck: number;
    }
  | { ok: false; reason: string; version?: number };

type Decoded =
  | {
      ok: true;
      folders: string[];
      entries: { path: string; type: string; text?: string; hex?: string }[];
    }
  | { ok: false; reason: string };

interface Vectors {
  defaultScrambleKey: string;
  defaultScrambleTable: string;
  defaultScrambleStream: string;
  rules: {
    maxPathLength: number;
    maxSegmentLength: number;
    codeRootFiles: string[];
    codeExtensions: string[];
  };
  limits: ProjectFileLimits;
  cases: {
    name: string;
    file: string;
    kind: string;
    scrambleKeys: string[] | null;
    header: Header;
    decode: Decoded;
  }[];
}

const vectors = JSON.parse(
  readFileSync(new URL("vectors.json", DIR), "utf8"),
) as Vectors;

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const fromHex = (text: string) =>
  Uint8Array.from(text.match(/../g) ?? [], (pair) => parseInt(pair, 16));

const rules = {
  maxPathLength: vectors.rules.maxPathLength,
  checkSegment: (_kind: string, segment: string) =>
    segment.length > vectors.rules.maxSegmentLength
      ? ("too-long" as const)
      : null,
  isCode: (path: string) =>
    vectors.rules.codeRootFiles.includes(path) ||
    vectors.rules.codeExtensions.some((ext) =>
      path.toLowerCase().endsWith(ext),
    ),
};

/** `decodeProjectFile`의 성공 결과를 `vectors.json`의 `decode` 모양으로 줄인다. */
async function summarize(
  result: Awaited<ReturnType<typeof decodeProjectFile>>,
): Promise<Decoded> {
  if (!result.ok) return { ok: false, ...result.failure };
  return {
    ok: true,
    folders: result.value.folders,
    entries: await Promise.all(
      result.value.entries.map(async (entry) =>
        entry.type === "text"
          ? { path: entry.path, type: "text", text: entry.data }
          : {
              path: entry.path,
              type: "asset",
              hex: hex(new Uint8Array(await entry.data.arrayBuffer())),
            },
      ),
    ),
  };
}

describe("test-vectors 기대 값", () => {
  it("정상 사례, 헤더 실패 사례, 디코딩 실패 사례를 모두 담는다", () => {
    const names = vectors.cases.map((item) => item.name);

    expect(names).toEqual(
      expect.arrayContaining([
        "default-key",
        "custom-key",
        "kind-length-1",
        "kind-length-64",
        "empty-project",
        "mixed-project",
        "bad-magic",
        "magic-truncated",
        "unsupported-version",
        "kind-length-0",
        "kind-length-65",
        "kind-uppercase",
        "kind-trailing-newline",
        "header-under-22-bytes",
        "header-under-22-plus-n",
        "truncated",
        "appended",
        "scramble-key-mismatch",
        "crc-mismatch",
        "crc-mismatch-local",
        "duplicate-nfc-nfd",
      ]),
    );
    expect(new Set(names).size).toBe(names.length);
  });

  it("기본 키가 공개 상수와 같고 키 확인값은 키의 CRC32다", () => {
    const customCase = vectors.cases.find((item) => item.name === "custom-key");
    const defaultCase = vectors.cases.find(
      (item) => item.name === "default-key",
    );

    expect(vectors.defaultScrambleKey).toBe(hex(lib.DEFAULT_SCRAMBLE_KEY));
    expect(defaultCase?.header).toMatchObject({
      keyCheck: crc32(fromHex(vectors.defaultScrambleKey)),
    });
    expect(customCase?.header).toMatchObject({
      keyCheck: crc32(fromHex(customCase?.scrambleKeys?.[0] ?? "")),
    });
  });

  // `Scrambler`는 치환표와 키스트림을 내보내지 않는다. 섞기 출력 `표[바이트 ^ 키스트림(위치)]`에서 거꾸로 읽는다.
  // - 키스트림 시험은 기대 치환표로, 치환표 시험은 기대 키스트림(0)으로 섞기 출력을 푼다.
  // - 한쪽 값이 틀리면 다른 쪽 시험도 함께 실패할 수 있다.
  // - 표가 `표[y ^ d]`, 키스트림이 `키스트림 ^ d`로 함께 어긋나면 둘 다 통과한다. 이때 섞기 출력은 기대와 같다.
  it("기본 키의 위치 0~15 키스트림이 기대 값과 같다", () => {
    const scrambler = createScrambler(lib.DEFAULT_SCRAMBLE_KEY);
    const table = fromHex(vectors.defaultScrambleTable);

    // 바이트 0을 섞으면 `표[키스트림(위치)]`가 나온다. 기대 치환표에서 그 값의 인덱스가 키스트림이다.
    const actual = Uint8Array.from({ length: 16 }, (_, position) =>
      table.indexOf(
        scrambler.scramble(Uint8Array.of(0), position)[0] as number,
      ),
    );

    expect(hex(actual)).toBe(vectors.defaultScrambleStream);
  });

  it("기본 키의 치환표 256바이트가 기대 값과 같다", () => {
    const scrambler = createScrambler(lib.DEFAULT_SCRAMBLE_KEY);
    const stream0 = fromHex(vectors.defaultScrambleStream)[0] as number;

    // 위치 0에서 `바이트 ^ 키스트림(0)`을 넣으면 섞기 출력이 `표[바이트]`다.
    const actual = Uint8Array.from(
      { length: 256 },
      (_, index) =>
        scrambler.scramble(Uint8Array.of(index ^ stream0), 0)[0] as number,
    );

    expect(hex(actual)).toBe(vectors.defaultScrambleTable);
  });

  it("헤더 단계 실패 사례는 디코딩도 같은 이유로 거부한다", () => {
    const failed = vectors.cases.filter((item) => !item.header.ok);

    expect(failed.length).toBeGreaterThan(0);
    for (const item of failed) expect(item.decode).toEqual(item.header);
  });

  for (const item of vectors.cases) {
    describe(item.name, () => {
      const bytes = () => new Uint8Array(readFileSync(new URL(item.file, DIR)));
      const inputs = [
        ["Uint8Array", () => bytes()],
        ["Blob", () => new Blob([bytes()])],
      ] as const;

      for (const [inputName, input] of inputs) {
        it(`readProjectFileHeader가 ${inputName} 입력에서 기대한 헤더를 돌려준다`, async () => {
          const result = await readProjectFileHeader(input());
          const actual = result.ok
            ? { ok: true, ...result.value }
            : { ok: false, ...result.failure };

          expect(actual).toEqual(item.header);
        });

        it(`decodeProjectFile이 ${inputName} 입력에서 기대한 결과를 돌려준다`, async () => {
          const result = await decodeProjectFile(input(), {
            kind: item.kind,
            rules,
            limits: vectors.limits,
            scrambleKeys: item.scrambleKeys?.map(fromHex),
          });

          expect(await summarize(result)).toEqual(item.decode);
        });
      }
    });
  }
});

describe("test-vectors 생성 결과", () => {
  it("생성 스크립트를 다시 돌린 결과가 커밋된 파일과 바이트까지 같다", async () => {
    const built = await buildVectors(lib);

    expect(built.json).toBe(readFileSync(new URL("vectors.json", DIR), "utf8"));
    for (const [name, bytes] of built.files) {
      expect(hex(new Uint8Array(readFileSync(new URL(name, DIR))))).toBe(
        hex(bytes),
      );
    }
  });

  it("디렉터리에 생성하지 않는 시험 파일이 남아 있지 않다", async () => {
    const built = await buildVectors(lib);
    const onDisk = readdirSync(DIR).filter((name) => name.endsWith(".bin"));

    expect(onDisk.sort()).toEqual([...built.files.keys()].sort());
  });
});
