// 저장소 루트 `test-vectors/`의 시험 파일과 `vectors.json`을 다시 만든다.
// - 빌드한 `dist`로 만든다. 먼저 `pnpm build`가 필요하다. 루트 `pnpm vectors:generate`가 둘을 이어 부른다.
// - 기존 `.bin` 파일은 지우고 새로 쓴다. 사례를 줄여도 낡은 파일이 남지 않는다.
// - 다시 돌려 `git diff`가 비어야 한다. 결정적이라는 뜻이다.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildVectors } from "./build-vectors.mjs";
import * as lib from "../dist/index.js";

const OUT_DIR = fileURLToPath(
  new URL("../../../test-vectors", import.meta.url),
);

const { files, json } = await buildVectors(lib);
mkdirSync(OUT_DIR, { recursive: true });
for (const name of readdirSync(OUT_DIR)) {
  if (name.endsWith(".bin")) rmSync(join(OUT_DIR, name));
}
for (const [name, bytes] of files) writeFileSync(join(OUT_DIR, name), bytes);
writeFileSync(join(OUT_DIR, "vectors.json"), json);
console.log(`test-vectors: 파일 ${files.size}개와 vectors.json을 썼다`);
