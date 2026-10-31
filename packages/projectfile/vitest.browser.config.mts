import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

// 브라우저(Chromium) 시험 설정. `pnpm test:browser`만 쓴다. `pnpm test`와 `pnpm verify`는 이 설정을 읽지 않는다.
// Chromium은 `pnpm exec playwright-core install chromium`으로 받아 둔 것을 쓴다. 설치는 이 설정이 하지 않는다.
// headless로 띄우므로 실제로 쓰는 것은 함께 설치되는 Chrome Headless Shell이다.
export default defineConfig({
  // `SharedArrayBuffer`는 cross-origin isolation이 있어야 브라우저에 생긴다. 왕복 시험이 쓰므로 헤더로 켠다.
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  test: {
    // `Blob` 읽기 경로를 다루는 Node 시험 세 파일을 그대로 한 번 더 돌리고, 브라우저 전용 시험은 `tests-browser/`에 둔다.
    include: [
      "tests/decode-read.test.ts",
      "tests/roundtrip.test.ts",
      "tests/full-scramble.test.ts",
      "tests-browser/**/*.test.ts",
    ],
    // 커버리지 임계값은 Node 시험 기준이다. 이 설정은 커버리지를 측정하지 않는다.
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
    },
  },
});
