// 프로젝트 항목의 이름과 한도를 검사한다. 인코딩과 디코딩이 같은 검사를 쓴다.
// - 인코딩은 입력 항목에서, 디코딩은 ZIP 헤더가 선언한 크기에서 `PlannedNode`를 만든다.
//   내용을 읽기 전에 검사하므로 ZIP 폭탄이 메모리에 풀리지 않는다.
// - 컨테이너 무결성 규칙은 코덱이 항상 강제한다: 빈 조각, `.`·`..`, `\`, 제어 문자,
//   짝 없는 서로게이트, 앞뒤 공백, 형제 중복(대소문자와 NFC 정규형 차이 무시), 경로 길이.
// - 그 밖의 이름 규칙(확장자, 조각 길이)과 코드 판정은 호출자의 `ProjectFileRules`가 정한다.
// - 규칙은 `docs/format.md`의 "검사 순서"에 있다.
import type { ProjectFileFailure, ProjectNameCause } from "./errors";
import type { ProjectFileLimits } from "./limits";
import type { ProjectFileRules } from "./rules";

/** 검사할 항목. `size`는 풀었을 때의 바이트다. 폴더는 쓰지 않는다. */
export interface PlannedNode {
  type: "folder" | "text" | "asset";

  /** `files/`를 뗀 경로. 폴더 이름을 `/`로 이은 값이다. */
  path: string;
  size: number;
}

/**
 * 백슬래시, 제어 문자, 짝 없는 서로게이트가 있으면 참이다.
 * 정규식은 `no-control-regex` 규칙에 걸려 쓰지 않는다.
 * `String.prototype.isWellFormed`는 Chrome 75에 없어 쓰지 않는다.
 */
function hasInvalidChar(segment: string): boolean {
  // 문자열 순회는 올바른 쌍을 한 문자(길이 2)로 돌려준다. 짝 없는 서로게이트는 길이 1로 나온다.
  for (const char of segment) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f || char === "\\") return true;
    // ZIP 항목 이름은 짝 없는 서로게이트를 U+FFFD로 쓰므로 manifest 경로와 달라진다.
    if (char.length === 1 && code >= 0xd800 && code <= 0xdfff) return true;
  }
  return false;
}

/**
 * 컨테이너 무결성 규칙으로 조각 하나를 검사한다.
 * 앞뒤 공백이 있는 조각은 ZIP 항목 이름으로는 다른 이름이 되므로 거부한다.
 */
function checkIntegrity(segment: string): ProjectNameCause | null {
  if (segment.trim() === "") return "empty";
  if (
    segment === "." ||
    segment === ".." ||
    segment !== segment.trim() ||
    hasInvalidChar(segment)
  ) {
    return "invalid-char";
  }
  return null;
}

/**
 * 형제 중복을 판정하는 키. 소문자로 바꾼 뒤 NFC로 정규화한다.
 * - 정규 동치인 이름(`é`의 U+00E9와 U+0065 U+0301, 한글 음절과 자모 조합)이 같은 키가 된다.
 * - 소문자 변환을 먼저 해서 키가 소문자 결과만의 함수다. 그래서 대소문자만 다른 이름은 항상 키가 같다.
 *   NFC를 먼저 하면 소문자 결과가 NFC가 아닐 때 갈린다. 예: U+03A9 U+0342와 U+03C9 U+0342.
 * - `toLowerCase`는 로캘과 무관하다. `toLocaleLowerCase`를 쓰면 실행 환경에 따라 키가 달라진다.
 * - 키는 판정에만 쓴다. 저장하고 복원하는 이름은 바꾸지 않는다.
 * - 입력은 `checkPath`를 통과한 조각이다. 짝 없는 서로게이트는 이미 거부되어 있다.
 * - 키 길이는 조각 길이의 3배 이하다(NFC가 1 유닛을 3 유닛까지 늘린다). 조각 길이는 `maxPathLength` 이하다.
 */
function siblingKey(name: string): string {
  return name.toLowerCase().normalize("NFC");
}

/**
 * 경로의 각 조각을 검사한다. 마지막 조각만 노드 종류를 따르고 나머지는 폴더다.
 * 호출자의 `checkSegment`가 먼저, 무결성 규칙이 다음이다. 호출자 규칙이 무결성 규칙을 풀 수 없다.
 */
function checkPath(
  rules: ProjectFileRules,
  node: PlannedNode,
): ProjectNameCause | null {
  if (node.path.length > rules.maxPathLength) return "path-too-long";
  const segments = node.path.split("/");
  const last = segments.length - 1;
  for (const [index, segment] of segments.entries()) {
    const kind =
      index < last || node.type === "folder"
        ? "folder"
        : node.type === "text"
          ? "file"
          : "asset";
    const rejected = rules.checkSegment?.(kind, segment) ?? null;
    if (rejected !== null) return rejected;
    const broken = checkIntegrity(segment);
    if (broken !== null) return broken;
  }
  return null;
}

/**
 * 이름과 한도를 검사한다. 통과하면 `null`이다. 처음 걸린 하나를 돌려준다.
 *
 * 검사 순서:
 * - 항목마다: 경로 길이와 조각별 이름 규칙, 형제 사이 중복, 파일 개수, 폴더 개수.
 *   중복은 대소문자와 NFC 정규형 차이를 무시한다(`siblingKey`). 폴더는 조상으로도 한 번씩 센다.
 *   폴더 개수는 서로 다른 폴더 경로의 수다. 조상으로만 나오는 폴더도 든다.
 *   개수를 항목마다 보므로 검사 비용이 입력 항목 수가 아니라 한도에 묶인다.
 * - 끝에: asset 하나, asset 합계, 코드 합계, 풀었을 때의 전체 합계.
 *   코드와 asset은 `rules.isCode`로 나눈다. 텍스트 항목만 코드가 될 수 있다.
 */
export function checkProject(
  rules: ProjectFileRules,
  nodes: readonly PlannedNode[],
  limits: ProjectFileLimits,
): ProjectFileFailure | null {
  // 키는 부모 번호와 `siblingKey` 조각이다. 접두 경로 문자열을 만들지 않아 비용이 경로 길이에 비례한다.
  // 번호는 1부터다. 0은 최상위다.
  const claimed = new Map<
    string,
    { id: number; name: string; folder: boolean }
  >();
  let fileCount = 0;
  let folderCount = 0;
  /** 이름을 차지하고 번호를 돌려준다. 형제와 겹치면 `null`이다. */
  const claim = (parent: number, name: string, folder: boolean) => {
    const key = `${parent}/${siblingKey(name)}`;
    const prior = claimed.get(key);
    if (prior === undefined) {
      const id = claimed.size + 1;
      claimed.set(key, { id, name, folder });
      if (folder) folderCount += 1;
      else fileCount += 1;
      return id;
    }
    // 같은 폴더를 조상과 폴더 항목으로 두 번 세는 것만 허용한다.
    // 부모 번호가 같으면 부모 경로도 글자까지 같다. 대소문자나 정규형이 다르면 이미 중복으로 걸렸다.
    return folder && prior.folder && prior.name === name ? prior.id : null;
  };

  for (const node of nodes) {
    const cause = checkPath(rules, node);
    if (cause !== null) {
      return { reason: "invalid-name", path: node.path, cause };
    }
    const segments = node.path.split("/");
    let parent = 0;
    for (const [index, segment] of segments.entries()) {
      const isLeaf = index === segments.length - 1;
      const id = claim(parent, segment, !isLeaf || node.type === "folder");
      if (id === null) {
        return {
          reason: "invalid-name",
          path: node.path,
          cause: "duplicate",
        };
      }
      parent = id;
    }
    if (fileCount > limits.maxFiles) {
      return { reason: "limit-exceeded", limit: "maxFiles" };
    }
    if (folderCount > limits.maxFolders) {
      return { reason: "limit-exceeded", limit: "maxFolders" };
    }
  }

  let assetBytes = 0;
  let codeBytes = 0;
  for (const node of nodes) {
    if (node.type === "folder") continue;
    if (node.type === "text" && rules.isCode(node.path)) {
      codeBytes += node.size;
    } else {
      if (node.size > limits.maxAssetBytes) {
        return { reason: "limit-exceeded", limit: "maxAssetBytes" };
      }
      assetBytes += node.size;
    }
  }
  if (assetBytes > limits.maxAssetsTotalBytes) {
    return { reason: "limit-exceeded", limit: "maxAssetsTotalBytes" };
  }
  if (codeBytes > limits.maxCodeBytes) {
    return { reason: "limit-exceeded", limit: "maxCodeBytes" };
  }
  if (assetBytes + codeBytes > limits.maxUncompressedBytes) {
    return { reason: "limit-exceeded", limit: "maxUncompressedBytes" };
  }
  return null;
}
