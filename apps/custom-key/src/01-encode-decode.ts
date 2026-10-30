// 사용처 scramble 키로 프로젝트 파일을 만들고 같은 키로 다시 연다.
// - 인코딩은 `scrambleKey`에 키 하나를 준다.
// - 디코딩은 `scrambleKeys`에 풀 수 있는 키 목록을 준다.
// - 실행: node src/01-encode-decode.ts
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

// 키는 길이 16의 Uint8Array다.
// 실제 사용처는 키를 한 번 만들어 보관한다. 키를 잃으면 그 키로 만든 파일을 열 수 없다.
const scrambleKey = crypto.getRandomValues(new Uint8Array(16));

const encoded = await encodeProjectFile({
  kind,
  entries: [{ path: "project.json", type: "text", data: '{"title":"hello"}' }],
  rules,
  limits,
  scrambleKey,
});
if (!encoded.ok) throw new Error(`인코딩 실패: ${encoded.failure.reason}`);
console.log(`인코딩 결과: ${encoded.value.size}바이트`);

const decoded = await decodeProjectFile(encoded.value, {
  kind,
  rules,
  limits,
  scrambleKeys: [scrambleKey],
});
if (!decoded.ok) throw new Error(`디코딩 실패: ${decoded.failure.reason}`);

for (const entry of decoded.value.entries) {
  if (entry.type === "text") console.log(`text  ${entry.path}: ${entry.data}`);
}
