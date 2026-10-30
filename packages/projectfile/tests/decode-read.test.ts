/**
 * 디코딩의 읽기 방식 시험.
 * `Blob` 입력은 필요한 범위만 묶어 읽고 asset 본문은 읽지 않는다. 디코딩한 asset은 `Blob`이다.
 * `Uint8Array` 입력은 풀어도 바뀌지 않는다.
 * 규칙은 `docs/format.md`의 "검사 순서"에 있다.
 */
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_PARALLEL_READS } from "../src/read-range";
import {
  baseEntries,
  craft,
  declareCompressedSize,
  decode,
  encodeBytes,
  headerBytesOf,
  KIND,
  noise,
  type Project,
  richProject,
  value,
  wrap,
  zipEntriesOf,
  zipWithText,
} from "./helpers";

type Range = readonly [start: number, end: number];

/**
 * 입력 `Blob`의 `slice`와 `Response` 읽기를 기록하는 입력을 만든다.
 * - `slices`: `slice`가 돌려준 `Blob`과 요청한 범위. asset 출력도 여기에 든다.
 * - `reads`: `Response`로 읽은 범위. 읽기 호출 하나가 항목 하나다.
 */
function traceBlob(bytes: Uint8Array<ArrayBuffer>) {
  const blob = new Blob([bytes]);
  // 입력 전체를 슬라이스 없이 읽어도 기록하도록 입력 자신도 전체 범위로 넣는다.
  const slices = new Map<Blob, Range>([[blob, [0, blob.size]]]);
  const reads: Range[] = [];
  const slice = blob.slice.bind(blob);
  blob.slice = (start = 0, end = blob.size) => {
    const part = slice(start, end);
    slices.set(part, [start, end]);
    return part;
  };
  const RealResponse = Response;
  vi.stubGlobal(
    "Response",
    class extends RealResponse {
      constructor(body?: BodyInit | null) {
        super(body);
        const range = body instanceof Blob ? slices.get(body) : undefined;
        if (range !== undefined) reads.push(range);
      }
    },
  );
  return { blob, slices, reads };
}

const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

/** 파일 안에서 asset 본문이 차지하는 범위. */
function assetRanges(bytes: Uint8Array): Range[] {
  return zipEntriesOf(bytes)
    .filter((entry) => entry.method === 0 && entry.size > 0)
    .filter((entry) => !entry.name.endsWith("/"))
    .filter((entry) => entry.name !== "manifest.json")
    .map(
      (entry) =>
        [
          headerBytesOf() + entry.dataStart,
          headerBytesOf() + entry.dataStart + entry.compressedSize,
        ] as const,
    );
}

/** 텍스트와 asset이 번갈아 나오는 프로젝트. asset 사이에 텍스트가 끼어 읽기가 끊긴다. */
const interleaved = (): Project => ({
  folders: ["a"],
  entries: [
    { path: "a/1.js", type: "text", data: "let one = 1;" },
    { path: "a/1.bin", type: "asset", data: noise(4000) },
    { path: "a/2.js", type: "text", data: "let two = 2;" },
    { path: "a/2.bin", type: "asset", data: new Blob([noise(9000)]) },
    { path: "a/3.js", type: "text", data: "let three = 3;" },
  ],
});

/** 본문이 0바이트인 asset(`Blob`, `Uint8Array`)과 빈 텍스트. 저장 항목의 본문 조각이 없다. */
const emptyBodies = (): Project => ({
  folders: ["e"],
  entries: [
    { path: "a.bin", type: "asset", data: new Blob([]) },
    { path: "b.bin", type: "asset", data: new Uint8Array(0) },
    { path: "c.txt", type: "text", data: "" },
    { path: "e/d.bin", type: "asset", data: noise(5) },
  ],
});

/** 헤더, 중앙 디렉터리, 로컬 헤더와 deflate 본문, 저장한 텍스트 본문까지 모든 읽기를 거치는 파일. */
const everyReadFile = () =>
  wrap(
    zipSync({
      "manifest.json": strToU8(
        '{"formatVersion":1,"kind":"example.blocks","files":[{"path":"a.txt","type":"text"},{"path":"b.txt","type":"text"},{"path":"c.bin","type":"asset"}]}',
      ),
      "files/a.txt": [strToU8("저장한 텍스트"), { level: 0 }],
      "files/b.txt": strToU8("deflate".repeat(20)),
      "files/c.bin": [strToU8("asset"), { level: 0 }],
    }),
  );

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("디코딩한 asset", () => {
  it("Blob이고 입력이 Blob이든 Uint8Array든 내용이 같다", async () => {
    const content = noise(3000);
    const bytes = await encodeBytes({
      folders: [],
      entries: [{ path: "x.bin", type: "asset", data: content }],
    });

    for (const input of [bytes, new Blob([bytes])]) {
      const decoded = value(await decode(input));
      const asset = decoded.entries[0];
      expect(asset?.data).toBeInstanceOf(Blob);
      expect(await bytesOf(asset?.data as Blob)).toEqual(content);
    }
  });

  it("Blob 입력이면 입력의 asset 본문 범위를 slice한 Blob이다", async () => {
    const bytes = await encodeBytes(interleaved());
    const { blob, slices } = traceBlob(bytes);

    const decoded = value(await decode(blob));

    const assets = decoded.entries.filter((entry) => entry.type === "asset");
    expect(assets).toHaveLength(2);
    expect(assets.map((entry) => slices.get(entry.data as Blob))).toEqual(
      assetRanges(bytes),
    );
  });
});

describe("Blob 입력 읽기", () => {
  it.each([
    ["텍스트와 asset이 섞인 프로젝트", interleaved],
    ["asset과 폴더가 든 프로젝트", richProject],
    ["텍스트만 있는 프로젝트", () => ({ folders: [], entries: baseEntries() })],
    ["본문이 0바이트인 asset과 텍스트가 든 프로젝트", emptyBodies],
  ])(
    "%s: 읽기 호출이 항목 수 + 2 이하이고 asset 본문을 읽지 않는다",
    async (_title, make) => {
      const bytes = await encodeBytes(make());
      const { blob, reads } = traceBlob(bytes);

      expect((await decode(blob)).ok).toBe(true);

      expect(reads.length).toBeLessThanOrEqual(zipEntriesOf(bytes).length + 2);
      for (const [assetStart, assetEnd] of assetRanges(bytes)) {
        for (const [start, end] of reads) {
          expect(end <= assetStart || start >= assetEnd).toBe(true);
        }
      }
    },
  );

  it("텍스트만 있으면 헤더, 중앙 디렉터리, 나머지 한 덩어리로 세 번에 읽는다", async () => {
    const bytes = await encodeBytes({ folders: [], entries: baseEntries() });
    const { blob, reads } = traceBlob(bytes);

    expect((await decode(blob)).ok).toBe(true);

    expect(reads).toHaveLength(3);
  });

  it("끝 레코드 항목 수가 상한을 넘으면 헤더와 중앙 디렉터리만 읽고 zip-corrupt다", async () => {
    // richProject는 ZIP 항목이 12개다. 상한은 1 + 1 + 2 = 4다.
    const { blob, reads } = traceBlob(await encodeBytes(richProject()));

    expect(await decode(blob, KIND, { maxFiles: 1, maxFolders: 1 })).toEqual({
      ok: false,
      failure: { reason: "zip-corrupt" },
    });

    expect(reads).toHaveLength(2);
  });

  it("저장(방식 0)한 텍스트 본문도 읽고, 읽기 호출은 항목 수 + 저장 텍스트 수 + 2 이하다", async () => {
    const names = ["a.txt", "b.txt", "c.txt"];
    const zip = zipSync({
      "manifest.json": strToU8(
        JSON.stringify({
          formatVersion: 1,
          kind: "example.blocks",
          files: names.map((path) => ({ path, type: "text" })),
        }),
      ),
      ...Object.fromEntries(
        names.map((path) => [
          `files/${path}`,
          [strToU8(`저장한 ${path}`), { level: 0 }],
        ]),
      ),
    });
    const bytes = wrap(zip);
    const { blob, reads } = traceBlob(bytes);

    for (const input of [bytes, blob]) {
      const decoded = value(await decode(input));
      expect(decoded.entries).toEqual(
        names.map((path) => ({ path, type: "text", data: `저장한 ${path}` })),
      );
    }
    // 저장 텍스트 본문 사이에 다음 로컬 헤더가 있어 묶이지 않는다. 텍스트마다 한 번씩 더 읽는다.
    expect(reads.length).toBeGreaterThan(zipEntriesOf(bytes).length + 2);
    expect(reads.length).toBeLessThanOrEqual(
      zipEntriesOf(bytes).length + names.length + 2,
    );
  });

  it("압축 크기를 0으로 선언한 deflate 텍스트도 다시 읽고, 읽기 호출은 항목 수 + 다시 읽는 텍스트 수 + 2 이하다", async () => {
    // 열기는 deflate 본문을 압축 크기만큼 늘려 읽는다. 크기가 0이면 늘릴 본문이 없어 이 텍스트 본문은 열기 결과에 없다.
    const names = ["a.txt", "b.txt", "c.txt"];
    const zip = zipSync({
      "manifest.json": strToU8(
        JSON.stringify({
          formatVersion: 1,
          kind: "example.blocks",
          files: names.map((path) => ({ path, type: "text" })),
        }),
      ),
      ...Object.fromEntries(
        names.map((path) => [`files/${path}`, strToU8(`deflate ${path}`)]),
      ),
    });
    for (const path of names) declareCompressedSize(zip, `files/${path}`, 0);
    const bytes = wrap(zip);
    const { blob, reads } = traceBlob(bytes);

    expect(await decode(blob)).toEqual({
      ok: false,
      failure: { reason: "zip-corrupt" },
    });

    // 하한은 이 파일이 다시 읽기를 거치는지 본다. 길이 0인 범위도 텍스트마다 읽기 호출 하나다.
    expect(reads.length).toBeGreaterThan(zipEntriesOf(bytes).length + 2);
    expect(reads.length).toBeLessThanOrEqual(
      zipEntriesOf(bytes).length + names.length + 2,
    );
  });

  it("어느 읽기가 실패해도 read-failed다", async () => {
    const bytes = everyReadFile();
    const { blob, reads } = traceBlob(bytes);
    expect((await decode(blob)).ok).toBe(true);
    vi.unstubAllGlobals();
    // 헤더, 중앙 디렉터리, 로컬 헤더 묶음, 저장한 텍스트 본문이다.
    expect(reads.length).toBeGreaterThanOrEqual(4);

    for (let failing = 1; failing <= reads.length; failing += 1) {
      const RealResponse = Response;
      let calls = 0;
      vi.stubGlobal(
        "Response",
        class extends RealResponse {
          arrayBuffer(): Promise<ArrayBuffer> {
            calls += 1;
            return calls === failing
              ? Promise.reject(
                  new DOMException("읽기 실패", "NotReadableError"),
                )
              : super.arrayBuffer();
          }
        },
      );

      expect(await decode(new Blob([bytes])), `읽기 ${failing}번`).toEqual({
        ok: false,
        failure: { reason: "read-failed" },
      });
      vi.unstubAllGlobals();
    }
  });

  it("읽은 바이트가 범위보다 짧으면 던지지 않고 read-failed다", async () => {
    const bytes = everyReadFile();
    const { blob, reads } = traceBlob(bytes);
    expect((await decode(blob)).ok).toBe(true);
    vi.unstubAllGlobals();

    // 1바이트 모자란 경우와 로컬 헤더(30바이트)보다 짧아지는 경우다.
    for (const missing of [1, 29]) {
      for (let short = 1; short <= reads.length; short += 1) {
        const RealResponse = Response;
        let calls = 0;
        vi.stubGlobal(
          "Response",
          class extends RealResponse {
            async arrayBuffer(): Promise<ArrayBuffer> {
              // 읽기가 동시에 진행하므로 번호는 기다리기 전에 정한다.
              calls += 1;
              const call = calls;
              const buffer = await super.arrayBuffer();
              return call === short
                ? buffer.slice(0, Math.max(0, buffer.byteLength - missing))
                : buffer;
            }
          },
        );

        expect(
          await decode(new Blob([bytes])),
          `읽기 ${short}번이 ${missing}바이트 모자람`,
        ).toEqual({ ok: false, failure: { reason: "read-failed" } });
        vi.unstubAllGlobals();
      }
    }
  });

  it(`동시에 진행하는 읽기는 ${MAX_PARALLEL_READS}개 이하다`, async () => {
    // asset 본문이 로컬 헤더 사이를 벌려 묶음이 항목마다 하나다.
    const bytes = craft(
      Array.from({ length: 100 }, (_, index) => ({
        path: `${index}.bin`,
        type: "asset" as const,
      })),
    );
    const RealResponse = Response;
    let pending = 0;
    let peak = 0;
    let calls = 0;
    vi.stubGlobal(
      "Response",
      class extends RealResponse {
        async arrayBuffer(): Promise<ArrayBuffer> {
          calls += 1;
          pending += 1;
          peak = Math.max(peak, pending);
          try {
            return await super.arrayBuffer();
          } finally {
            pending -= 1;
          }
        }
      },
    );

    expect((await decode(new Blob([bytes]))).ok).toBe(true);

    expect(calls).toBeGreaterThan(MAX_PARALLEL_READS);
    expect(peak).toBeLessThanOrEqual(MAX_PARALLEL_READS);
  });
});

describe("asset 항목 방식", () => {
  it("asset이 저장(방식 0)이 아니면 zip-corrupt다", async () => {
    const zip = zipSync({
      "manifest.json": strToU8(
        '{"formatVersion":1,"kind":"example.blocks","files":[{"path":"a.bin","type":"asset"}]}',
      ),
      // 기본 수준이면 deflate로 쓴다. Blob 범위가 원본이 아니므로 받을 수 없다.
      "files/a.bin": new Uint8Array(500),
    });
    const bytes = wrap(zip);

    for (const input of [bytes, new Blob([bytes])]) {
      expect(await decode(input)).toEqual({
        ok: false,
        failure: { reason: "zip-corrupt" },
      });
    }
  });
});

describe("텍스트 항목의 압축 크기", () => {
  // 유효한 deflate 스트림은 비어 있을 수 없다. 인코더가 만든 빈 텍스트도 압축 크기가 2다.
  // 압축 크기 0을 선언한 deflate 텍스트는 다시 읽기 시험이 Blob 입력으로 본다. 여기는 선언 크기와 CRC까지 0인 경우다.
  const withEmptyText = (compressedSize?: number) => {
    const zip = zipWithText({ "files/a.txt": strToU8("") });
    if (compressedSize !== undefined) {
      declareCompressedSize(zip, "files/a.txt", compressedSize);
    }
    return wrap(zip);
  };

  it("압축 크기를 고치지 않은 빈 deflate 텍스트는 압축 크기가 2이고 Blob과 Uint8Array 모두 빈 텍스트로 풀린다", async () => {
    const bytes = withEmptyText();
    const text = zipEntriesOf(bytes).find(
      (entry) => entry.name === "files/a.txt",
    );
    expect(text).toMatchObject({ method: 8, compressedSize: 2, size: 0 });

    for (const input of [bytes, new Blob([bytes])]) {
      expect(value(await decode(input)).entries).toEqual([
        { path: "a.txt", type: "text", data: "" },
      ]);
    }
  });

  it("저장(방식 0)한 빈 텍스트는 압축 크기가 0이어도 Blob과 Uint8Array 모두 빈 텍스트로 풀린다", async () => {
    const bytes = wrap(
      zipWithText({ "files/a.txt": [strToU8(""), { level: 0 }] }),
    );
    const text = zipEntriesOf(bytes).find(
      (entry) => entry.name === "files/a.txt",
    );
    expect(text).toMatchObject({ method: 0, compressedSize: 0 });

    for (const input of [bytes, new Blob([bytes])]) {
      expect(value(await decode(input)).entries).toEqual([
        { path: "a.txt", type: "text", data: "" },
      ]);
    }
  });

  it("압축 크기·선언 크기·CRC가 모두 0인 deflate 텍스트는 zip-corrupt다", async () => {
    const bytes = withEmptyText(0);

    for (const input of [bytes, new Blob([bytes])]) {
      expect(await decode(input)).toEqual({
        ok: false,
        failure: { reason: "zip-corrupt" },
      });
    }
  });
});

describe("Uint8Array 입력", () => {
  // 성공 경로의 불변은 metadata.test.ts가 본다. 여기는 복원 도중에 거부하는 경로다.
  it("CRC가 틀려 거부해도 입력이 바뀌지 않는다", async () => {
    const input = await encodeBytes(interleaved());
    const at = headerBytesOf() + 3;
    input[at] = input[at]! ^ 0xff;
    const before = input.slice();

    expect((await decode(input)).ok).toBe(false);

    expect(input).toEqual(before);
  });
});
