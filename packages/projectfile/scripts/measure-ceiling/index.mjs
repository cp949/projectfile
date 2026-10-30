// 상한 측정 진입점. Node와 Chrome에서 풀린 크기 256 MiB 프로젝트를 시나리오별로 인코딩·디코딩해 시간과 메모리를 낸다.
// - 사용: `pnpm --filter @cp949/projectfile measure:ceiling [시나리오 이름...]`. 이름이 없으면 모든 시나리오를 돈다.
//   `dist`가 필요하므로 먼저 `pnpm build`를 한다.
// - `pnpm test`와 `pnpm verify`에 들어가지 않는다. 수 분이 걸리고 브라우저와 Linux `/proc`가 필요하다.
// - 종료 코드: 모두 성공하면 0. 하나라도 실패하면(예외, 메모리 부족, 내용 불일치) 이유를 내고 1.
//   준비 오류(`dist` 없음, 측정 크기와 상한 불일치, 알 수 없는 시나리오 이름)는 2다.
// - 방법, 놓치는 범위, 결과 해석은 ADR-0001에 있다.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { cpus, release, totalmem } from "node:os";
import { fileURLToPath } from "node:url";
import { measureChrome } from "./chrome-worker.mjs";
import {
  buildPlan,
  isCodePath,
  SCENARIOS,
  settingsFor,
  TARGET_BYTES,
} from "./workload.mjs";

const DIST = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
const WORKER = fileURLToPath(new URL("./node-worker.mjs", import.meta.url));

const MIB = 1024 * 1024;
const mib = (bytes) => `${(bytes / MIB).toFixed(1)} MiB`;
const sec = (ms) => `${(ms / 1000).toFixed(2)} s`;

/** Node 워커를 별도 프로세스로 돌려 결과 JSON을 받는다. 비정상 종료도 `ok: false`로 돌려준다. */
function measureNode(scenario) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WORKER, scenario], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.on("close", (code, signal) => {
      const line = out.trim().split("\n").pop();
      try {
        resolve(JSON.parse(line));
      } catch {
        resolve({
          ok: false,
          error: `워커가 결과 없이 끝났다(code ${code}, signal ${signal})`,
        });
      }
    });
  });
}

/** 대조 단계 전까지(인코딩·변환·디코딩 구간 포함) 단계별 최고점의 최댓값을 돌려준다. */
function peakBeforeVerify(peakByPhase) {
  const phases = Object.entries(peakByPhase).filter(
    ([name]) => name !== "verify" && name !== "done",
  );
  return {
    rss: Math.max(...phases.map(([, peak]) => peak.rss)),
    pss: Math.max(...phases.map(([, peak]) => peak.pss)),
  };
}

/** 단계별 최고점을 출력한다(Chrome). */
function printPhasePeaks(peakByPhase) {
  for (const [phase, peak] of Object.entries(peakByPhase)) {
    console.log(
      `    단계 ${phase}: RSS ${mib(peak.rss)}, PSS ${mib(peak.pss)}`,
    );
  }
}

/** 한 환경의 결과를 출력한다. */
function report(name, result) {
  console.log(`\n  [${name}]`);
  if (!result.ok) {
    console.log(`    실패: ${result.error}`);
    // Node 워커는 `phase`, Chrome은 `lastPhase`로 실패한 단계를 알린다.
    const failedPhase = result.phase ?? result.lastPhase;
    if (failedPhase !== undefined) {
      console.log(`    실패한 단계: ${failedPhase}`);
    }
    if (result.peakRssBytes !== undefined) {
      console.log(
        `    실패 시점까지 메모리 최고점(RSS): ${mib(result.peakRssBytes)}`,
      );
    }
    if (result.peakByPhase !== undefined) printPhasePeaks(result.peakByPhase);
    return;
  }
  console.log(
    `    풀린 크기: ${result.uncompressedBytes} 바이트(${mib(result.uncompressedBytes)})`,
  );
  console.log(
    `    항목: 파일 ${result.fileCount}개, 폴더 ${result.folderCount}개`,
  );
  console.log(
    `    인코딩 출력: ${result.encodedBytes} 바이트(${mib(result.encodedBytes)})`,
  );
  console.log(`    인코딩 시간: ${sec(result.encodeMs)}`);
  console.log(`    디코딩 시간: ${sec(result.decodeMs)}`);
  console.log(`    대조 시간: ${sec(result.verifyMs)}(측정 대상 아님)`);
  if (result.peakPssBytes !== undefined) {
    const before = peakBeforeVerify(result.peakByPhase);
    console.log(
      `    메모리 최고점, 대조 전까지: RSS ${mib(before.rss)}, PSS ${mib(before.pss)}`,
    );
    console.log(
      `    메모리 최고점, 대조 포함: RSS ${mib(result.peakRssBytes)}, PSS ${mib(result.peakPssBytes)}`,
    );
    console.log(`    표본 수: ${result.samples}`);
    printPhasePeaks(result.peakByPhase);
  } else {
    console.log(
      `    메모리 최고점(RSS), 대조 전까지: ${mib(result.peakAfterPhase.decode)}`,
    );
    console.log(
      `    메모리 최고점(RSS), 대조 포함: ${mib(result.peakRssBytes)}`,
    );
    for (const [phase, peak] of Object.entries(result.peakAfterPhase)) {
      console.log(`    ${phase} 끝까지 누적 최고점(RSS): ${mib(peak)}`);
    }
  }
}

/** 구성표의 종류별 파일 수와 바이트를 한 줄씩 출력한다. */
function describePlan(plan) {
  const kinds = {
    "코드 텍스트": (file) => file.type === "text" && isCodePath(file.path),
    "코드 아닌 텍스트": (file) =>
      file.type === "text" && !isCodePath(file.path),
    asset: (file) => file.type === "asset",
  };
  for (const [label, match] of Object.entries(kinds)) {
    const files = plan.files.filter(match);
    const bytes = files.reduce((sum, file) => sum + file.bytes, 0);
    console.log(
      `    ${label}: ${files.length}개, ${bytes} 바이트(${mib(bytes)})`,
    );
  }
}

if (!existsSync(DIST)) {
  console.error("dist가 없다. 먼저 `pnpm build`를 실행한다.");
  process.exit(2);
}

const names =
  process.argv.length > 2 ? process.argv.slice(2) : Object.keys(SCENARIOS);
const unknown = names.filter((name) => SCENARIOS[name] === undefined);
if (unknown.length > 0) {
  console.error(
    `알 수 없는 시나리오: ${unknown.join(", ")}. 가능한 이름: ${Object.keys(SCENARIOS).join(", ")}`,
  );
  process.exit(2);
}

const lib = await import(DIST);
if (TARGET_BYTES !== lib.MAX_UNCOMPRESSED_BYTES_CEILING) {
  console.error(
    `측정 크기(${TARGET_BYTES})가 MAX_UNCOMPRESSED_BYTES_CEILING(${lib.MAX_UNCOMPRESSED_BYTES_CEILING})와 다르다.`,
  );
  process.exit(2);
}

const require = createRequire(import.meta.url);
const playwrightVersion = require("playwright-core/package.json").version;
console.log("[환경]");
console.log(`  OS: ${release()} (${process.platform} ${process.arch})`);
console.log(`  CPU: ${cpus()[0].model}, 논리 코어 ${cpus().length}개`);
console.log(`  RAM: ${mib(totalmem())}`);
console.log(`  Node: ${process.version}`);
console.log(`  playwright-core: ${playwrightVersion}`);

let failures = 0;
for (const name of names) {
  const plan = buildPlan(name);
  const { rules, limits } = settingsFor(
    plan,
    lib.MAX_UNCOMPRESSED_BYTES_CEILING,
  );
  console.log(`\n[시나리오 ${name}] ${plan.summary}`);
  console.log(
    `  입력: asset ${plan.assetInput}, 디코딩 입력 ${plan.decodeInput}, 인코딩 입력 참조 ${plan.releaseInput === true ? "인코딩 뒤 놓음" : "대조 전까지 쥠"}`,
  );
  describePlan(plan);
  console.log(
    `    rules: ${JSON.stringify({ maxPathLength: rules.maxPathLength })}, isCode: 경로가 .js로 끝남`,
  );
  console.log(`    limits: ${JSON.stringify(limits)}`);

  console.log("\n  Node 측정 중...");
  const node = await measureNode(name);
  report("Node", node);

  console.log("\n  Chrome 측정 중...");
  const chrome = await measureChrome(name);
  console.log(
    `  브라우저: Chrome for Testing(Chromium) ${chrome.version ?? "알 수 없음"}`,
  );
  report("Chrome", chrome);

  failures += [node, chrome].filter((result) => !result.ok).length;
}

console.log(
  `\n결과: ${failures === 0 ? `합격(시나리오 ${names.length}개, 두 환경 모두 성공)` : `불합격(실패 ${failures}개)`}`,
);
process.exit(failures === 0 ? 0 : 1);
