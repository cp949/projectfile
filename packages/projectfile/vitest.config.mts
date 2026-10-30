import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 패키지별 캐시. 다른 패키지와 캐시를 공유하지 않는다.
    fsModuleCachePath: fileURLToPath(
      new URL("./node_modules/.vitest-cache", import.meta.url),
    ),
    // 코덱은 Blob, Response, TextEncoder, TextDecoder 전역만 쓴다. 시험은 DOMException도 쓴다.
    // Node 24가 모두 갖고 있어 DOM 환경이 필요 없다.
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      reporter: ["text", "html"],
      // 측정값(2026-10 기준 문장 99.46, 분기 98.63, 함수 100, 줄 99.85)을 내림해 둔다. 내려가면 실패한다.
      thresholds: { statements: 99, branches: 98, functions: 100, lines: 99 },
    },
  },
});
