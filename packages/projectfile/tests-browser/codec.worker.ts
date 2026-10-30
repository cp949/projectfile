// 코덱을 Worker 안에서 부르는 시험용 Worker.
// 메인이 보낸 프로젝트를 인코딩해 `Blob`으로 돌려주고, 그 `Blob`을 같은 Worker에서 다시 디코딩해 항목 요약도 돌려준다.
import { decodeProjectFile, encodeProjectFile } from "../src/index";
import { flatten, KIND, LIMITS, RULES, type Project } from "../tests/helpers";

/** 인코딩하고 그 결과를 다시 디코딩한다. 실패하면 이유를 담아 던진다. */
async function codec(project: Project) {
  const encoded = await encodeProjectFile({
    ...project,
    kind: KIND,
    rules: RULES,
    limits: LIMITS,
  });
  if (!encoded.ok) throw new Error(`인코딩 실패: ${encoded.failure.reason}`);
  const decoded = await decodeProjectFile(encoded.value, {
    kind: KIND,
    rules: RULES,
    limits: LIMITS,
  });
  if (!decoded.ok) throw new Error(`디코딩 실패: ${decoded.failure.reason}`);
  return {
    file: encoded.value,
    rows: await flatten(decoded.value),
    isWorker: typeof window === "undefined" && "WorkerGlobalScope" in self,
  };
}

// async 처리기에서 던지면 Worker의 `error` 이벤트가 아니라 unhandledrejection이 된다.
// 메인은 그것을 받지 못해 시간 초과까지 기다리므로, 실패도 메시지로 보낸다.
self.onmessage = async (event: MessageEvent<Project>) => {
  try {
    self.postMessage(await codec(event.data));
  } catch (error) {
    self.postMessage({ error: String(error) });
  }
};
