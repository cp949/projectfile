// Chrome 75에 없는 API 이름이 src에 있으면 실패한다.
// - 타입 검사(ES2019 lib)가 못 잡는 DOM API와 ES2020 이후 API를 이름으로 잡는다.
// - 주석은 지우고 검사한다. 이유를 설명하는 주석이 이름을 언급해도 통과한다.
// - 이름 검색이라 동적 접근(`obj[name]()`)은 못 잡는다. 한계는 README "지원 환경"에 있다.
// - 사용: `node scripts/check-banned-api.mjs [검사할 디렉터리]`. 기본은 `src`다.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));

// `allow`는 규칙을 적용하지 않는 파일이다. PACKAGE_DIR 기준 경로다.
const RULES = [
  {
    name: "Blob.arrayBuffer/text/stream (Chrome 76)",
    pattern: /\.(arrayBuffer|text|stream)\(/,
    hint: "src/blob.ts의 readBlobBytes를 쓴다.",
    allow: ["src/blob.ts"],
  },
  { name: "Object.hasOwn (Chrome 93)", pattern: /\bObject\.hasOwn\(/ },
  { name: "Array/String/TypedArray.at (Chrome 92)", pattern: /\.at\(/ },
  { name: "structuredClone (Chrome 98)", pattern: /\bstructuredClone\(/ },
  { name: "String.replaceAll (Chrome 85)", pattern: /\.replaceAll\(/ },
  {
    name: "findLast/findLastIndex (Chrome 97)",
    pattern: /\.findLast(Index)?\(/,
  },
  {
    name: "toSorted/toReversed/toSpliced (Chrome 110)",
    pattern: /\.(toSorted|toReversed|toSpliced)\(/,
  },
  { name: "Array.fromAsync (Chrome 121)", pattern: /\bArray\.fromAsync\(/ },
  {
    name: "Promise.allSettled (Chrome 76)",
    pattern: /\bPromise\.allSettled\(/,
  },
  { name: "Promise.any (Chrome 85)", pattern: /\bPromise\.any\(/ },
  { name: "AggregateError (Chrome 85)", pattern: /\bAggregateError\b/ },
  { name: "crypto.randomUUID (Chrome 92)", pattern: /\brandomUUID\(/ },
];

/** 블록 주석과 줄 주석을 지우되 줄 수는 유지한다. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/\/\/.*$/gm, "");
}

function* tsFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* tsFiles(path);
    else if (entry.name.endsWith(".ts")) yield path;
  }
}

const target = resolve(process.argv[2] ?? join(PACKAGE_DIR, "src"));
const violations = [];
for (const file of tsFiles(target)) {
  const rel = relative(PACKAGE_DIR, file);
  const lines = stripComments(readFileSync(file, "utf8")).split("\n");
  for (const rule of RULES) {
    if (rule.allow?.includes(rel)) continue;
    lines.forEach((line, index) => {
      if (rule.pattern.test(line)) {
        violations.push(
          `${rel}:${index + 1}: ${rule.name}${rule.hint ? ` ${rule.hint}` : ""}`,
        );
      }
    });
  }
}

if (violations.length > 0) {
  console.error(
    `Chrome 75에 없는 API를 쓴다:\n${violations.map((v) => `  ${v}`).join("\n")}`,
  );
  process.exit(1);
}
console.log("check-banned-api: 통과");
