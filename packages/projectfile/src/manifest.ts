// ZIP 안의 `manifest.json`. 노드 종류와 kind를 담는다.
// - 파일 내용은 `files/<경로>` 항목에 있다. manifest의 `files[].path`는 `files/`를 뗀 경로다.
// - 노드 종류가 필요한 이유: ZIP 항목만으로는 텍스트와 asset을 가를 수 없다.
//   확장자로 가르면 80,000바이트 이상인 텍스트가 asset으로 바뀐다.
// - 폴더는 ZIP의 `files/<경로>/` 항목이 담는다. manifest에 적지 않는다.
// - 규칙은 `docs/format.md`의 "ZIP과 manifest"에 있다.
import { fail, type ProjectFileResult } from "./errors";
import { isProjectKind, type ProjectKind } from "./header";

/** ZIP 안 manifest 항목 이름. */
export const MANIFEST_NAME = "manifest.json";

/** 파일 내용 항목의 접두 폴더. 사용자 파일 이름과 `manifest.json`이 겹치지 않게 한다. */
export const FILES_DIR = "files";

/** manifest를 풀기 전에 보는 크기 상한(바이트). 경로 목록만 담는 파일이다. */
export const MANIFEST_MAX_BYTES: number = 1024 * 1024;

/** 파일 노드 종류. 폴더는 manifest에 없다. */
export type ManifestFileType = "text" | "asset";

/** manifest가 적는 파일 하나. */
export interface ManifestFile {
  path: string;
  type: ManifestFileType;
}

/** 읽어 낸 manifest. */
export interface Manifest {
  formatVersion: number;
  kind: ProjectKind;
  files: ManifestFile[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function own(record: Record<string, unknown>, key: string): unknown {
  // `Object.hasOwn`은 Chrome 75에 없다.
  return Object.prototype.hasOwnProperty.call(record, key)
    ? record[key]
    : undefined;
}

/** manifest 바이트를 만든다. */
export function writeManifest(manifest: Manifest): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(manifest));
}

/**
 * manifest를 읽어 검사한다. 틀리면 `manifest-invalid`다.
 * - 올바른 UTF-8 JSON 객체여야 한다. 잘못된 바이트를 U+FFFD로 바꿔 읽지 않는다.
 * - 맨 앞 BOM 하나는 `TextDecoder`가 떼고 읽는다. 둘째 BOM부터는 JSON 문법 위반이다.
 * - `formatVersion`은 헤더의 버전(`formatVersion` 인자)과 같아야 한다.
 * - `kind`는 kind 규칙을 지키는 문자열이다. 헤더와 같은지는 호출자가 본다.
 * - `files`는 `path`(문자열)와 `type`(`text`나 `asset`)을 가진 객체의 배열이다. 경로가 겹치면 거부한다.
 * - 추가 필드는 버린다.
 */
export function readManifest(
  bytes: Uint8Array,
  headerVersion: number,
): ProjectFileResult<Manifest> {
  const invalid = fail({ reason: "manifest-invalid" });
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return invalid;
  }
  if (!isRecord(value)) return invalid;
  const formatVersion = own(value, "formatVersion");
  const kind = own(value, "kind");
  const files = own(value, "files");
  if (formatVersion !== headerVersion) return invalid;
  if (!isProjectKind(kind)) return invalid;
  if (!Array.isArray(files)) return invalid;
  const seen = new Set<string>();
  const parsed: ManifestFile[] = [];
  for (const item of files as unknown[]) {
    if (!isRecord(item)) return invalid;
    const path = own(item, "path");
    const type = own(item, "type");
    if (typeof path !== "string" || seen.has(path)) return invalid;
    if (type !== "text" && type !== "asset") return invalid;
    seen.add(path);
    parsed.push({ path, type });
  }
  return { ok: true, value: { formatVersion, kind, files: parsed } };
}
