import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  // 문법을 Chrome 75가 읽는 수준으로 낮춘다. 런타임 API는 낮추지 않는다. `tsconfig.build.json`의 lib가 막는다.
  target: "chrome75",
  dts: true,
  tsconfig: "tsconfig.build.json",
  fixedExtension: false,
  sourcemap: true,
  clean: true,
});
