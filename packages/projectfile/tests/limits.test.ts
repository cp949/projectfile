/**
 * 프로젝트 파일 한도 시험.
 * 파일 내용을 풀기 전에 선언 크기로 거부한다. ZIP 폭탄이 메모리에 풀리지 않는다.
 */
// 크기를 바꿀 수 있는 `ArrayBuffer`의 타입이다. `tsconfig.json`의 lib(es2022)에 없어서 더한다.
// `src`만 넣는 `tsconfig.build.json`의 lib는 바뀌지 않는다.
/// <reference lib="es2024.arraybuffer" />
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { FORMAT_VERSION_METADATA } from "../src/header";
import {
  decodeProjectFile,
  encodeProjectFile,
  MAX_UNCOMPRESSED_BYTES_CEILING,
  maxProjectFileBytes,
  type ProjectEntry,
  type ProjectFileLimits,
  type ProjectFileRules,
} from "../src/index";
import { MANIFEST_MAX_BYTES, writeManifest } from "../src/manifest";
import {
  craft,
  decode,
  encodeBytes,
  KIND,
  LIMITS,
  noise,
  restoreMetadata,
  richProject,
  RULES,
  wrap,
} from "./helpers";

describe("프로젝트 파일 한도", () => {
  it("ZIP 헤더가 선언한 풀린 크기가 한도를 넘으면 풀기 전에 거부한다", async () => {
    const { zip } = restoreMetadata(await encodeBytes(richProject()));
    // 마지막 중앙 디렉터리 항목(50 4b 01 02)의 풀린 크기 필드(+24)를 1 GiB로 고친다. 실제 데이터는 그대로다.
    let last = -1;
    for (let i = 0; i + 28 < zip.length; i += 1) {
      if (
        zip[i] === 0x50 &&
        zip[i + 1] === 0x4b &&
        zip[i + 2] === 1 &&
        zip[i + 3] === 2
      )
        last = i;
    }
    new DataView(zip.buffer, zip.byteOffset).setUint32(
      last + 24,
      2 ** 30,
      true,
    );

    const result = await decode(wrap(zip));

    // 선언 크기대로 풀었다면 1 GiB 버퍼를 만들다 `zip-corrupt`가 된다.
    expect(result).toMatchObject({
      ok: false,
      failure: { reason: "limit-exceeded" },
    });
  });

  it.each([
    ["maxFiles", { maxFiles: 3 }],
    ["maxAssetBytes", { maxAssetBytes: 2999 }],
    ["maxAssetsTotalBytes", { maxAssetsTotalBytes: 3000 }],
    ["maxCodeBytes", { maxCodeBytes: 29 }],
    ["maxUncompressedBytes", { maxUncompressedBytes: 5000 }],
    // 폴더는 img, 빈폴더, img/깊은 셋이다.
    ["maxFolders", { maxFolders: 2 }],
  ] as const)(
    "호출자가 넘긴 %s를 넘으면 디코딩도 인코딩도 거부한다",
    async (limit, limits) => {
      const project = richProject();
      const bytes = await encodeBytes(project);
      const expected = {
        ok: false,
        failure: { reason: "limit-exceeded", limit },
      };

      expect(await decode(bytes, KIND, limits)).toEqual(expected);
      expect(
        await encodeProjectFile({
          ...project,
          kind: KIND,
          rules: RULES,
          limits: { ...LIMITS, ...limits },
        }),
      ).toEqual(expected);
    },
  );

  it("디코딩은 폴더 항목 없이 경로로만 생기는 조상 폴더도 maxFolders에 센다", async () => {
    const bytes = craft([{ path: "a/b/c.js" }]);

    expect(await decode(bytes, KIND, { maxFolders: 1 })).toEqual({
      ok: false,
      failure: { reason: "limit-exceeded", limit: "maxFolders" },
    });
    expect((await decode(bytes, KIND, { maxFolders: 2 })).ok).toBe(true);
  });

  // 프로젝트는 파일 1개와 폴더 1개다. ZIP 항목은 manifest.json, files/, 폴더, 파일로 4개다.
  it.each([
    [
      "항목 수가 상한과 같고 한도 안이면 통과한다",
      { maxFiles: 1, maxFolders: 1 },
      null,
    ],
    [
      "항목 수가 상한과 같으면 로컬 헤더를 읽은 뒤 개별 한도로 거부한다",
      { maxFiles: 2, maxFolders: 0 },
      { reason: "limit-exceeded", limit: "maxFolders" },
    ],
    [
      "항목 수가 상한보다 하나 많으면 zip-corrupt다",
      { maxFiles: 1, maxFolders: 0 },
      { reason: "zip-corrupt" },
    ],
  ] as const)(
    "끝 레코드 항목 수는 maxFiles + maxFolders + 2까지 받는다: %s",
    async (_title, limits, failure) => {
      const bytes = await encodeBytes({
        folders: ["d"],
        entries: [{ path: "a.js", type: "text", data: "let a;" }],
      });

      const result = await decode(bytes, KIND, limits);

      expect(result.ok).toBe(failure === null);
      if (failure !== null) expect(result).toEqual({ ok: false, failure });
    },
  );

  it("깊은 폴더 항목이 많아도 한도 검사가 경로 길이에 비례해 1초 안에 maxFolders로 거부한다", async () => {
    // 폴더 항목마다 첫 조각이 다르고 한 글자 조각 510개가 이어진다. 경로는 1,024자 이하다.
    // 접두 경로 문자열을 항목마다 모두 만들면 수 초와 수백 MB가 든다.
    const entries: Record<string, Uint8Array> = {
      "manifest.json": strToU8(
        `{"formatVersion":1,"kind":"${KIND}","files":[]}`,
      ),
    };
    for (let i = 0; i < 1200; i += 1) {
      entries[`files/${i.toString(36)}${"/a".repeat(510)}/`] = new Uint8Array(
        0,
      );
    }
    const bytes = wrap(zipSync(entries));

    // ZIP 항목은 1,201개다. maxFolders를 올려 항목 수 상한(201 + 1,199 + 2) 안에 넣어야 한도 검사까지 온다.
    // 폴더 항목 하나가 폴더 511개라 세 번째 항목에서 maxFolders를 넘는다.
    const started = performance.now();
    const result = await decode(bytes, KIND, { maxFolders: 1199 });

    expect(performance.now() - started).toBeLessThan(1000);
    expect(result).toEqual({
      ok: false,
      failure: { reason: "limit-exceeded", limit: "maxFolders" },
    });
  });

  it("실행처럼 진입 index.html과 .js·.css만 코드 합계에 넣고 나머지 텍스트는 asset 한도에 넣는다", async () => {
    const project = richProject();
    // 코드는 index.html 13, style.css 7, sketch.js 10바이트다. data.json과 big.txt는 asset이다.
    const assetsTotal = 3000 + 10 + strToU8('{"가":"나"}').length + 90_000;
    const failure = async (limits: Partial<ProjectFileLimits>) => {
      const result = await encodeProjectFile({
        ...project,
        kind: KIND,
        rules: RULES,
        limits: { ...LIMITS, ...limits },
      });
      return result.ok ? null : result.failure;
    };
    const exceeded = (limit: string) => ({ reason: "limit-exceeded", limit });

    expect(await failure({ maxCodeBytes: 30 })).toBeNull();
    expect(await failure({ maxCodeBytes: 29 })).toEqual(
      exceeded("maxCodeBytes"),
    );
    expect(await failure({ maxAssetsTotalBytes: assetsTotal })).toBeNull();
    expect(await failure({ maxAssetsTotalBytes: assetsTotal - 1 })).toEqual(
      exceeded("maxAssetsTotalBytes"),
    );
    expect(await failure({ maxAssetBytes: 89_999 })).toEqual(
      exceeded("maxAssetBytes"),
    );
    expect(
      (await decode(await encodeBytes(project), KIND, { maxCodeBytes: 30 })).ok,
    ).toBe(true);
  });

  it("기본 한도 값의 입력 크기 상한은 57,087,584바이트다", () => {
    // 상수를 일부러 리터럴로 둔다. `MAX_PATH_LENGTH_CEILING`이나 항목 오버헤드가 바뀌면 실패하게 한다.
    expect(maxProjectFileBytes(LIMITS)).toBe(57_087_584);
  });

  it("절대 상한과 최대 항목 수의 입력 크기 상한은 uint32 안이다", () => {
    // 헤더의 payload 길이와 ZIP 위치는 uint32다. 절대 상한을 올리면 여기서 넘치지 않는지 확인한다.
    const largest = maxProjectFileBytes({
      ...LIMITS,
      maxFiles: 65_533,
      maxFolders: 0,
      maxUncompressedBytes: MAX_UNCOMPRESSED_BYTES_CEILING,
    });

    expect(largest).toBeLessThanOrEqual(0xffff_ffff);
  });

  it("maxProjectFileBytes도 잘못된 한도에 던진다", () => {
    // 서버 크기 검사처럼 디코딩을 거치지 않는 쓰임에서 NaN이 비교를 조용히 통과시키지 않게 한다.
    for (const over of [
      { maxUncompressedBytes: Number.NaN },
      { maxUncompressedBytes: MAX_UNCOMPRESSED_BYTES_CEILING + 1 },
      { maxFiles: -1 },
      { maxFiles: 65_534, maxFolders: 0 },
    ]) {
      expect(() => maxProjectFileBytes({ ...LIMITS, ...over })).toThrow(
        RangeError,
      );
    }
  });

  it("maxUncompressedBytes가 절대 상한 256 MiB를 넘으면 인코딩과 디코딩이 던진다", async () => {
    const project = richProject();
    const bytes = await encodeBytes(project);
    const over = { maxUncompressedBytes: MAX_UNCOMPRESSED_BYTES_CEILING + 1 };

    expect(MAX_UNCOMPRESSED_BYTES_CEILING).toBe(268_435_456);
    await expect(
      encodeProjectFile({
        ...project,
        kind: KIND,
        rules: RULES,
        limits: { ...LIMITS, ...over },
      }),
    ).rejects.toThrow(RangeError);
    await expect(decode(bytes, KIND, over)).rejects.toThrow(RangeError);
  });

  it("maxUncompressedBytes가 절대 상한과 같으면 받는다", async () => {
    const project = richProject();
    const limits = { maxUncompressedBytes: MAX_UNCOMPRESSED_BYTES_CEILING };
    const encoded = await encodeProjectFile({
      ...project,
      kind: KIND,
      rules: RULES,
      limits: { ...LIMITS, ...limits },
    });

    expect(encoded.ok).toBe(true);
    expect((await decode(await encodeBytes(project), KIND, limits)).ok).toBe(
      true,
    );
  });

  it("인코딩 중에 asset 버퍼가 커져 결과가 입력 크기 상한을 넘으면 만들지 않는다", async () => {
    // 한도 검사는 ZIP을 쓰기 전에 끝난다.
    // 앞 asset `Blob`을 읽는 동안 호출자가 뒤 asset 버퍼를 키우면 검사 뒤에 결과가 커진다.
    const limits = { ...LIMITS, maxFiles: 2, maxFolders: 0 };
    const buffer = new ArrayBuffer(1, {
      maxByteLength: maxProjectFileBytes(limits),
    });
    const pending = encodeProjectFile({
      kind: KIND,
      entries: [
        { path: "a.bin", type: "asset", data: new Blob([noise(10)]) },
        { path: "b.bin", type: "asset", data: new Uint8Array(buffer) },
      ],
      rules: RULES,
      limits,
    });
    buffer.resize(buffer.maxByteLength);

    expect(await pending).toEqual({
      ok: false,
      failure: { reason: "limit-exceeded", limit: "maxUncompressedBytes" },
    });
  });
});

// 인코딩은 디코딩이 거부할 manifest를 만들지 않는다. 디코딩은 선언 크기가 1 MiB를 넘으면
// `manifest-invalid`로 거부하므로, 인코딩이 `manifest-too-large`로 먼저 막는다.
describe("프로젝트 파일 manifest 상한", () => {
  // 항목 수 한도를 넉넉히 두고 조각 길이 규칙은 없앤다. manifest 상한만 시험한다.
  const limits: ProjectFileLimits = { ...LIMITS, maxFiles: 20_000 };
  const rules: ProjectFileRules = { maxPathLength: 1024, isCode: () => false };
  const encode = (entries: ProjectEntry[]) =>
    encodeProjectFile({ kind: KIND, entries, rules, limits });

  /** 빈 텍스트 항목 하나. 경로의 길이는 `length`다(ASCII라 바이트와 같다). */
  const emptyText = (index: number, length: number): ProjectEntry => ({
    path: String(index).padEnd(length, "a"),
    type: "text",
    data: "",
  });

  /**
   * manifest 바이트가 `target`인 빈 텍스트 항목을 만든다.
   * 경로 길이 100인 항목을 최대한 채운 뒤, 모자란 바이트만큼 앞 항목의 경로를 1자씩 늘린다.
   */
  const entriesForManifestBytes = (target: number): ProjectEntry[] => {
    const bytesOf = (entries: ProjectEntry[]) =>
      writeManifest({
        formatVersion: FORMAT_VERSION_METADATA,
        kind: KIND,
        files: entries.map(({ path, type }) => ({ path, type })),
      }).length;
    const uniform = (count: number) =>
      Array.from({ length: count }, (_, i) => emptyText(i, 100));
    let count = Math.floor(
      (target - bytesOf(uniform(0))) /
        (bytesOf(uniform(1)) - bytesOf(uniform(0))),
    );
    while (bytesOf(uniform(count + 1)) <= target) count += 1;
    while (bytesOf(uniform(count)) > target) count -= 1;

    const lack = target - bytesOf(uniform(count));
    const entries = Array.from({ length: count }, (_, i) =>
      emptyText(i, i < lack ? 101 : 100),
    );
    expect(bytesOf(entries)).toBe(target);
    return entries;
  };

  it("manifest가 1 MiB를 넘는 프로젝트를 인코딩이 거부한다", async () => {
    // 상한을 문자 수가 아니라 UTF-8 바이트로 세는지 본다. 아래 경계값 시험은 ASCII 경로만 쓴다.
    // 경로가 1,000자인 비 ASCII 빈 텍스트 400개. manifest는 UTF-8로 약 1.2 MiB다.
    const entries = Array.from({ length: 400 }, (_, i): ProjectEntry => {
      return { path: "가".repeat(1000) + i, type: "text", data: "" };
    });

    expect(await encode(entries)).toEqual({
      ok: false,
      failure: { reason: "manifest-too-large" },
    });
  });

  it("manifest가 정확히 상한이면 인코딩하고 디코딩도 받는다", async () => {
    const entries = entriesForManifestBytes(MANIFEST_MAX_BYTES);

    const encoded = await encode(entries);

    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const restored = await decodeProjectFile(encoded.value, {
      kind: KIND,
      rules,
      limits,
    });
    expect(restored.ok).toBe(true);
  });

  it("manifest가 상한보다 1바이트 많으면 인코딩이 거부한다", async () => {
    const entries = entriesForManifestBytes(MANIFEST_MAX_BYTES + 1);

    expect(await encode(entries)).toEqual({
      ok: false,
      failure: { reason: "manifest-too-large" },
    });
  });
});
