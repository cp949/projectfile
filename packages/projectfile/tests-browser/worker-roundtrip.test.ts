/**
 * Worker 왕복 시험.
 * 큰 프로젝트를 Worker에서 부르려면 코덱이 쓰는 전역(`Blob`, `Response`, `TextEncoder`, `TextDecoder`)이
 * Worker에 있어야 한다. Worker가 인코딩한 파일을 메인이 `Blob`으로 디코딩하고,
 * 같은 파일을 Worker가 디코딩한 결과와 비교한다.
 */
import { describe, expect, it } from "vitest";
import {
  decode,
  flatten,
  type Project,
  richProject,
  value,
} from "../tests/helpers";

interface WorkerReply {
  file: Blob;
  rows: string[];
  isWorker: boolean;
}

/** Worker 응답을 기다리는 한도. 시험 시간 제한보다 짧게 두어 시간 초과에도 Worker를 종료한다. */
const REPLY_TIMEOUT_MS = 10_000;

/** 프로젝트를 Worker에 보내 응답 하나를 받는다. Worker가 실패를 보내거나 오류가 나거나 응답이 없으면 거부한다. */
function runWorker(project: Project): Promise<WorkerReply> {
  const worker = new Worker(new URL("./codec.worker.ts", import.meta.url), {
    type: "module",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<WorkerReply>((resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Worker 응답 없음(${REPLY_TIMEOUT_MS}ms)`)),
      REPLY_TIMEOUT_MS,
    );
    worker.onmessage = (
      event: MessageEvent<WorkerReply | { error: string }>,
    ) => {
      const reply = event.data;
      if ("error" in reply) reject(new Error(`Worker 실패: ${reply.error}`));
      else resolve(reply);
    };
    // 모듈을 불러오지 못하면 `ErrorEvent`가 아닌 `Event`가 와서 `message`가 없다.
    worker.onerror = (event) =>
      reject(new Error(event.message || "Worker 오류"));
    worker.onmessageerror = () =>
      reject(new Error("Worker 응답을 복원하지 못함"));
    worker.postMessage(project);
  }).finally(() => {
    clearTimeout(timer);
    worker.terminate();
  });
}

describe("Worker 왕복", () => {
  it("Worker가 인코딩한 파일을 메인이 Blob으로 디코딩하면 항목이 같고, Worker의 디코딩 결과와도 같다", async () => {
    const project = richProject();

    const reply = await runWorker(project);

    expect(reply.isWorker).toBe(true);
    const restored = value(await decode(reply.file));
    const expected = await flatten(project);
    expect(await flatten(restored)).toEqual(expected);
    expect(reply.rows).toEqual(expected);
  });
});
