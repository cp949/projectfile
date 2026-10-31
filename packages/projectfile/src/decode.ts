// 프로젝트 파일 바이트를 항목 목록으로 되돌린다. 파일 트리, 화면, 전송을 모른다.
// - 입력은 열려는 사용자 파일일 수 있다. 어떤 입력도 던지지 않고 거부 이유를 돌려준다.
// - 입력 크기는 읽기 전에 본다. 풀기 전에 ZIP 중앙 디렉터리가 선언한 크기로 이름과 한도를 검사한다.
// - 항목은 선언 크기까지만 푼다(`zip.ts`). 선언과 다르게 풀리면 거부한다. 선언 합계가 메모리와 해제 CPU의 상한이다.
// - 변조를 막는 장치가 아니다. CRC와 scramble 규칙이 모두 클라이언트에 있다.
// - `Blob` 입력은 전체를 읽지 않고 필요한 범위만 묶어 읽는다(`read-range.ts`, `seal.ts`).
//   읽는 범위는 헤더, 중앙 디렉터리, 로컬 헤더, manifest 본문, 텍스트 본문이다. asset 본문은 읽지 않는다.
// - 메타데이터 범위와 manifest 본문은 읽은 조각에서 새 배열로 풀고 그 범위의 CRC를 본다. 입력은 고치지 않는다.
//   텍스트 본문 손상은 텍스트 항목을 푼 뒤 ZIP 항목 CRC32로 본다. asset 손상은 보지 않는다.
// - asset은 입력의 본문 범위를 `Blob`으로 돌려준다. `Blob` 입력이면 `input.slice`, `Uint8Array` 입력이면 `new Blob`이다.
//   그래서 asset 항목은 저장(방식 0)이어야 한다.
// - 포맷 버전 2(ZIP 전체 scramble)는 읽는 즉시 평문으로 돌리는 읽기 수단을 쓴다(`full-scramble.ts`).
//   헤더 CRC가 ZIP 전체를 보므로 payload를 조각으로 모두 읽는다. asset은 평문을 읽어 새 `Blob`으로 만든다.
// - 규칙은 `docs/format.md`의 "검사 순서"에 있다.
import { checkProject, type PlannedNode } from "./check";
import { crc32 } from "./crc32";
import type { DecodedProjectEntry } from "./entry";
import { fail, type ProjectFileResult } from "./errors";
import { createUnscrambledReader, plainBlob } from "./full-scramble";
import { readHead } from "./header-info";
import { FORMAT_VERSION_ALL, isProjectKind, type ProjectKind } from "./header";
import {
  assertLimits,
  maxProjectFileBytes,
  maxZipEntries,
  type ProjectFileLimits,
} from "./limits";
import {
  FILES_DIR,
  MANIFEST_MAX_BYTES,
  MANIFEST_NAME,
  readManifest,
  type ManifestFile,
} from "./manifest";
import { assertRules, type ProjectFileRules } from "./rules";
import { assertScrambleKeys, DEFAULT_KEY, findKey } from "./scramble";
import { createRangeSource } from "./read-range";
import { openZip } from "./seal";
import { inflateEntry, type ZipEntry } from "./zip";
import { METHOD_DEFLATE, METHOD_STORED } from "./zip-layout";

/** 디코딩 옵션. */
export interface DecodeOptions {
  /** 이 호출자가 기대하는 kind. 헤더가 다르면 거부한다. 규칙은 `ProjectKind`다. */
  kind: ProjectKind;

  /**
   * 풀 수 있는 scramble 키 목록. 비우면 `[DEFAULT_SCRAMBLE_KEY]`다.
   * 목록을 주면 그 키만 쓴다. 기본 키도 받으려면 목록에 넣는다.
   * 빈 배열이나 키 확인값이 같은 키가 둘 이상이면 던진다.
   */
  scrambleKeys?: readonly Uint8Array[];

  /** 이름과 코드 판정 규칙. */
  rules: ProjectFileRules;

  /** 한도. 모든 항목이 필요하다. */
  limits: ProjectFileLimits;
}

/** 파일 내용을 만들 준비. 텍스트는 압축 본문이 채워져 있다. */
type PreparedFile =
  | { type: "asset"; path: string; info: ZipEntry }
  | { type: "text"; path: string; info: ZipEntry; body: Uint8Array };

/** 디코딩 결과. */
export interface DecodedProject {
  /** 헤더의 kind. 기대한 kind와 같다. */
  kind: ProjectKind;

  /** 파일 항목. manifest 순서다. */
  entries: DecodedProjectEntry[];

  /**
   * ZIP의 폴더 항목 경로. 중앙 디렉터리 순서다. 폴더 항목이 없는 조상 폴더를 만들어 넣지 않는다.
   * 인코딩은 파일의 조상 폴더도 폴더 항목으로 담는다. 인코딩 때 `folders`에 없던 조상도 여기에 든다.
   */
  folders: string[];
}

/**
 * 프로젝트 파일을 항목 목록으로 되돌린다.
 *
 * 검사 순서:
 * 1. 입력 크기와 읽기. 입력이 `maxProjectFileBytes(limits)`를 넘으면 읽지 않고 `input-too-large`, 읽지 못하면 `read-failed`.
 *    풀린 크기 합계가 `maxUncompressedBytes`를 넘는 경우는 10단계의 `limit-exceeded`다.
 *    `Blob` 입력은 헤더(앞 86바이트)부터 읽고, 이후 단계가 필요한 범위를 읽는다. 읽는 중 실패해도 `read-failed`다.
 * 2. magic. 틀리면 `bad-magic`.
 * 3. 헤더 길이와 포맷 버전. 22바이트 미만이면 `length-mismatch`, 1이나 2가 아닌 버전은 `unsupported-version`.
 * 4. kind. 길이가 0이거나 64를 넘으면 `kind-invalid`. 22 + N바이트 미만이면 `length-mismatch`.
 *    문자열이 규칙을 어기면 `kind-invalid`, 규칙을 지켰지만 기대한 kind와 다르면 `kind-mismatch`.
 * 5. 전체 크기. 22 + N + payload 길이와 다르면 `length-mismatch`.
 * 6. 키. 헤더의 키 확인값과 같은 키가 없으면 `scramble-key-mismatch`.
 * 7. 복원과 CRC32. 메타데이터 범위와 manifest 본문을 되돌린다.
 *    끝 레코드의 항목 수가 `maxFiles + maxFolders + 2`를 넘으면 로컬 헤더를 읽기 전에 `zip-corrupt`.
 *    범위를 정할 수 없으면 `zip-corrupt`, CRC가 헤더와 다르면 `crc-mismatch`.
 *    CRC 범위는 버전 1이 메타데이터 범위와 manifest 본문, 버전 2가 ZIP 전체다.
 * 8. ZIP 항목 목록. 암호화 항목, 읽지 못하는 이름, 겹치는 이름, 틀린 로컬 헤더 시그니처, `centralStart`를 넘는 압축 데이터는 `zip-corrupt`.
 *    중앙 디렉터리의 구조 손상은 7단계가 먼저 거부한다.
 * 9. manifest. 선언 크기가 상한을 넘거나 형식이 틀리면 `manifest-invalid`, 풀리지 않으면 `zip-corrupt`.
 *    헤더와 kind가 다르면 `manifest-kind-mismatch`.
 * 10. 이름(`rules`)과 한도. 선언한 크기로 검사하고 파일 내용은 아직 풀지 않는다.
 * 11. 파일 내용. 선언 크기를 넘으면 그 자리에서 멈춘다.
 *    풀린 길이가 선언과 다르거나 텍스트가 UTF-8이 아니면 `zip-corrupt`.
 *    deflate(방식 8) 텍스트는 압축 크기가 0이면 `zip-corrupt`다.
 *    텍스트 항목을 푼 뒤 ZIP 항목 CRC32도 비교한다. 다르면 `zip-corrupt`. asset은 비교하지 않는다.
 *    asset은 저장(방식 0)이고 압축 크기가 선언 크기와 같아야 한다. 아니면 `zip-corrupt`.
 *
 * `Uint8Array` 입력은 바꾸지 않는다. 입력 전체를 복사하지도 않는다.
 * 규칙을 어긴 `kind`, 잘못된 `scrambleKeys`, 잘못된 `rules.maxPathLength`와 `limits`는 던진다. 호출자 버그다.
 */
export async function decodeProjectFile(
  input: Blob | Uint8Array,
  options: DecodeOptions,
): Promise<ProjectFileResult<DecodedProject>> {
  const { rules, limits } = options;
  if (!isProjectKind(options.kind)) {
    throw new Error(`kind가 규칙을 어겼다: ${String(options.kind)}`);
  }
  const keys = options.scrambleKeys ?? [DEFAULT_KEY];
  assertScrambleKeys(keys);
  assertRules(rules);
  assertLimits(limits);
  const inputBytes = input instanceof Uint8Array ? input.length : input.size;
  const maxBytes = maxProjectFileBytes(limits);
  if (inputBytes > maxBytes) {
    return fail({ reason: "input-too-large", maxBytes });
  }
  const source = createRangeSource(input);
  const header = await readHead(source, inputBytes, options.kind);
  if (!header.ok) return header;
  const key = findKey(keys, header.value.keyCheck);
  if (key === null) return fail({ reason: "scramble-key-mismatch" });
  // 버전 2는 읽는 즉시 평문으로 돌린다. 이후 읽기는 모두 이 수단을 거친다.
  const whole = header.value.formatVersion === FORMAT_VERSION_ALL;
  const reader = whole
    ? createUnscrambledReader(source, header.value.headerBytes, key)
    : source;
  const opened = await openZip(
    reader,
    header.value,
    key,
    maxZipEntries(limits),
  );
  if (!opened.ok) return opened;
  const { entries, manifestBody, bodies } = opened.value;
  const headerKind = header.value.kind;

  // 항목 목록과 manifest. 파일 내용은 아직 풀지 않는다.
  const infos = new Map(entries.map((entry) => [entry.name, entry]));
  const manifestEntry = infos.get(MANIFEST_NAME);
  if (manifestEntry === undefined || manifestEntry.size > MANIFEST_MAX_BYTES) {
    return fail({ reason: "manifest-invalid" });
  }
  const manifestBytes = inflateEntry(manifestBody, manifestEntry);
  if (manifestBytes === null) return fail({ reason: "zip-corrupt" });
  const manifest = readManifest(manifestBytes, header.value.formatVersion);
  if (!manifest.ok) return manifest;
  if (manifest.value.kind !== headerKind) {
    return fail({ reason: "manifest-kind-mismatch" });
  }

  // 항목은 manifest 파일, 폴더 항목, `manifest.json`뿐이어야 한다.
  const prefix = `${FILES_DIR}/`;
  const typeByName = new Map(
    manifest.value.files.map((file) => [prefix + file.path, file.type]),
  );
  const planned: PlannedNode[] = [];
  for (const name of infos.keys()) {
    if (name === MANIFEST_NAME || name === prefix) continue;
    if (!name.startsWith(prefix)) return fail({ reason: "manifest-invalid" });
    if (name.endsWith("/")) {
      planned.push({
        type: "folder",
        path: name.slice(prefix.length, -1),
        size: 0,
      });
    } else if (!typeByName.has(name)) {
      return fail({ reason: "manifest-invalid" });
    }
  }
  const files: { file: ManifestFile; info: ZipEntry }[] = [];
  for (const file of manifest.value.files) {
    const info = infos.get(prefix + file.path);
    if (info === undefined) return fail({ reason: "manifest-invalid" });
    planned.push({ type: file.type, path: file.path, size: info.size });
    files.push({ file, info });
  }
  const failure = checkProject(rules, planned, limits);
  if (failure !== null) return fail(failure);

  const folders = planned.flatMap((node) =>
    node.type === "folder" ? [node.path] : [],
  );
  // 열기에서 본문을 읽지 않은 텍스트를 한 번에 읽는다. 저장(방식 0)한 텍스트와 압축 크기를 0으로 선언한 deflate 텍스트다. 뒤의 것은 읽은 뒤 11단계가 거부한다.
  const slots = files.map(({ file, info }) => ({
    file,
    info,
    opened: file.type === "text" ? bodies.get(info.dataStart) : undefined,
  }));
  const missing = slots.filter(
    ({ file, opened }) => file.type === "text" && opened === undefined,
  );
  let stored: Uint8Array[];
  try {
    stored = await reader.read(
      missing.map(({ info }) => ({
        start: header.value.headerBytes + info.dataStart,
        end: header.value.headerBytes + info.dataStart + info.compressedSize,
      })),
    );
  } catch {
    return fail({ reason: "read-failed" });
  }
  // 텍스트마다 본문이 채워진 구조로 바꾼다. 읽어 둔 본문이 없는 텍스트는 `missing` 순서대로 `stored`에서 받는다.
  let next = 0;
  const prepared = slots.map(({ file, info, opened }): PreparedFile => {
    if (file.type === "asset") return { type: "asset", path: file.path, info };
    return {
      type: "text",
      path: file.path,
      info,
      body: opened ?? (stored[next++] as Uint8Array),
    };
  });

  // 파일 내용. manifest의 파일만 선언 크기 버퍼에 풀어 버퍼 합이 한도 안이다.
  const decoded: DecodedProjectEntry[] = [];
  for (const item of prepared) {
    const { path, info } = item;
    if (item.type === "asset") {
      // 본문은 읽지 않는다. 저장이어야 입력의 본문 범위가 곧 원본이다.
      if (info.method !== METHOD_STORED || info.compressedSize !== info.size) {
        return fail({ reason: "zip-corrupt" });
      }
      const start = header.value.headerBytes + info.dataStart;
      let data: Blob;
      try {
        // 버전 2의 본문은 섞여 있다. 입력의 `slice`로는 원본이 되지 않아 평문을 읽어 새 `Blob`을 만든다.
        data = whole
          ? await plainBlob(reader, start, start + info.size)
          : source.slice({ start, end: start + info.size });
      } catch {
        return fail({ reason: "read-failed" });
      }
      decoded.push({ path, type: "asset", data });
      continue;
    }
    // 유효한 deflate 스트림은 비어 있을 수 없다. 선언 크기가 0이면 푼 길이가 같아 통과하므로 따로 거른다.
    if (info.method === METHOD_DEFLATE && info.compressedSize === 0) {
      return fail({ reason: "zip-corrupt" });
    }
    const content = inflateEntry(item.body, info);
    if (content === null) return fail({ reason: "zip-corrupt" });
    // 헤더 CRC는 텍스트 본문을 보지 않는다. 푼 뒤 ZIP 항목 CRC32로 본다.
    if (crc32(content) !== info.crc) return fail({ reason: "zip-corrupt" });
    try {
      decoded.push({
        path,
        type: "text",
        // 맨 앞 U+FEFF를 BOM으로 떼지 않는다. 인코딩이 내용 그대로 UTF-8로 썼다.
        data: new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(content),
      });
    } catch {
      return fail({ reason: "zip-corrupt" });
    }
  }
  return {
    ok: true,
    value: { kind: options.kind, entries: decoded, folders },
  };
}
