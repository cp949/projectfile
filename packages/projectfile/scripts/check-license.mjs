// 배포 tarball에 LICENSE가 들어가는지 검사한다.
// - 루트 LICENSE와 패키지 LICENSE가 바이트 단위로 같아야 한다.
// - `npm pack --dry-run` 파일 목록에 LICENSE가 있어야 한다. npm은 패키지 디렉터리의 LICENSE만 자동으로 넣는다.
// - 루트 LICENSE가 원본이다. 어긋나면 루트 파일을 패키지 디렉터리로 복사해 고친다.
// - 사용: `node scripts/check-license.mjs`.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const ROOT_LICENSE = new URL("../../../LICENSE", import.meta.url);
const PACKAGE_LICENSE = new URL("../LICENSE", import.meta.url);

const failures = [];

try {
  const root = readFileSync(ROOT_LICENSE);
  const pkg = readFileSync(PACKAGE_LICENSE);
  if (!root.equals(pkg)) {
    failures.push(
      "루트 LICENSE와 packages/projectfile/LICENSE의 내용이 다르다. 루트 파일을 복사해 맞춘다.",
    );
  }
} catch (error) {
  failures.push(`LICENSE를 읽지 못했다: ${error.message}`);
}

try {
  // --ignore-scripts: prepack·prepare가 생겨도 검사가 빌드를 돌리거나 stdout JSON을 깨지 않게 한다.
  // stderr를 pipe로 받아야 실패 시 error.message에 npm의 오류 내용이 붙는다.
  const output = execFileSync(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    {
      cwd: PACKAGE_DIR,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const files = JSON.parse(output)[0].files.map((file) => file.path);
  if (!files.includes("LICENSE")) {
    failures.push(
      `npm pack 파일 목록에 LICENSE가 없다. 목록: ${files.join(", ")}`,
    );
  }
} catch (error) {
  failures.push(`npm pack --dry-run을 실행하지 못했다: ${error.message}`);
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exit(1);
}
console.log("LICENSE 검사 통과");
