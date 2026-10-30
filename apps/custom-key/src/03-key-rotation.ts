// 키를 바꾼 뒤에도 옛 키로 만든 파일을 여는 방법을 보인다.
// - 새 파일은 새 키로 만든다.
// - 디코딩 `scrambleKeys`에 새 키와 옛 키를 함께 둔다.
// - 디코딩은 헤더의 키 확인값과 같은 키를 목록에서 골라 쓴다.
// - 실행: node src/03-key-rotation.ts
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

const oldKey = crypto.getRandomValues(new Uint8Array(16));
const newKey = crypto.getRandomValues(new Uint8Array(16));

// 키를 바꾸기 전에 만든 파일과 바꾼 뒤에 만든 파일이다.
const oldFile = await encodeProjectFile({
  kind,
  entries: [{ path: "project.json", type: "text", data: '{"made":"old"}' }],
  rules,
  limits,
  scrambleKey: oldKey,
});
const newFile = await encodeProjectFile({
  kind,
  entries: [{ path: "project.json", type: "text", data: '{"made":"new"}' }],
  rules,
  limits,
  scrambleKey: newKey,
});
if (!oldFile.ok) throw new Error(`인코딩 실패: ${oldFile.failure.reason}`);
if (!newFile.ok) throw new Error(`인코딩 실패: ${newFile.failure.reason}`);

// 같은 키 목록으로 두 파일을 모두 연다.
const scrambleKeys = [newKey, oldKey];
for (const [label, file] of [
  ["옛 키 파일", oldFile.value],
  ["새 키 파일", newFile.value],
] as const) {
  const decoded = await decodeProjectFile(file, {
    kind,
    rules,
    limits,
    scrambleKeys,
  });
  if (!decoded.ok) {
    console.log(`${label}: ${decoded.failure.reason}`);
    continue;
  }
  const entry = decoded.value.entries[0];
  if (entry?.type === "text") console.log(`${label}: ${entry.data}`);
}
