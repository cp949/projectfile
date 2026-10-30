// 배포 tarball의 package.json 메타데이터와 타입 해석을 검사한다.
// - publint: `exports`, `files`, `types` 같은 필드가 가리키는 경로와 형식이 맞는지 본다. 경고도 실패로 취급한다(`--strict`).
// - attw(@arethetypeswrong/cli): node10, node16, bundler 해석별로 타입 선언이 풀리는지 본다.
// - 두 도구는 같은 tarball을 검사한다. 소비자가 받는 파일 그대로다.
// - 이 스크립트는 검사 대상을 만들지 않는다. `dist`가 없으면 먼저 `pnpm build`를 하라고 알리고 멈춘다.
// - tarball 경로를 인자로 주면 pack을 건너뛴다.
// - 사용: `node scripts/check-package.mjs [tarball 경로]`. `pnpm check:package`가 실행하면 두 도구가 PATH에 잡힌다.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));

const tmp = mkdtempSync(join(tmpdir(), "projectfile-package-"));
try {
  // 빈 인자는 pack으로 넘어가지 않고 실패한다. 경로 전달이 깨졌을 때 몰래 pack하지 않게 한다.
  const argument = process.argv[2];
  assert.ok(argument !== "", "tarball 경로 인자가 비었다");
  const tarball = argument === undefined ? packTarball(tmp) : resolve(argument);
  assert.ok(existsSync(tarball), `tarball이 없다: ${tarball}`);
  console.log(`검사 대상: ${tarball}`);

  const failed = [
    run("publint", ["run", "--strict", tarball]),
    // cjs-resolves-to-esm만 무시한다. 이 패키지는 ESM 전용이라 node16(CJS) 해석이 ESM으로 풀리는 것이 의도다.
    // 다른 규칙과 node10, node16(ESM), bundler 해석은 그대로 검사한다.
    // @types를 npm 레지스트리에서 찾는 단계는 끈다. 이 패키지는 자기 타입을 싣고 있고, 끄면 네트워크가 필요 없다.
    run("attw", [
      tarball,
      "--ignore-rules",
      "cjs-resolves-to-esm",
      "--no-definitely-typed",
    ]),
  ].filter((name) => name !== undefined);

  if (failed.length > 0) {
    console.error(`패키지 검사 실패: ${failed.join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log("패키지 검사 통과");
  }
} catch (error) {
  console.error(`패키지 검사 준비에 실패했다: ${error.message}`);
  process.exitCode = 1;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

/** 도구를 실행하고 실패하면 도구 이름을 돌려준다. 한 도구의 실패가 다른 도구의 결과를 가리지 않게 둘 다 실행한다. */
function run(name, args) {
  console.log(`\n== ${name}`);
  const result = spawnSync(name, args, { cwd: PACKAGE_DIR, stdio: "inherit" });
  // 실행 파일을 찾지 못하면 도구가 아무것도 출력하지 않는다. 원인을 대신 출력한다.
  if (result.error) console.error(`${name} 실행 실패: ${result.error.message}`);
  // status가 null인 경우(실행 실패, 신호 종료)도 실패로 본다.
  return result.status === 0 ? undefined : name;
}

/** 패키지 디렉터리를 `npm pack`으로 묶고 tarball 경로를 돌려준다. */
function packTarball(destination) {
  assert.ok(
    existsSync(join(PACKAGE_DIR, "dist", "index.js")),
    "dist/index.js가 없다. 먼저 `pnpm build`를 실행한다.",
  );
  // --ignore-scripts: prepack 등이 빌드를 돌리거나 stdout JSON을 깨지 않게 한다.
  const output = execFileSync(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", destination],
    {
      cwd: PACKAGE_DIR,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  return join(destination, JSON.parse(output)[0].filename);
}
