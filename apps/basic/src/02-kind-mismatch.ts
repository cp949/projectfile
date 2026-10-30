// 만든 파일과 다른 kind로 열면 `kind-mismatch`로 실패하는 것을 보인다.
// - 열 수 없는 파일은 던지지 않고 `ok: false`와 `failure.reason`을 돌려준다.
// - 실행: node src/02-kind-mismatch.ts
import { decodeProjectFile, encodeProjectFile } from "@cp949/projectfile";
import type { ProjectFileLimits, ProjectFileRules } from "@cp949/projectfile";

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

// "example.basic" kind로 만든다.
const encoded = await encodeProjectFile({
  kind: "example.basic",
  entries: [{ path: "project.json", type: "text", data: "{}" }],
  rules,
  limits,
});
if (!encoded.ok) throw new Error(`인코딩 실패: ${encoded.failure.reason}`);

// "example.other" kind를 기대하며 연다.
const decoded = await decodeProjectFile(encoded.value, {
  kind: "example.other",
  rules,
  limits,
});
if (decoded.ok) {
  console.log("디코딩 성공 (예상과 다르다)");
} else {
  console.log(`디코딩 실패: ${decoded.failure.reason}`);
}
