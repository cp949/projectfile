// 만든 키가 디코딩 키 목록에 없으면 `scramble-key-mismatch`로 실패하는 것을 보인다.
// - 두 경우를 차례로 연다.
//   - 다른 사용처 키로 연다.
//   - `scrambleKeys`를 비워 기본 키로 연다.
// - 실행: node src/02-key-mismatch.ts
import { decodeProjectFile, encodeProjectFile } from "@cp949/projectfile";
import type { ProjectFileLimits, ProjectFileRules } from "@cp949/projectfile";

const kind = "example.custom-key";
const rules: ProjectFileRules = {
  maxPathLength: 256,
  isCode: (path) => path.endsWith(".json"),
};
const limits: ProjectFileLimits = {
  maxFiles: 100,
  maxFolders: 100,
  maxAssetBytes: 1024 * 1024,
  maxAssetsTotalBytes: 10 * 1024 * 1024,
  maxCodeBytes: 1024 * 1024,
  maxUncompressedBytes: 11 * 1024 * 1024,
};

const scrambleKey = crypto.getRandomValues(new Uint8Array(16));
const otherKey = crypto.getRandomValues(new Uint8Array(16));

const encoded = await encodeProjectFile({
  kind,
  entries: [{ path: "project.json", type: "text", data: "{}" }],
  rules,
  limits,
  scrambleKey,
});
if (!encoded.ok) throw new Error(`인코딩 실패: ${encoded.failure.reason}`);

// 다른 사용처 키로 연다.
const withOtherKey = await decodeProjectFile(encoded.value, {
  kind,
  rules,
  limits,
  scrambleKeys: [otherKey],
});
console.log(
  `다른 키: ${withOtherKey.ok ? "성공 (예상과 다르다)" : withOtherKey.failure.reason}`,
);

// `scrambleKeys`를 비우면 기본 키만 쓴다. 사용처 키로 만든 파일은 열리지 않는다.
const withDefaultKey = await decodeProjectFile(encoded.value, {
  kind,
  rules,
  limits,
});
console.log(
  `기본 키: ${withDefaultKey.ok ? "성공 (예상과 다르다)" : withDefaultKey.failure.reason}`,
);
