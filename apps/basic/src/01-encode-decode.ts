// 기본 scramble 키로 프로젝트 파일을 만들고 다시 연다.
// - `scrambleKey`와 `scrambleKeys`를 주지 않으면 양쪽 모두 `DEFAULT_SCRAMBLE_KEY`를 쓴다.
// - 실행: node src/01-encode-decode.ts
import { decodeProjectFile, encodeProjectFile } from "@cp949/projectfile";
import type { ProjectFileLimits, ProjectFileRules } from "@cp949/projectfile";

// 인코딩과 디코딩은 같은 kind, rules, limits를 써야 한다.
const kind = "example.basic";
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

// 텍스트 항목, asset 항목, 빈 폴더를 담는다.
const encoded = await encodeProjectFile({
  kind,
  entries: [
    { path: "project.json", type: "text", data: '{"title":"hello"}' },
    {
      path: "media/logo.png",
      type: "asset",
      data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    },
  ],
  folders: ["empty"],
  rules,
  limits,
});
if (!encoded.ok) throw new Error(`인코딩 실패: ${encoded.failure.reason}`);
console.log(`인코딩 결과: ${encoded.value.size}바이트 (${encoded.value.type})`);

// 인코딩 결과 Blob을 그대로 디코딩에 넘긴다.
const decoded = await decodeProjectFile(encoded.value, { kind, rules, limits });
if (!decoded.ok) throw new Error(`디코딩 실패: ${decoded.failure.reason}`);

console.log(`kind: ${decoded.value.kind}`);
for (const entry of decoded.value.entries) {
  if (entry.type === "text") {
    console.log(`text  ${entry.path}: ${entry.data}`);
  } else {
    console.log(`asset ${entry.path}: ${entry.data.size}바이트`);
  }
}
// 파일의 조상 폴더(media)도 폴더 항목으로 돌아온다.
console.log(`folders: ${decoded.value.folders.join(", ")}`);
