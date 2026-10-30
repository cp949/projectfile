/**
 * 인코딩이 쓰는 ZIP의 바이트 계약 시험.
 * 항목 순서, 헤더 필드, 압축 방식, CRC32, asset `Blob` 조립을 고정한다.
 * vitest의 node 환경에서 인코딩 결과의 메타데이터를 복원해(`restoreMetadata`) 표준 ZIP으로 읽는다.
 * 규칙은 `docs/format.md`의 "ZIP과 manifest"에 있다.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { crc32 } from "../src/crc32";
import { encodeProjectFile } from "../src/index";
import { inflateEntry } from "../src/zip";
import {
  compressedBytes,
  encodeBytes,
  KIND,
  LIMITS,
  listEntries,
  noise,
  type Project,
  RULES,
  restoreMetadata,
  value,
} from "./helpers";

/** 중앙 디렉터리 항목과 그 항목의 로컬 헤더에서 읽은 필드. 이름에 `local`이 붙은 값이 로컬 헤더다. */
interface RawEntry {
  /** 중앙 디렉터리의 항목 이름 */
  name: string;

  /** 로컬 헤더의 항목 이름 */
  localName: string;

  /** 중앙 디렉터리의 일반 목적 플래그 */
  flags: number;

  /** 로컬 헤더의 일반 목적 플래그 */
  localFlags: number;

  /** 중앙 디렉터리의 압축 방식 번호 */
  method: number;

  /** 로컬 헤더의 압축 방식 번호 */
  localMethod: number;

  /** 중앙 디렉터리의 DOS 시각 */
  time: number;

  /** 중앙 디렉터리의 DOS 날짜 */
  date: number;

  /** 로컬 헤더의 DOS 시각 */
  localTime: number;

  /** 로컬 헤더의 DOS 날짜 */
  localDate: number;

  /** 중앙 디렉터리의 extra 길이 */
  extraLength: number;

  /** 중앙 디렉터리의 주석 길이 */
  commentLength: number;

  /** 로컬 헤더의 extra 길이 */
  localExtraLength: number;

  /** 중앙 디렉터리의 CRC32 */
  crc: number;

  /** 로컬 헤더의 CRC32 */
  localCrc: number;

  /** 중앙 디렉터리의 저장 본문 바이트 수 */
  compressedSize: number;

  /** 로컬 헤더의 저장 본문 바이트 수 */
  localCompressedSize: number;

  /** 중앙 디렉터리의 풀린 본문 바이트 수 */
  size: number;

  /** 로컬 헤더의 풀린 본문 바이트 수 */
  localSize: number;
}

/** 복원한 ZIP의 중앙 디렉터리를 순서대로 읽는다. */
function rawEntries(bytes: Uint8Array): RawEntry[] {
  const { zip, centralStart } = restoreMetadata(bytes);
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const count = view.getUint16(zip.length - 22 + 10, true);
  const out: RawEntry[] = [];
  let at = centralStart;
  for (let index = 0; index < count; index += 1) {
    const nameLength = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const localNameLength = view.getUint16(local + 26, true);
    out.push({
      name: new TextDecoder().decode(
        zip.subarray(at + 46, at + 46 + nameLength),
      ),
      localName: new TextDecoder().decode(
        zip.subarray(local + 30, local + 30 + localNameLength),
      ),
      flags: view.getUint16(at + 8, true),
      localFlags: view.getUint16(local + 6, true),
      method: view.getUint16(at + 10, true),
      localMethod: view.getUint16(local + 8, true),
      time: view.getUint16(at + 12, true),
      date: view.getUint16(at + 14, true),
      localTime: view.getUint16(local + 10, true),
      localDate: view.getUint16(local + 12, true),
      extraLength: view.getUint16(at + 30, true),
      commentLength: view.getUint16(at + 32, true),
      localExtraLength: view.getUint16(local + 28, true),
      crc: view.getUint32(at + 16, true),
      localCrc: view.getUint32(local + 14, true),
      compressedSize: view.getUint32(at + 20, true),
      localCompressedSize: view.getUint32(local + 18, true),
      size: view.getUint32(at + 24, true),
      localSize: view.getUint32(local + 22, true),
    });
    at += 46 + nameLength + out[index]!.extraLength + out[index]!.commentLength;
  }
  return out;
}

const text = (path: string): Project["entries"][number] => ({
  path,
  type: "text",
  data: path,
});

describe("ZIP 항목 순서", () => {
  it("manifest.json, files/, 트리 선행 순회 순서이고 한 폴더 안에서 폴더가 파일보다 앞에 온다", async () => {
    // entries만 보면 d, a, b 순서다. folders의 b, a가 먼저 오고 d가 뒤에 와야 한다.
    const project: Project = {
      folders: ["b", "a"],
      entries: [
        text("z.txt"),
        text("d/w.txt"),
        text("a/x.txt"),
        text("b/q.txt"),
        text("b/c/y.txt"),
        text("m.txt"),
      ],
    };

    const names = rawEntries(await encodeBytes(project)).map((e) => e.name);

    expect(names).toEqual([
      "manifest.json",
      "files/",
      "files/b/",
      "files/b/c/",
      "files/b/c/y.txt",
      "files/b/q.txt",
      "files/a/",
      "files/a/x.txt",
      "files/d/",
      "files/d/w.txt",
      "files/z.txt",
      "files/m.txt",
    ]);
  });

  it("정수처럼 보이는 이름도 입력 순서를 지킨다", async () => {
    const project: Project = {
      folders: [],
      entries: [text("10"), text("2"), text("1")],
    };

    const names = rawEntries(await encodeBytes(project)).map((e) => e.name);

    expect(names.slice(2)).toEqual(["files/10", "files/2", "files/1"]);
  });
});

describe("ZIP 헤더 필드와 압축 방식", () => {
  const project = (): Project => ({
    folders: ["빈폴더"],
    entries: [
      text("a.txt"),
      { path: "한글.png", type: "asset", data: noise(100) },
    ],
  });

  it("모든 항목이 UTF-8 플래그(비트 11)만 켜고 수정 시각이 1980-01-01이며 extra와 주석이 없다", async () => {
    const entries = rawEntries(await encodeBytes(project()));

    expect(entries.length).toBe(5);
    for (const entry of entries) {
      expect(entry.flags, entry.name).toBe(0x0800);
      expect(entry.localFlags, entry.name).toBe(0x0800);
      // DOS 시각 00:00:00, DOS 날짜 1980-01-01
      expect([entry.time, entry.date], entry.name).toEqual([0, 0x0021]);
      expect([entry.localTime, entry.localDate], entry.name).toEqual([
        0, 0x0021,
      ]);
      expect(entry.extraLength, entry.name).toBe(0);
      expect(entry.localExtraLength, entry.name).toBe(0);
      expect(entry.commentLength, entry.name).toBe(0);
    }
  });

  it("로컬 헤더의 이름, 방식, CRC32, 두 크기가 중앙 디렉터리와 같다", async () => {
    const entries = rawEntries(await encodeBytes(project()));

    expect(entries.length).toBe(5);
    for (const entry of entries) {
      expect(
        [
          entry.localName,
          entry.localMethod,
          entry.localCrc,
          entry.localCompressedSize,
          entry.localSize,
        ],
        entry.name,
      ).toEqual([
        entry.name,
        entry.method,
        entry.crc,
        entry.compressedSize,
        entry.size,
      ]);
    }
  });

  it("텍스트와 manifest는 deflate, asset과 폴더는 저장이고 폴더는 본문이 없다", async () => {
    const byName = new Map(
      rawEntries(await encodeBytes(project())).map((e) => [e.name, e]),
    );

    expect(byName.get("manifest.json")?.method).toBe(8);
    expect(byName.get("files/a.txt")?.method).toBe(8);
    expect(byName.get("files/한글.png")?.method).toBe(0);
    for (const folder of ["files/", "files/빈폴더/"]) {
      const entry = byName.get(folder);
      expect([entry?.method, entry?.compressedSize, entry?.size]).toEqual([
        0, 0, 0,
      ]);
    }
  });
});

describe("ZIP 항목 CRC32와 asset 조립", () => {
  // 조각 읽기 단위(1 MiB)를 넘는 크기다. 조각 경계에서 CRC 이어 계산이 틀리면 잡힌다.
  const BIG = 2 * 1024 * 1024 + 17;

  it("항목 CRC32와 크기가 풀린 본문과 맞고 asset 본문이 입력 그대로다", async () => {
    const big = noise(BIG);
    const small = noise(3000);
    const project: Project = {
      folders: [],
      entries: [
        text("a.txt"),
        { path: "big.bin", type: "asset", data: new Blob([big]) },
        { path: "small.bin", type: "asset", data: small },
      ],
    };

    const { zip, centralStart } = restoreMetadata(await encodeBytes(project));

    const entries = new Map(
      listEntries(zip, centralStart).map((e) => [e.name, e]),
    );
    for (const [name, original] of [
      ["files/big.bin", big],
      ["files/small.bin", small],
    ] as const) {
      const entry = entries.get(name)!;
      expect(entry.crc, name).toBe(crc32(original));
      expect(entry.size, name).toBe(original.length);
      expect(inflateEntry(compressedBytes(zip, entry), entry), name).toEqual(
        original,
      );
    }
    const textEntry = entries.get("files/a.txt")!;
    expect(textEntry.crc).toBe(crc32(new TextEncoder().encode("a.txt")));
    expect(inflateEntry(compressedBytes(zip, textEntry), textEntry)).toEqual(
      new TextEncoder().encode("a.txt"),
    );
  });

  it("같은 내용이면 asset이 Blob이든 Uint8Array든 같은 바이트가 된다", async () => {
    const content = noise(BIG);
    const withData = (data: Blob | Uint8Array): Project => ({
      folders: [],
      entries: [{ path: "x.bin", type: "asset", data }],
    });

    const fromBlob = await encodeBytes(withData(new Blob([content])));
    const fromBytes = await encodeBytes(withData(content));

    expect(fromBlob).toEqual(fromBytes);
  });

  describe("asset Blob 읽기 실패", () => {
    /** 크기가 `failingSizes`에 든 `Blob`만 읽기가 거부되도록 `Response`를 바꾼다. 구분은 크기로 한다. */
    const stubUnreadable = (failingSizes: readonly number[]): void => {
      const RealResponse = Response;
      class SelectiveResponse {
        constructor(private readonly body: Blob) {}

        arrayBuffer(): Promise<ArrayBuffer> {
          return failingSizes.includes(this.body.size)
            ? Promise.reject(new DOMException("읽기 실패", "NotReadableError"))
            : new RealResponse(this.body).arrayBuffer();
        }
      }
      vi.stubGlobal("Response", SelectiveResponse);
    };

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("읽지 못한 asset의 경로와 함께 read-failed를 돌려준다", async () => {
      stubUnreadable([7]);

      const result = await encodeProjectFile({
        kind: KIND,
        entries: [
          { path: "ok.bin", type: "asset", data: new Blob([noise(10)]) },
          { path: "img/x.bin", type: "asset", data: new Blob([noise(7)]) },
        ],
        rules: RULES,
        limits: LIMITS,
      });

      expect(result).toEqual({
        ok: false,
        failure: { reason: "read-failed", path: "img/x.bin" },
      });
    });

    it("읽지 못한 asset이 여럿이면 ZIP에 쓰는 순서로 처음 만난 경로를 돌려준다", async () => {
      stubUnreadable([7, 8]);

      // 하위 폴더가 파일보다 먼저 쓰이므로 entries 순서와 다르다.
      const result = await encodeProjectFile({
        kind: KIND,
        entries: [
          { path: "a.bin", type: "asset", data: new Blob([noise(7)]) },
          { path: "dir/b.bin", type: "asset", data: new Blob([noise(8)]) },
        ],
        rules: RULES,
        limits: LIMITS,
      });

      expect(result).toEqual({
        ok: false,
        failure: { reason: "read-failed", path: "dir/b.bin" },
      });
    });

    it("읽을 수 있는 asset과 텍스트만 있으면 기존대로 인코딩한다", async () => {
      stubUnreadable([7]);
      const project: Project = {
        folders: [],
        entries: [
          { path: "ok.bin", type: "asset", data: new Blob([noise(10)]) },
          { path: "t.txt", type: "text", data: "본문" },
        ],
      };

      const bytes = await encodeBytes(project);

      vi.unstubAllGlobals();
      expect(bytes).toEqual(await encodeBytes(project));
    });

    it("이름 검사에서 걸리면 asset을 읽지 않는다", async () => {
      stubUnreadable([7]);

      const result = await encodeProjectFile({
        kind: KIND,
        entries: [
          { path: "bad\\name.bin", type: "asset", data: new Blob([noise(7)]) },
        ],
        rules: RULES,
        limits: LIMITS,
      });

      expect(result).toMatchObject({
        ok: false,
        failure: { reason: "invalid-name" },
      });
    });
  });

  it("입력 Uint8Array asset을 바꾸지 않는다", async () => {
    const content = noise(5000);
    const before = content.slice();

    await encodeBytes({
      folders: [],
      entries: [{ path: "x.bin", type: "asset", data: content }],
    });

    expect(content).toEqual(before);
  });

  it("출력 Blob이 asset Blob을 복사하지 않고 조각으로 그대로 담는다", async () => {
    const asset = new Blob([noise(5000)]);
    const parts: unknown[][] = [];
    const RealBlob = Blob;
    vi.stubGlobal(
      "Blob",
      class extends RealBlob {
        constructor(blobParts?: BlobPart[], options?: BlobPropertyBag) {
          super(blobParts, options);
          parts.push(blobParts ?? []);
        }
      },
    );

    try {
      value(
        await encodeProjectFile({
          kind: "example.blocks",
          entries: [{ path: "x.bin", type: "asset", data: asset }],
          rules: RULES,
          limits: LIMITS,
        }),
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(parts[parts.length - 1]).toContain(asset);
  });
});
