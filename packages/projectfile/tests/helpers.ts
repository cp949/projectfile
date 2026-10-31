/**
 * 프로젝트 파일 시험이 함께 쓰는 상수, 고정 바이트, 프로젝트 예제, 바이트 조립 함수.
 * - `LIMITS`와 `RULES`는 웹 실행 값과 같다. 코덱에는 기본값이 없어서 시험이 모두 채운다.
 * - `wrap`과 `craft`는 인코더가 만들지 않는 입력(손상한 ZIP, 규칙을 어긴 manifest)을 디코더에 주려고 쓴다.
 * - `encodeBytes`와 `decode`는 `LIMITS`와 `RULES`를 채워 코덱을 부른다.
 * - 시험 kind는 사용처 이름이 없는 중립 이름이다. 포맷 규칙은 `docs/format.md`에 있다.
 */
import { strToU8, zipSync } from "fflate";
import {
  decodeProjectFile,
  encodeProjectFile,
  type DecodedProjectEntry,
  type ProjectEntry,
  type ProjectFileLimits,
  type ProjectFileResult,
  type ProjectFileRules,
  type ProjectKind,
} from "../src/index";
import { crc32 } from "../src/crc32";
import {
  FIXED_HEADER_BYTES,
  readHeader,
  writeHeader,
  type ScrambleScope,
} from "../src/header";
import { MAX_ZIP_ENTRIES } from "../src/limits";
import { localRefsOf } from "../src/metadata-scramble";
import { createScrambler, DEFAULT_KEY, keyCheckOf } from "../src/scramble";
import { sealZip } from "../src/seal";
import { readCentralRecords, readZipEntries, type ZipEntry } from "../src/zip";
import type { ZipPart } from "../src/zip-write";

/** 시험 기본 kind. */
export const KIND = "example.blocks";

/** 기본 kind와 다른 kind. kind 불일치 시험이 쓴다. */
export const OTHER_KIND = "example.sketch";

/** kind를 정한 헤더 길이. */
export const headerBytesOf = (kind: ProjectKind = KIND) =>
  FIXED_HEADER_BYTES + kind.length;

/**
 * 웹 실행 한도와 같은 값이다. 코덱에는 기본값이 없어서 시험이 모두 채운다.
 * 앱의 `resolveLimits()` 기본값과 일치하는지는 앱 시험이 본다.
 */
export const LIMITS: ProjectFileLimits = {
  maxFiles: 201,
  maxFolders: 201,
  maxAssetBytes: 5 * 1024 * 1024,
  maxAssetsTotalBytes: 50 * 1024 * 1024,
  maxCodeBytes: 1024 * 1024,
  maxUncompressedBytes: 51 * 1024 * 1024,
};

/**
 * 웹 프로필을 흉내 낸 호출자 규칙.
 * - 조각이 128자를 넘으면 `too-long`이다.
 * - 코드는 최상위 `index.html`과 `.js`·`.css`다.
 */
export const RULES: ProjectFileRules = {
  maxPathLength: 1024,
  checkSegment: (_kind, segment) => (segment.length > 128 ? "too-long" : null),
  isCode: (path) => path === "index.html" || /\.(js|css)$/i.test(path),
};

/** 결과가 성공이면 값을, 아니면 이유를 담아 던진다. */
export function value<T>(result: ProjectFileResult<T>): T {
  if (!result.ok) throw new Error(`실패: ${result.failure.reason}`);
  return result.value;
}

/** 시드가 같으면 같은 바이트가 나온다. 압축되지 않는 바이트열을 만든다. */
export function noise(length: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(length);
  let x = 12345;
  for (let i = 0; i < length; i += 1) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

/** 인코딩에 넘기는 항목과 폴더. */
export interface Project {
  entries: ProjectEntry[];
  folders: string[];
}

/** 처음 만드는 웹 프로젝트의 세 파일. */
export const baseEntries = (): ProjectEntry[] => [
  { path: "index.html", type: "text", data: "<html></html>" },
  { path: "sketch.js", type: "text", data: "let a = 1;" },
  { path: "style.css", type: "text", data: "body {}" },
];

/** 큰 텍스트 파일(80,000바이트 이상)과 asset, 빈 폴더, 한글 이름이 든 프로젝트. 폴더는 조상이 앞이다. */
export const richProject = (): Project => ({
  folders: ["img", "img/깊은", "빈폴더"],
  entries: [
    { path: "img/깊은/소리.mp3", type: "asset", data: new Blob([noise(10)]) },
    { path: "img/big.txt", type: "text", data: "가".repeat(30_000) },
    { path: "img/고양이.png", type: "asset", data: noise(3000) },
    { path: "data.json", type: "text", data: '{"가":"나"}' },
    ...baseEntries(),
  ],
});

/** 항목 하나를 비교 가능한 한 줄로 만든다. asset은 바이트 수와 CRC32로 줄인다. */
async function row(entry: ProjectEntry | DecodedProjectEntry): Promise<string> {
  if (entry.type === "text") return `text ${entry.path} ${entry.data}`;
  const bytes =
    entry.data instanceof Uint8Array
      ? entry.data
      : new Uint8Array(await entry.data.arrayBuffer());
  return `asset ${entry.path} ${bytes.length} ${crc32(bytes)}`;
}

/** 폴더와 항목을 순서대로 비교 가능한 목록으로 펼친다. */
export async function flatten(project: {
  entries: readonly (ProjectEntry | DecodedProjectEntry)[];
  folders: readonly string[];
}): Promise<string[]> {
  return [
    ...project.folders.map((path) => `folder ${path}`),
    ...(await Promise.all(project.entries.map(row))),
  ];
}

/**
 * ZIP 바이트에 헤더를 붙이고 섞어 프로젝트 파일로 감싼다. CRC가 맞게 감싼다.
 * `manifest.json` 항목이 하나인 코덱 모양의 ZIP이어야 한다. 항목 내용이 틀린 ZIP은 감쌀 수 있다.
 * 섞는 범위는 인코더와 같다.
 * - `"metadata"`(기본): 로컬 헤더, manifest 본문, 중앙 디렉터리와 끝 레코드. 헤더 버전 1.
 * - `"all"`: ZIP 전체. 헤더 CRC도 ZIP 전체를 본다. 헤더 버전 2.
 */
export function wrap(
  zip: Uint8Array,
  kind: ProjectKind = KIND,
  key: Uint8Array = DEFAULT_KEY,
  scope: ScrambleScope = "metadata",
): Uint8Array<ArrayBuffer> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const centralStart = view.getUint32(zip.length - 22 + 16, true);
  if (scope === "all") {
    const header = writeHeader(
      kind,
      2,
      zip.length,
      crc32(zip),
      centralStart,
      keyCheckOf(key),
    );
    const out = new Uint8Array(header.length + zip.length);
    out.set(header, 0);
    out.set(createScrambler(key).scramble(zip, 0), header.length);
    return out;
  }
  const records = readCentralRecords(
    zip.subarray(centralStart),
    centralStart,
    MAX_ZIP_ENTRIES,
  );
  const refs = records && localRefsOf(records);
  if (refs === null) throw new Error("이 코덱이 만든 ZIP이 아니다");

  const parts: ZipPart[] = [];
  let at = 0;
  const take = (to: number, scramble: boolean) => {
    if (to > at) parts.push({ bytes: zip.subarray(at, to), scramble });
    at = to;
  };
  for (const { start, size, manifest } of refs) {
    const end = start + 30 + view.getUint16(start + 26, true);
    take(start, false);
    take(end, true);
    if (manifest) take(end + size, true);
  }
  take(centralStart, false);
  take(zip.length, true);

  const sealed = sealZip(
    { parts, length: zip.length, centralStart },
    kind,
    key,
  );
  const out = new Uint8Array(headerBytesOf(kind) + zip.length);
  let position = 0;
  for (const piece of sealed) {
    out.set(piece as Uint8Array, position);
    position += (piece as Uint8Array).length;
  }
  return out;
}

/** manifest와 항목으로 프로젝트 파일을 직접 만든다. 인코더가 거부하는 입력을 디코더에 주려는 용도다. */
export function craft(
  files: { path: string; type?: "text" | "asset" }[],
  options: {
    kind?: ProjectKind;
    manifestKind?: ProjectKind;
    dirs?: string[];
    scope?: ScrambleScope;
    formatVersion?: number;
  } = {},
): Uint8Array<ArrayBuffer> {
  const kind = options.kind ?? KIND;
  const entries: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {
    "manifest.json": strToU8(
      JSON.stringify({
        formatVersion:
          options.formatVersion ?? (options.scope === "all" ? 2 : 1),
        kind: options.manifestKind ?? kind,
        files: files.map(({ path, type }) => ({ path, type: type ?? "text" })),
      }),
    ),
  };
  // asset은 저장(방식 0)이어야 한다. 인코더와 같다.
  for (const { path, type } of files) {
    entries[`files/${path}`] =
      type === "asset" ? [strToU8("x"), { level: 0 }] : strToU8("x");
  }
  for (const dir of options.dirs ?? [])
    entries[`files/${dir}/`] = new Uint8Array(0);
  return wrap(zipSync(entries), kind, undefined, options.scope);
}

/** 중앙 디렉터리에서 `name` 항목의 `at` 위치 32비트 필드를 `value`로 고친다. 실제 데이터는 그대로다. */
function setCentralField(
  zip: Uint8Array,
  name: string,
  at: number,
  value: number,
): Uint8Array {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const target = strToU8(name);
  for (let i = 0; i + 46 <= zip.length; i += 1) {
    if (view.getUint32(i, true) !== 0x02014b50) continue;
    const length = view.getUint16(i + 28, true);
    const found = zip.subarray(i + 46, i + 46 + length);
    if (length === target.length && found.every((b, k) => b === target[k])) {
      view.setUint32(i + at, value, true);
    }
  }
  return zip;
}

/** 중앙 디렉터리에서 `name` 항목의 풀린 크기 선언을 `size`로 고친다. 실제 데이터는 그대로다. */
export const declareSize = (zip: Uint8Array, name: string, size: number) =>
  setCentralField(zip, name, 24, size);

/** 중앙 디렉터리에서 `name` 항목의 압축 크기 선언을 `size`로 고친다. 실제 데이터는 그대로다. */
export const declareCompressedSize = (
  zip: Uint8Array,
  name: string,
  size: number,
) => setCentralField(zip, name, 20, size);

/** `files/a.txt` 하나를 텍스트로 적은 manifest와 `entries`로 ZIP을 만든다. `{ level: 0 }`을 붙인 항목은 저장(방식 0)이다. */
export const zipWithText = (
  entries: Record<string, Uint8Array | [Uint8Array, { level: 0 }]>,
) =>
  zipSync({
    "manifest.json": strToU8(
      `{"formatVersion":1,"kind":"${KIND}","files":[{"path":"a.txt","type":"text"}]}`,
    ),
    ...entries,
  });

/** `files/a.txt` 하나를 둔 ZIP의 끝 레코드를 `patch`에 넘겨 고친다. fflate는 ZIP 주석을 쓰지 않아 끝 레코드가 마지막 22바이트다. */
export function patchZip(
  patch: (view: DataView, eocd: number) => void,
): Uint8Array {
  const zip = zipWithText({ "files/a.txt": strToU8("x") });
  patch(
    new DataView(zip.buffer, zip.byteOffset, zip.byteLength),
    zip.length - 22,
  );
  return zip;
}

export const decode = (
  bytes: Uint8Array | Blob,
  kind: ProjectKind = KIND,
  limits: Partial<ProjectFileLimits> = {},
  scrambleKeys?: readonly Uint8Array[],
) =>
  decodeProjectFile(bytes, {
    kind,
    rules: RULES,
    limits: { ...LIMITS, ...limits },
    scrambleKeys,
  });

/** 프로젝트를 프로젝트 파일 바이트로 만든다. 키를 넘기지 않으면 기본 키다. */
export const encodeBytes = async (
  project: Project,
  kind: ProjectKind = KIND,
  scrambleKey?: Uint8Array,
  scrambleScope?: ScrambleScope,
) =>
  new Uint8Array(
    await value(
      await encodeProjectFile({
        ...project,
        kind,
        rules: RULES,
        limits: LIMITS,
        scrambleKey,
        scrambleScope,
      }),
    ).arrayBuffer(),
  );

/**
 * 파일에서 메타데이터를 복원한 표준 ZIP과 복원이 돌려준 CRC. 기본 키로 푼다. 입력은 바꾸지 않는다.
 * 복원 규칙(섞는 범위)을 `src`와 따로 적어 두어 시험이 범위 계약을 독립으로 확인하게 한다.
 */
export function restoreMetadata(bytes: Uint8Array) {
  const header = value(readHeader(bytes, bytes.length));
  const zip = bytes.slice(header.headerBytes);
  const scrambler = createScrambler(DEFAULT_KEY);
  const central = zip.subarray(header.centralStart);
  central.set(scrambler.unscramble(central, header.centralStart));
  const records = readCentralRecords(
    central,
    header.centralStart,
    MAX_ZIP_ENTRIES,
  );
  const refs = records && localRefsOf(records);
  if (refs === null) throw new Error("중앙 디렉터리를 읽지 못했다");
  let crc = 0;
  for (const ref of refs) {
    const end = ref.start + 30 + ref.nameLength + (ref.manifest ? ref.size : 0);
    const range = zip.subarray(ref.start, end);
    range.set(scrambler.unscramble(range, ref.start));
    crc = crc32(range, crc);
  }
  return {
    zip,
    crc: crc32(central, crc),
    centralStart: header.centralStart,
  };
}

/** 복원한 ZIP의 항목 목록. 중앙 디렉터리 순서다. */
export function listEntries(zip: Uint8Array, centralStart: number) {
  const central = zip.subarray(centralStart);
  const records = readCentralRecords(central, centralStart, MAX_ZIP_ENTRIES);
  const refs = records && localRefsOf(records);
  if (records === null || refs === null) {
    throw new Error("중앙 디렉터리를 읽지 못했다");
  }
  const locals = new Map(
    refs.map(({ start, nameLength }) => [
      start,
      zip.subarray(start, start + 30 + nameLength),
    ]),
  );
  const entries = readZipEntries(records, centralStart, locals);
  if (entries === null) throw new Error("ZIP 목록을 읽지 못했다");
  return entries;
}

/** 복원한 ZIP에서 항목의 압축 바이트. */
export const compressedBytes = (zip: Uint8Array, entry: ZipEntry) =>
  zip.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);

/** 파일의 ZIP 항목 목록. 중앙 디렉터리 순서다. 메타데이터를 복원한 사본에서 읽는다. */
export function zipEntriesOf(bytes: Uint8Array) {
  const { zip, centralStart } = restoreMetadata(bytes);
  return listEntries(zip, centralStart);
}
