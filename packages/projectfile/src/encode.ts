// 항목 목록을 프로젝트 파일 바이트로 만든다. 파일 트리, 화면, 전송을 모른다.
// - 구조: 헤더 + scramble한 ZIP. ZIP은 `manifest.json`과 `files/<경로>` 항목이다.
//   헤더 뒤에는 메타데이터 범위와 manifest 본문만 scramble한 ZIP(버전 1, `seal.ts`)이나
//   ZIP 전체를 scramble한 ZIP(버전 2, `full-scramble.ts`)이 온다. 옵션 `scrambleScope`가 고른다.
// - 텍스트는 deflate하고 asset은 압축하지 않는다. asset은 이미 압축된 형식이 많아 CPU만 쓴다.
// - 버전 1은 asset `Blob`을 읽어 복사하지 않는다. CRC32만 조각으로 읽어 계산하고 출력 `Blob`에 그대로 넣는다(`zip-write.ts`).
//   버전 2는 asset을 섞어야 해서 조각으로 한 번 더 읽는다.
// - 같은 입력은 같은 바이트가 된다. ZIP 수정 시각과 항목 순서를 고정한다.
// - 규칙은 `docs/format.md`에 있다.
import { checkProject, type PlannedNode } from "./check";
import type { ProjectEntry } from "./entry";
import { fail, type ProjectFileResult } from "./errors";
import { sealZipWhole } from "./full-scramble";
import {
  formatVersionOf,
  headerLengthOf,
  isProjectKind,
  type ProjectKind,
  type ScrambleScope,
} from "./header";
import {
  assertLimits,
  maxProjectFileBytes,
  type ProjectFileLimits,
} from "./limits";
import {
  FILES_DIR,
  MANIFEST_MAX_BYTES,
  MANIFEST_NAME,
  writeManifest,
  type ManifestFile,
} from "./manifest";
import { assertRules, type ProjectFileRules } from "./rules";
import { assertScrambleKey, DEFAULT_KEY } from "./scramble";
import { sealZip } from "./seal";
import {
  writeZip,
  ZipSourceReadError,
  type WrittenZip,
  type ZipSource,
} from "./zip-write";

/** 출력 `Blob`의 MIME. 보안 장비가 내용을 보지 않도록 바이너리로 보낸다. */
export const PROJECT_FILE_MIME = "application/octet-stream";

/** 인코딩 옵션. */
export interface EncodeOptions {
  /** 프로젝트 종류. 헤더와 manifest에 적는다. 규칙은 `ProjectKind`다. */
  kind: ProjectKind;

  /** 파일 항목. 이 순서가 manifest 순서다. */
  entries: readonly ProjectEntry[];

  /**
   * 폴더 경로. 빈 폴더를 담으려면 여기에 적는다. 파일 경로의 조상 폴더는 적지 않아도 생긴다.
   * 비우면 파일의 조상 폴더만 담는다. 조상 폴더도 ZIP 폴더 항목이 되고 `maxFolders`에 센다.
   */
  folders?: readonly string[];

  /** 이름과 코드 판정 규칙. */
  rules: ProjectFileRules;

  /** 한도. 모든 항목이 필요하다. */
  limits: ProjectFileLimits;

  /** scramble 키 16바이트. 비우면 `DEFAULT_SCRAMBLE_KEY`다. 길이가 다르면 던진다. */
  scrambleKey?: Uint8Array;

  /**
   * scramble하는 범위. 비우면 `"metadata"`다. 다른 값이면 던진다.
   * - `"metadata"`: ZIP 메타데이터 범위와 manifest 본문만 섞는다(포맷 버전 1).
   * - `"all"`: ZIP 전체를 섞는다(포맷 버전 2). asset 본문도 섞고 헤더 CRC가 ZIP 전체를 본다.
   *   인코딩과 디코딩이 asset을 조각으로 한 번 더 읽는다. 디코딩의 asset `Blob`은 입력의 `slice`가 아니라 새 `Blob`이다.
   */
  scrambleScope?: ScrambleScope;
}

/** 폴더 트리의 노드 하나. 폴더 항목과 그 안의 파일 항목을 모은다. */
interface FolderNode {
  /** 이름별 하위 폴더. 처음 나타난 순서 */
  folders: Map<string, FolderNode>;

  /** 이 폴더에 바로 든 파일. `entries` 순서 */
  files: ProjectEntry[];
}

/**
 * ZIP 항목 목록을 정한다. 순서는 `manifest.json`, `files/`, 트리 선행 순회다.
 * - 한 폴더 안에서 하위 폴더가 파일보다 앞에 온다.
 * - 하위 폴더는 처음 나타난 순서다. `folders`가 먼저고 `entries`의 조상 폴더가 이어진다.
 * - 파일은 `entries` 순서다.
 * - 객체 키 순서에 기대지 않는다. 정수처럼 보이는 이름도 입력 순서를 지킨다.
 */
function zipSources(
  manifest: Uint8Array,
  folders: readonly string[],
  entries: readonly ProjectEntry[],
  textBytes: ReadonlyMap<ProjectEntry, Uint8Array>,
): ZipSource[] {
  const root: FolderNode = { folders: new Map(), files: [] };
  const folderOf = (path: string): FolderNode => {
    let node = root;
    for (const segment of path === "" ? [] : path.split("/")) {
      let child = node.folders.get(segment);
      if (child === undefined) {
        child = { folders: new Map(), files: [] };
        node.folders.set(segment, child);
      }
      node = child;
    }
    return node;
  };
  for (const path of folders) folderOf(path);
  for (const entry of entries) {
    const slash = entry.path.lastIndexOf("/");
    folderOf(slash === -1 ? "" : entry.path.slice(0, slash)).files.push(entry);
  }

  const sources: ZipSource[] = [
    { name: MANIFEST_NAME, data: manifest, deflate: true, scrambleBody: true },
    { name: `${FILES_DIR}/`, data: new Uint8Array(0), deflate: false },
  ];
  const walk = (node: FolderNode, prefix: string): void => {
    for (const [name, child] of node.folders) {
      const path = `${prefix}${name}/`;
      sources.push({ name: path, data: new Uint8Array(0), deflate: false });
      walk(child, path);
    }
    for (const entry of node.files) {
      const name = `${FILES_DIR}/${entry.path}`;
      sources.push(
        entry.type === "text"
          ? { name, data: textBytes.get(entry) as Uint8Array, deflate: true }
          : { name, data: entry.data, deflate: false },
      );
    }
  };
  walk(root, `${FILES_DIR}/`);
  return sources;
}

/**
 * 항목을 프로젝트 파일 `Blob`으로 만든다.
 * - 이름 규칙(`rules`)이나 한도를 어기면 만들지 않고 이유를 돌려준다. 디코딩이 거부할 파일은 만들지 않는다.
 * - manifest가 `MANIFEST_MAX_BYTES`를 넘으면 `manifest-too-large`를 돌려준다. 이름과 한도 검사를 통과한 뒤에 본다.
 * - 빈 폴더도 담는다.
 * - 규칙을 어긴 `kind`, 길이가 16이 아닌 `scrambleKey`, 잘못된 `scrambleScope`, 잘못된 `rules.maxPathLength`와 `limits`는 던진다. 호출자 버그다.
 * - asset `Blob`을 읽지 못하면 던지지 않고 `read-failed`와 그 asset의 `path`를 돌려준다.
 *   ZIP에 쓰는 순서로 처음 읽지 못한 asset 하나만 알린다. 이름·한도·manifest 길이 검사를 통과한 뒤에 읽는다.
 *   `scrambleScope`가 `"all"`이면 입력 크기 상한 비교 뒤 섞으려고 한 번 더 읽는다. 이 읽기의 실패도 같은 방식으로 알린다.
 */
export async function encodeProjectFile(
  options: EncodeOptions,
): Promise<ProjectFileResult<Blob>> {
  const { kind, entries, rules, limits } = options;
  if (!isProjectKind(kind)) {
    throw new Error(`kind가 규칙을 어겼다: ${String(kind)}`);
  }
  const key = options.scrambleKey ?? DEFAULT_KEY;
  assertScrambleKey(key);
  const scope = options.scrambleScope ?? "metadata";
  if (scope !== "metadata" && scope !== "all") {
    throw new Error(`scrambleScope가 규칙을 어겼다: ${String(scope)}`);
  }
  assertRules(rules);
  assertLimits(limits);

  // 폴더를 먼저 둔다. 디코딩의 검사 순서와 같다.
  const planned: PlannedNode[] = [];
  for (const path of options.folders ?? []) {
    planned.push({ type: "folder", path, size: 0 });
  }
  const manifestFiles: ManifestFile[] = [];
  const textBytes = new Map<ProjectEntry, Uint8Array>();
  // 호출마다 하나만 만든다. 모듈 수준에 두면 디코딩만 쓰는 번들에도 생성 코드가 남는다.
  // 짝 없는 서로게이트는 U+FFFD(EF BF BD)로 바뀐다(`docs/format.md`).
  const encoder = new TextEncoder();
  for (const entry of entries) {
    manifestFiles.push({ path: entry.path, type: entry.type });
    if (entry.type === "text") {
      const bytes = encoder.encode(entry.data);
      textBytes.set(entry, bytes);
      planned.push({ type: "text", path: entry.path, size: bytes.length });
    } else {
      const size =
        entry.data instanceof Uint8Array ? entry.data.length : entry.data.size;
      planned.push({ type: "asset", path: entry.path, size });
    }
  }

  const failure = checkProject(rules, planned, limits);
  if (failure !== null) return fail(failure);

  // 항목 수가 한도 안일 때만 manifest를 만든다. 디코딩은 이 상한을 넘는 manifest를 거부한다.
  const manifest = writeManifest({
    formatVersion: formatVersionOf(scope),
    kind,
    files: manifestFiles,
  });
  if (manifest.length > MANIFEST_MAX_BYTES) {
    return fail({ reason: "manifest-too-large" });
  }

  const sources = zipSources(
    manifest,
    options.folders ?? [],
    entries,
    textBytes,
  );
  // asset 읽기 실패만 결과로 돌려준다. 그 밖의 오류는 호출자 버그라서 그대로 던진다.
  const readFailure = (error: unknown): ProjectFileResult<Blob> => {
    if (error instanceof ZipSourceReadError) {
      return fail({
        reason: "read-failed",
        path: error.sourceName.slice(FILES_DIR.length + 1),
      });
    }
    throw error;
  };
  let zip: WrittenZip;
  try {
    zip = await writeZip(sources);
  } catch (error) {
    return readFailure(error);
  }
  // 한도 안의 항목은 이 상한을 넘지 않는다. 넘으면 디코딩이 읽지 않는 파일이라 만들지 않는다.
  if (headerLengthOf(kind.length) + zip.length > maxProjectFileBytes(limits)) {
    return fail({ reason: "limit-exceeded", limit: "maxUncompressedBytes" });
  }
  let parts: BlobPart[];
  try {
    parts =
      scope === "all"
        ? await sealZipWhole(zip, kind, key)
        : sealZip(zip, kind, key);
  } catch (error) {
    return readFailure(error);
  }
  return { ok: true, value: new Blob(parts, { type: PROJECT_FILE_MIME }) };
}
