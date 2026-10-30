// Node 측정 워커. 별도 프로세스로 돌려 프로세스 메모리를 독립으로 잰다.
// - 메모리는 커널이 기록하는 최고 상주 메모리(`/proc/self/status`의 `VmHWM`)를 단계 끝마다 읽는다.
//   표본 주기가 없어 짧은 급등도 놓치지 않는다. 값은 프로세스 시작부터의 누적 최고점이라 단계별로 줄지 않는다.
// - 시나리오 이름을 첫 인자로 받는다. 마지막 줄에 결과 JSON 한 줄을 stdout으로 낸다.
//   실패하면 `ok: false`, 실패한 단계(`phase`), 이유를 내고 종료 코드 1이다.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runWorkload } from "./workload.mjs";

const DIST = fileURLToPath(new URL("../../dist/index.js", import.meta.url));

/** `/proc/self/status`에서 kB 값을 읽어 바이트로 돌려준다. */
function readStatusBytes(field) {
  const line = readFileSync("/proc/self/status", "utf8")
    .split("\n")
    .find((row) => row.startsWith(`${field}:`));
  return Number(line.split(/\s+/)[1]) * 1024;
}

const peakAfterPhase = {};
let currentPhase = "start";
const phase = (name) => {
  peakAfterPhase[currentPhase] = readStatusBytes("VmHWM");
  currentPhase = name;
};

try {
  const lib = await import(DIST);
  const result = await runWorkload(lib, phase, process.argv[2]);
  console.log(
    JSON.stringify({
      ok: true,
      ...result,
      peakRssBytes: readStatusBytes("VmHWM"),
      peakAfterPhase,
    }),
  );
} catch (error) {
  console.log(
    JSON.stringify({
      ok: false,
      phase: currentPhase,
      error: error instanceof Error ? error.message : String(error),
      peakRssBytes: readStatusBytes("VmHWM"),
    }),
  );
  process.exitCode = 1;
}
