// 배포 tarball을 소비자 경로로 설치해 Node에서 실제로 쓸 수 있는지 검사한다.
// - `npm pack`으로 묶은 tarball을 임시 디렉터리에 설치하고, 패키지 이름으로 import한다.
//   `exports` 맵과 `dist`까지 소비자와 같은 경로로 지난다. 워크스페이스의 `src`나 `dist`는 거치지 않는다.
// - vitest 없이 `node:assert`만 쓴다. 시험 도구의 Node 요구와 무관하게 matrix의 각 Node에서 돈다.
// - 이 스크립트는 검사 대상을 만들지 않는다. `dist`가 없으면 먼저 `pnpm build`를 하라고 알리고 멈춘다.
// - 기본은 현재 Node의 npm으로 pack한다. tarball 경로를 인자로 주면 pack을 건너뛰고 그 파일을 설치한다.
//   CI는 Node 24에서 pack한 tarball을 Node 버전별로 소비한다.
// - 설치 단계가 npm 레지스트리에서 `fflate`를 받으므로 네트워크가 필요하다.
// - 사용: `node scripts/check-consume.mjs [tarball 경로]`.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@cp949/projectfile";
const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
// 임시 디렉터리로 복사된 자신을 검사 모드로 다시 실행하는 인자다.
const RUN_FLAG = "--run-checks";
const RUN_FILE = "consume-run.mjs";

if (process.argv[2] === RUN_FLAG) {
  await runChecks();
} else {
  prepareAndRun();
}

/** tarball을 임시 디렉터리에 설치하고, 검사 모드의 자신을 그 디렉터리에서 실행한다. */
function prepareAndRun() {
  const tmp = mkdtempSync(join(tmpdir(), "projectfile-consume-"));
  try {
    // 빈 인자는 pack으로 넘어가지 않고 실패한다. CI에서 tarball 경로 전달이 깨지면 matrix Node의 npm으로 몰래 pack하게 된다.
    const argument = process.argv[2];
    assert.ok(argument !== "", "tarball 경로 인자가 비었다");
    const tarball =
      argument === undefined ? packTarball(tmp) : resolve(argument);
    assert.ok(existsSync(tarball), `tarball이 없다: ${tarball}`);

    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ name: "consume-check", private: true, type: "module" }),
    );
    console.log(`Node ${process.version}, npm ${npmVersion()}`);
    console.log(`설치: ${tarball}`);
    execFileSync(
      "npm",
      ["install", "--no-audit", "--no-fund", "--ignore-scripts", tarball],
      { cwd: tmp, stdio: "inherit" },
    );

    // 검사 코드는 임시 디렉터리 안에서 import해야 한다.
    // 저장소 안에서 import하면 패키지 자기 참조로 워크스페이스의 dist가 잡힌다.
    copyFileSync(fileURLToPath(import.meta.url), join(tmp, RUN_FILE));
    const result = spawnSync(process.execPath, [RUN_FILE, RUN_FLAG], {
      cwd: tmp,
      stdio: "inherit",
    });
    if (result.status !== 0) process.exitCode = result.status ?? 1;
  } catch (error) {
    console.error(`소비 검사 준비에 실패했다: ${error.message}`);
    process.exitCode = 1;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
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

function npmVersion() {
  return execFileSync("npm", ["--version"], { encoding: "utf8" }).trim();
}

/** 설치된 패키지를 이름으로 import해 최소 집합을 단언한다. 실패하면 비정상 종료한다. */
async function runChecks() {
  try {
    const installedDir = join("node_modules", PACKAGE_NAME);
    const installed = JSON.parse(
      readFileSync(join(installedDir, "package.json"), "utf8"),
    );
    // import 형식은 package.json이 정한다. 형식이 바뀌면 이 검사의 import 방식도 고쳐야 한다.
    assert.equal(installed.type, "module", "ESM 패키지가 아니다");
    assert.ok(
      !("require" in installed.exports["."]),
      "exports에 require 조건이 생겼다. 검사에 CJS require 경로를 더한다",
    );
    // 타입 선언은 import로 확인되지 않는다. `files`에서 빠지면 여기서 잡는다.
    for (const target of [
      installed.main,
      installed.types,
      ...Object.values(installed.exports["."]),
    ]) {
      assert.ok(
        existsSync(join(installedDir, target)),
        `package.json이 가리키는 파일이 tarball에 없다: ${target}`,
      );
    }

    const projectfile = await import(PACKAGE_NAME);
    // dist가 내보내는 값 이름이다. 타입만 내보내는 이름은 런타임에 없다. `src/index.ts`의 값 export를 바꾸면 이 목록도 고친다.
    assert.deepEqual(Object.keys(projectfile).sort(), [
      "DEFAULT_SCRAMBLE_KEY",
      "MAX_HEADER_BYTES",
      "MAX_PATH_LENGTH_CEILING",
      "MAX_UNCOMPRESSED_BYTES_CEILING",
      "PROJECT_FILE_MIME",
      "decodeProjectFile",
      "encodeProjectFile",
      "maxProjectFileBytes",
      "readProjectFileHeader",
    ]);
    const {
      decodeProjectFile,
      encodeProjectFile,
      PROJECT_FILE_MIME,
      readProjectFileHeader,
    } = projectfile;

    const kind = "consume.check";
    const text = "const 인사 = 'hello';\n";
    const assetBytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    const config = {
      kind,
      rules: { maxPathLength: 255, isCode: (path) => path.endsWith(".ts") },
      limits: {
        maxFiles: 10,
        maxFolders: 10,
        maxAssetBytes: 1024,
        maxAssetsTotalBytes: 4096,
        maxCodeBytes: 4096,
        maxUncompressedBytes: 65536,
      },
    };

    // 텍스트, asset Blob, 빈 폴더가 든 프로젝트를 인코딩한다.
    const encoded = await encodeProjectFile({
      ...config,
      entries: [
        { path: "src/main.ts", type: "text", data: text },
        { path: "assets/a.bin", type: "asset", data: new Blob([assetBytes]) },
      ],
      folders: ["empty"],
    });
    assert.equal(encoded.ok, true, "인코딩이 실패했다");
    const file = encoded.value;
    assert.ok(
      file instanceof globalThis.Blob,
      "인코더 결과가 Node 전역 Blob이 아니다",
    );
    assert.equal(file.type, PROJECT_FILE_MIME);
    assert.equal(PROJECT_FILE_MIME, "application/octet-stream");
    console.log("ok - 인코딩 결과가 Node 전역 Blob이다");

    // Blob 입력 디코딩이 입력과 같은 값을 돌려준다.
    const decoded = await decodeProjectFile(file, config);
    assert.equal(decoded.ok, true, "Blob 디코딩이 실패했다");
    await assertRoundTrip(decoded.value);
    console.log("ok - Blob 왕복(텍스트, asset, 빈 폴더)");

    // Uint8Array 입력도 같은 값을 돌려준다.
    const bytes = new Uint8Array(await file.arrayBuffer());
    const decodedBytes = await decodeProjectFile(bytes, config);
    assert.equal(decodedBytes.ok, true, "Uint8Array 디코딩이 실패했다");
    await assertRoundTrip(decodedBytes.value);
    console.log("ok - Uint8Array 입력 디코딩");

    // 헤더만 읽는다. 헤더는 22바이트에 kind 길이를 더한 크기다.
    const header = await readProjectFileHeader(bytes);
    assert.equal(header.ok, true, "헤더 읽기가 실패했다");
    assert.equal(header.value.version, 1);
    assert.equal(header.value.kind, kind);
    assert.equal(header.value.headerBytes, 22 + kind.length);
    assert.equal(
      header.value.payloadLength,
      bytes.length - header.value.headerBytes,
    );
    console.log("ok - readProjectFileHeader");

    // 열 수 없는 입력은 던지지 않고 거부 이유를 돌려준다.
    const rejected = await decodeProjectFile(new Uint8Array(100), config);
    assert.deepEqual(rejected, { ok: false, failure: { reason: "bad-magic" } });
    console.log("ok - 잘못된 입력은 ok:false와 bad-magic");

    console.log(`소비 검사 통과 (Node ${process.version})`);

    async function assertRoundTrip(value) {
      assert.equal(value.kind, kind);
      assert.equal(value.entries.length, 2);
      const [textEntry, assetEntry] = value.entries;
      assert.deepEqual(textEntry, {
        path: "src/main.ts",
        type: "text",
        data: text,
      });
      assert.equal(assetEntry.path, "assets/a.bin");
      assert.equal(assetEntry.type, "asset");
      assert.ok(assetEntry.data instanceof globalThis.Blob);
      assert.deepEqual(
        new Uint8Array(await assetEntry.data.arrayBuffer()),
        assetBytes,
      );
      // 조상 폴더도 폴더 항목으로 담긴다. 순서는 옵션 `folders`가 먼저고 `entries`의 조상이 뒤다(docs/format.md "항목 순서").
      assert.deepEqual(value.folders, ["empty", "src", "assets"]);
    }
  } catch (error) {
    console.error(`소비 검사 실패 (Node ${process.version}): ${error.stack}`);
    process.exit(1);
  }
}
