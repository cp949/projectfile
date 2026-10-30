// Chrome 측정. Playwright가 Chromium을 띄우고 페이지가 같은 작업(`workload.mjs`)을 돈다.
// - 페이지는 로컬 HTTP 서버가 `dist`와 `fflate`의 브라우저 ESM을 내준다. 페이지 주소는 `127.0.0.1`이다.
// - 메모리는 브라우저 프로세스 트리(브라우저, 렌더러, GPU, 유틸리티) 전체를 주기적으로 표본해 잰다.
//   표본 주기(SAMPLE_MS) 사이의 급등은 놓친다. 작업 단계는 페이지가 알려준다.
// - 시나리오마다 브라우저를 새로 띄운다. 이전 시나리오의 메모리가 최고점에 섞이지 않게 한다.
// - 합계는 RSS와 PSS 두 가지다. RSS는 프로세스 사이 공유 페이지를 중복해서 더하고, PSS는 나눠서 더한다.
// - 놓치는 범위는 ADR-0001에 있다.
import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const PACKAGE_DIR = fileURLToPath(new URL("../..", import.meta.url));
const SAMPLE_MS = 50;

const FILES = {
  "/lib/index.js": `${PACKAGE_DIR}dist/index.js`,
  "/vendor/fflate.js": `${PACKAGE_DIR}node_modules/fflate/esm/browser.js`,
  "/workload.mjs": `${PACKAGE_DIR}scripts/measure-ceiling/workload.mjs`,
};

const PAGE = `<!doctype html>
<meta charset="utf-8">
<script type="importmap">{"imports":{"fflate":"/vendor/fflate.js"}}</script>
<script type="module">
  import * as lib from "/lib/index.js";
  import { runWorkload } from "/workload.mjs";
  window.runMeasure = (scenario) =>
    runWorkload(lib, (name) => window.markPhase(name), scenario);
  window.measureReady = true;
</script>
`;

/** 페이지와 모듈을 내주는 서버를 연다. 주소를 돌려준다. */
async function startServer() {
  const server = createServer((req, res) => {
    const path = req.url === "/" ? "/" : req.url.split("?")[0];
    if (path === "/") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(PAGE);
      return;
    }
    const file = FILES[path];
    if (file === undefined) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader("content-type", "text/javascript; charset=utf-8");
    res.end(readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

/** `/proc/<pid>/stat`에서 부모 pid를 읽는다. 프로세스 이름에 괄호가 있어도 마지막 `)` 뒤를 본다. */
function parentOf(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
}

/** 표식 인자를 가진 브라우저 프로세스의 pid를 찾는다. */
function findBrowserPid(token) {
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      // Chrome은 프로세스 제목을 덮어써서 인자가 NUL이 아닌 공백으로 이어진다. 문자열로 찾는다.
      const cmdline = readFileSync(`/proc/${name}/cmdline`, "utf8");
      if (cmdline.includes(token) && !cmdline.includes("--type=")) {
        return Number(name);
      }
    } catch {
      // 읽는 사이에 사라진 프로세스는 건너뛴다.
    }
  }
  return null;
}

/** 루트 pid와 모든 자손 pid를 돌려준다. */
function processTree(rootPid) {
  const parents = new Map();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      parents.set(Number(name), parentOf(name));
    } catch {
      // 읽는 사이에 사라진 프로세스는 건너뛴다.
    }
  }
  const tree = [rootPid];
  for (let i = 0; i < tree.length; i += 1) {
    for (const [pid, parent] of parents) {
      if (parent === tree[i]) tree.push(pid);
    }
  }
  return tree;
}

/** 프로세스의 RSS와 PSS를 바이트로 읽는다. 읽을 수 없으면 `null`이다. */
function memoryOf(pid) {
  try {
    const text = readFileSync(`/proc/${pid}/smaps_rollup`, "utf8");
    const kb = (field) =>
      Number(text.match(new RegExp(`^${field}:\\s+(\\d+)`, "m"))[1]) * 1024;
    return { rss: kb("Rss"), pss: kb("Pss") };
  } catch {
    return null;
  }
}

/**
 * 트리 전체의 메모리를 단계별 최고점으로 기록하는 표본기를 시작한다.
 * 단계는 browser(브라우저 시작 직후부터 페이지를 열기 전), page(페이지와 모듈 로드)로 시작한다.
 * 이어지는 단계는 페이지가 알린 이름이다.
 */
function startSampler(rootPid) {
  const peaks = {};
  let phase = "browser";
  let samples = 0;
  const sample = () => {
    let rss = 0;
    let pss = 0;
    for (const pid of processTree(rootPid)) {
      const memory = memoryOf(pid);
      if (memory === null) continue;
      rss += memory.rss;
      pss += memory.pss;
    }
    samples += 1;
    const peak = (peaks[phase] ??= { rss: 0, pss: 0 });
    peak.rss = Math.max(peak.rss, rss);
    peak.pss = Math.max(peak.pss, pss);
  };
  const timer = setInterval(sample, SAMPLE_MS);
  return {
    setPhase: (name) => {
      sample();
      phase = name;
    },
    stop: () => {
      sample();
      clearInterval(timer);
      const all = Object.values(peaks);
      return {
        samples,
        lastPhase: phase,
        peakRssBytes: Math.max(...all.map((peak) => peak.rss)),
        peakPssBytes: Math.max(...all.map((peak) => peak.pss)),
        peakByPhase: peaks,
      };
    },
  };
}

/**
 * Chrome에서 시나리오 하나를 측정한다. 실패해도 던지지 않고 `ok: false`와 이유를 돌려준다.
 * 반환값에 브라우저 버전(`version`)이 든다. 실패하면 `lastPhase`가 실패한 단계다.
 */
export async function measureChrome(scenario) {
  const { server, origin } = await startServer();
  const token = `--pf-measure=${process.pid}-${Date.now()}`;
  let browser;
  try {
    browser = await chromium.launch({ channel: "chromium", args: [token] });
    const version = browser.version();
    const rootPid = findBrowserPid(token);
    if (rootPid === null) throw new Error("브라우저 프로세스를 찾지 못했다");
    const sampler = startSampler(rootPid);

    sampler.setPhase("page");
    const page = await browser.newPage();
    page.setDefaultTimeout(0);
    const crashed = new Promise((_, reject) => {
      page.on("crash", () => reject(new Error("렌더러가 종료됐다(crash)")));
      page.on("pageerror", (error) => reject(error));
    });
    // 평가가 먼저 끝나면 뒤늦은 거부가 처리되지 않은 거부가 되지 않게 한다.
    crashed.catch(() => {});
    await page.exposeFunction("markPhase", (name) => sampler.setPhase(name));
    await page.goto(origin);
    await page.waitForFunction(() => window.measureReady === true);

    let result;
    try {
      result = await Promise.race([
        page.evaluate((name) => window.runMeasure(name), scenario),
        crashed,
      ]);
    } catch (error) {
      const memory = sampler.stop();
      return {
        ok: false,
        version,
        error: error instanceof Error ? error.message : String(error),
        ...memory,
      };
    }
    return { ok: true, version, ...result, ...sampler.stop() };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await browser?.close();
    server.close();
  }
}
