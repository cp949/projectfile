// 텍스트 위주 시간 구간 측정의 진입점. Node와 Chrome에서 `text-heavy` 시나리오의 구간 시간을 낸다.
// - 사용: `pnpm --filter @cp949/projectfile measure:sections [반복 횟수]`. 기본은 5회다. `dist`가 필요하다.
// - `pnpm test`와 `pnpm verify`에 들어가지 않는다. 수 분이 걸리고 브라우저가 필요하다.
// - `crc32`는 `src/crc32.ts`를 타입만 지워서 쓴다. `dist`에 묶인 함수는 밖으로 내보내지 않기 때문이다.
//   `src/crc32.ts`가 타입 지우기로 바뀌지 않는 문법을 쓰면 이 스크립트가 실패한다.
//   Node가 `stripTypeScriptTypes`의 ExperimentalWarning을 한 줄 낸다. 측정에는 영향이 없다.
// - 종료 코드: 0은 성공, 1은 측정 실패(예외, 라이브러리 결과 불일치), 2는 준비 오류(`dist` 없음, 잘못된 반복 횟수).
// - 방법과 결과 해석은 ADR-0001에 있다.
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { cpus, release, totalmem } from "node:os";
import { crc32 as zlibCrc32 } from "node:zlib";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { DECODE_SEGMENTS, ENCODE_SEGMENTS, runSections } from "./sections.mjs";

const PACKAGE_DIR = fileURLToPath(new URL("../..", import.meta.url));
const DIST = `${PACKAGE_DIR}dist/index.js`;

const MIB = 1024 * 1024;
const mib = (bytes) => `${(bytes / MIB).toFixed(1)} MiB`;

const LABELS = {
  utf8: "UTF-8 변환",
  crc32: "CRC32",
  deflate: "deflate",
  inflate: "inflate",
  total: "전체",
};

const PAGE = `<!doctype html>
<meta charset="utf-8">
<script type="importmap">{"imports":{"fflate":"/vendor/fflate.js"}}</script>
<script type="module">
  import * as lib from "/lib/index.js";
  import { crc32 } from "/crc32.js";
  import { runSections } from "/sections.mjs";
  window.runSections = (runs) => runSections(lib, { crc32 }, runs, () => {});
  window.measureReady = true;
</script>
`;

/** 반복 횟수를 읽는다. 5 이상의 정수여야 한다. */
function parseRuns(argument) {
  if (argument === undefined) return 5;
  const runs = Number(argument);
  if (!Number.isInteger(runs) || runs < 5) {
    console.error(`반복 횟수는 5 이상의 정수여야 한다: ${argument}`);
    process.exit(2);
  }
  return runs;
}

/** `src/crc32.ts`를 타입만 지운 모듈 소스로 돌려준다. */
function crc32ModuleSource() {
  return stripTypeScriptTypes(
    readFileSync(`${PACKAGE_DIR}src/crc32.ts`, "utf8"),
  );
}

/** 타입을 지운 `crc32`가 `node:zlib`의 CRC32와 같은 값을 내는지 대조한다. 다르면 던진다. */
function assertCrc32Matches(crc32) {
  // 길이를 8의 배수와 꼬리가 있는 값으로 섞고 앞 조각 이어 계산도 본다.
  const data = new Uint8Array(1000003);
  for (let i = 0; i < data.length; i += 1) data[i] = (i * 31 + (i >> 8)) & 0xff;
  const sizes = [0, 1, 7, 8, 9, 1000, data.length];
  for (const size of sizes) {
    const part = data.subarray(0, size);
    if (crc32(part) !== zlibCrc32(part)) {
      throw new Error(`crc32가 node:zlib과 다르다(길이 ${size})`);
    }
  }
  const head = data.subarray(0, 4099);
  const joined = crc32(data.subarray(4099, 9000), crc32(head));
  if (joined !== zlibCrc32(data.subarray(0, 9000))) {
    throw new Error("crc32 이어 계산이 node:zlib과 다르다");
  }
}

/** 페이지와 모듈을 내주는 서버를 연다. 주소를 돌려준다. */
async function startServer(crc32Source) {
  const files = {
    "/lib/index.js": readFileSync(DIST),
    "/vendor/fflate.js": readFileSync(
      `${PACKAGE_DIR}node_modules/fflate/esm/browser.js`,
    ),
    "/sections.mjs": readFileSync(
      `${PACKAGE_DIR}scripts/measure-ceiling/sections.mjs`,
    ),
    "/workload.mjs": readFileSync(
      `${PACKAGE_DIR}scripts/measure-ceiling/workload.mjs`,
    ),
    "/crc32.js": crc32Source,
  };
  const server = createServer((req, res) => {
    const path = req.url.split("?")[0];
    if (path === "/") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(PAGE);
      return;
    }
    const body = files[path];
    if (body === undefined) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader("content-type", "text/javascript; charset=utf-8");
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

/** Chrome에서 구간 시간을 잰다. 브라우저 버전을 함께 돌려준다. */
async function measureChrome(crc32Source, runs) {
  const { server, origin } = await startServer(crc32Source);
  let browser;
  try {
    browser = await chromium.launch({ channel: "chromium" });
    const version = browser.version();
    const page = await browser.newPage();
    page.setDefaultTimeout(0);
    const failure = new Promise((_, reject) => {
      page.on("crash", () => reject(new Error("렌더러가 종료됐다(crash)")));
      page.on("pageerror", (error) => reject(error));
    });
    // 평가가 먼저 끝나면 뒤늦은 거부가 처리되지 않은 거부가 되지 않게 한다.
    failure.catch(() => {});
    await page.goto(origin);
    await page.waitForFunction(() => window.measureReady === true);
    const result = await Promise.race([
      page.evaluate((count) => window.runSections(count), runs),
      failure,
    ]);
    return { version, result };
  } finally {
    await browser?.close();
    server.close();
  }
}

/** 값 목록의 중앙값. 짝수 개면 가운데 두 값의 평균이다. */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

const sec = (ms) => `${(ms / 1000).toFixed(3)} s`;

/** 한 환경의 구간 표를 출력한다. 비율은 같은 쪽 전체 시간의 중앙값에 대한 값이다. */
function report(name, result) {
  console.log(`\n[${name}]`);
  const { sizes } = result;
  console.log(
    `  텍스트 UTF-8 바이트 합계: ${sizes.textBytes}(${mib(sizes.textBytes)})`,
  );
  console.log(
    `  텍스트 deflate 바이트 합계: ${sizes.deflatedBytes}(${mib(sizes.deflatedBytes)})`,
  );
  console.log(
    `  인코딩 출력: ${sizes.encodedBytes} 바이트(${mib(sizes.encodedBytes)})`,
  );
  for (const [side, names, label] of [
    ["encode", ENCODE_SEGMENTS, "인코딩"],
    ["decode", DECODE_SEGMENTS, "디코딩"],
  ]) {
    const rows = result[side];
    const total = median(rows.total);
    console.log(`\n  ${label}   (구간 | 중앙값 | 최소~최대 | 전체 대비)`);
    for (const segment of names) {
      const values = rows[segment];
      const mid = median(values);
      console.log(
        `    ${LABELS[segment].padEnd(10)} ${sec(mid)}  ${sec(Math.min(...values))}~${sec(Math.max(...values))}  ${((mid / total) * 100).toFixed(1)}%`,
      );
    }
    // 세 구간의 합은 회마다 더한 값이다. 전체와의 차이가 그 밖의 시간이다.
    const sums = rows.total.map(
      (_, i) => rows[names[0]][i] + rows[names[1]][i] + rows[names[2]][i],
    );
    const others = rows.total.map((value, i) => value - sums[i]);
    const sum = median(sums);
    const other = median(others);
    console.log(
      `    ${"세 구간 합".padEnd(10)} ${sec(sum)}  ${sec(Math.min(...sums))}~${sec(Math.max(...sums))}  ${((sum / total) * 100).toFixed(1)}%`,
    );
    console.log(
      `    ${"그 밖".padEnd(10)} ${sec(other)}  ${sec(Math.min(...others))}~${sec(Math.max(...others))}  ${((other / total) * 100).toFixed(1)}%`,
    );
    console.log(`  ${label} 회차별 시간(ms):`);
    for (const segment of names) {
      console.log(
        `    ${LABELS[segment]}: ${rows[segment].map((ms) => ms.toFixed(1)).join(", ")}`,
      );
    }
  }
  const asset = result.assetCrc;
  console.log(
    `\n  참고: 인코딩 전체에 든 asset Blob 읽기와 CRC32 ${sec(median(asset))} (${sec(Math.min(...asset))}~${sec(Math.max(...asset))})`,
  );
}

if (!existsSync(DIST)) {
  console.error("dist가 없다. 먼저 `pnpm build`를 실행한다.");
  process.exit(2);
}
const runs = parseRuns(process.argv[2]);

const source = crc32ModuleSource();
const nodeCrc32 = (
  await import(
    `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
  )
).crc32;
assertCrc32Matches(nodeCrc32);

const lib = await import(DIST);
const require = createRequire(import.meta.url);
console.log("[환경]");
console.log(`  OS: ${release()} (${process.platform} ${process.arch})`);
console.log(`  CPU: ${cpus()[0].model}, 논리 코어 ${cpus().length}개`);
console.log(`  RAM: ${mib(totalmem())}`);
console.log(`  Node: ${process.version}`);
console.log(
  `  playwright-core: ${require("playwright-core/package.json").version}`,
);
console.log(`  반복: 워밍업 1회 + ${runs}회`);

let failed = false;
try {
  console.log("\nNode 측정 중...");
  const node = await runSections(lib, { crc32: nodeCrc32 }, runs, (line) =>
    console.log(`  Node ${line}`),
  );
  report("Node", node);
} catch (error) {
  failed = true;
  console.error(
    `Node 측정 실패: ${error instanceof Error ? error.message : error}`,
  );
}
try {
  console.log("\nChrome 측정 중...");
  const chrome = await measureChrome(source, runs);
  console.log(`  브라우저: Chrome for Testing(Chromium) ${chrome.version}`);
  report("Chrome", chrome.result);
} catch (error) {
  failed = true;
  console.error(
    `Chrome 측정 실패: ${error instanceof Error ? error.message : error}`,
  );
}
process.exit(failed ? 1 : 0);
