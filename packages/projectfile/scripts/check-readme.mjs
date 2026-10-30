// 패키지 README의 ts 코드 블록을 `tsc --noEmit`으로 검사한다.
// - API 이름이나 타입을 바꿔도 예제가 조용히 낡지 않게 한다.
// - 블록마다 파일 하나로 쓰고 한 번에 검사한다. 블록은 서로 다른 모듈이라 선언이 충돌하지 않는다. 모듈 여부는 tsconfig.base.json의 `moduleDetection: force`가 정한다.
// - 첫 줄이 `// encode.worker.ts` 같은 파일명 주석이면 그 이름으로 쓴다. 다른 블록이 `./encode.worker`로 import할 수 있다.
// - `@cp949/projectfile`은 `src/index.ts`로 해석한다. `dist`가 없어도 돈다.
// - 설명 없이 쓰는 이름은 `scripts/readme-types/`의 선언 파일이 채운다.
// - `CONTINUATION_SECTIONS` 절에 있고 import 문이 없는 블록은 앞 블록의 import를 이어 쓰는 블록이다. 그 블록에만 `CONTINUATION_IMPORT`를 붙인다.
// - 사용: `node scripts/check-readme.mjs [README 경로]`. 기본은 패키지 README다.
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const TYPES_DIR = join(PACKAGE_DIR, "scripts", "readme-types");
const TSC = join(PACKAGE_DIR, "node_modules", ".bin", "tsc");
const NAME_COMMENT = /^\/\/ ([A-Za-z0-9._-]+\.ts)$/;
// ts로 검사해야 하는데 다른 이름으로 적은 언어 표기다. 조용히 건너뛰지 않고 실패로 본다.
const TS_ALIASES = new Set(["typescript", "tsx", "mts", "cts"]);
// 앞 블록의 import를 이어 쓰는 블록이 쓰는 이름이다. 줄 번호가 바뀌지 않게 블록 끝에 붙인다.
// 전역으로 열거나 import 문이 없는 블록 모두에 붙이면 import를 빠뜨린 블록도 통과한다.
// 그래서 이어 쓰는 블록이 있는 절(`## ` 제목)을 적어 둔다. 절 제목이 바뀌면 그 블록이 오류로 드러난다.
const CONTINUATION_IMPORT =
  'import { decodeProjectFile, encodeProjectFile, type ProjectFileRules } from "@cp949/projectfile";';
const CONTINUATION_SECTIONS = new Set(["rules", "scramble 키"]);

const readmePath = resolve(process.argv[2] ?? join(PACKAGE_DIR, "README.md"));

/**
 * README에서 ts 블록을 뽑는다. `line`은 여는 펜스의 줄 번호(1부터), `section`은 블록이 속한 `## ` 절 제목이다.
 * - 목록 안의 들여쓴 펜스와 `~~~` 펜스도 펜스로 본다. 들여쓰기는 남겨 오류 열 번호가 README와 맞게 한다.
 * - 닫는 펜스는 여는 펜스와 같은 문자이고 길이가 같거나 길다. 그래서 긴 펜스 안의 ```ts는 블록이 아니다.
 * - 언어는 info 문자열의 첫 낱말이다. `TS_ALIASES`나 대소문자만 다른 `ts`는 던진다.
 */
function extractBlocks(markdown) {
  const blocks = [];
  let open = null;
  let section = "";
  markdown.split("\n").forEach((text, index) => {
    const line = index + 1;
    const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(text);
    if (open === null) {
      const heading = /^##\s+(.*?)\s*$/.exec(text);
      if (heading) section = heading[1];
      // 백틱 펜스의 info 문자열에는 백틱이 올 수 없다. 있으면 인라인 코드다.
      if (!fence || (fence[1][0] === "`" && fence[2].includes("`"))) return;
      const lang = fence[2].trim().split(/\s+/)[0];
      const lower = lang.toLowerCase();
      if (lang !== "ts" && (lower === "ts" || TS_ALIASES.has(lower)))
        throw new Error(`줄 ${line}의 코드 블록 언어가 ${lang}다. ts로 쓴다.`);
      open = { marker: fence[1], lang, line, code: [] };
    } else if (
      fence &&
      fence[1][0] === open.marker[0] &&
      fence[1].length >= open.marker.length &&
      fence[2].trim() === ""
    ) {
      if (open.lang === "ts")
        blocks.push({ line: open.line, section, code: open.code.join("\n") });
      open = null;
    } else {
      open.code.push(text);
    }
  });
  if (open !== null)
    throw new Error(`줄 ${open.line}의 코드 블록이 닫히지 않았다.`);
  return blocks;
}

function fail(message) {
  console.error(`check-readme: ${message}`);
  process.exit(1);
}

let markdown;
try {
  markdown = readFileSync(readmePath, "utf8");
} catch (error) {
  fail(`${readmePath}를 읽지 못했다: ${error.message}`);
}
let blocks;
try {
  blocks = extractBlocks(markdown);
} catch (error) {
  fail(`${readmePath}: ${error.message}`);
}
// 추출이 깨져 0개가 되면 아무것도 검사하지 않고 통과하므로 실패로 본다.
if (blocks.length === 0) fail(`${readmePath}에 ts 코드 블록이 없다.`);

const files = blocks.map((block, index) => {
  const named = NAME_COMMENT.exec(block.code.split("\n")[0]?.trim() ?? "");
  return {
    ...block,
    number: index + 1,
    name: named ? named[1] : `block-${index + 1}.ts`,
    continuation:
      CONTINUATION_SECTIONS.has(block.section) &&
      !/^\s*import\s/m.test(block.code),
  };
});
const declarations = readdirSync(TYPES_DIR).filter((name) =>
  name.endsWith(".d.ts"),
);
// 선언 파일이나 tsconfig와 이름이 같으면 블록 파일을 덮어쓰거나 덮어쓰인다.
const names = new Set([
  ...files.map((file) => file.name),
  ...declarations,
  "tsconfig.json",
]);
if (names.size !== files.length + declarations.length + 1)
  fail(
    "README에 파일명 주석이 같은 ts 블록이 둘 이상 있거나, 선언 파일과 이름이 같은 블록이 있다.",
  );

const dir = realpathSync(mkdtempSync(join(tmpdir(), "check-readme-")));
let result;
try {
  for (const file of files)
    writeFileSync(
      join(dir, file.name),
      `${file.code}\n${file.continuation ? `${CONTINUATION_IMPORT}\n` : ""}`,
    );
  for (const name of declarations)
    copyFileSync(join(TYPES_DIR, name), join(dir, name));

  // 엄격도와 lib은 패키지 tsconfig를 따른다. 경로 매핑만 더한다.
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      extends: join(PACKAGE_DIR, "tsconfig.json"),
      compilerOptions: {
        noEmit: true,
        paths: { "@cp949/projectfile": [join(PACKAGE_DIR, "src", "index.ts")] },
      },
      include: [],
      files: [...files.map((file) => file.name), ...declarations],
    }),
  );

  result = spawnSync(
    TSC,
    ["--noEmit", "--pretty", "false", "--listFiles", "-p", "tsconfig.json"],
    {
      cwd: dir,
      encoding: "utf8",
    },
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (result.error) fail(`tsc를 실행하지 못했다: ${result.error.message}`);

// --listFiles의 파일 경로(절대 경로)와 오류 줄이 stdout에 섞여 나온다. 오류 줄은 절대 경로로 시작하지 않는다.
const output = `${result.stdout}${result.stderr}`.split("\n");
const listed = new Set(output.filter((line) => line.startsWith(`${dir}/`)));
const missing = files.filter((file) => !listed.has(join(dir, file.name)));
if (missing.length > 0) {
  fail(
    `검사 대상에 들어가지 않은 블록이 있다: ${missing.map((file) => file.number).join(", ")}`,
  );
}

const readmeName = basename(readmePath);
const byName = new Map(files.map((file) => [file.name, file]));
const messages = output
  .filter((line) => line !== "" && !/^\/[^()]*$/.test(line))
  .map((line) => {
    const located = /^([^(\s]+)\((\d+),(\d+)\): (.*)$/.exec(line);
    const file = located && byName.get(located[1]);
    if (!file) return line;
    const at = `${readmeName}:${file.line + Number(located[2])}:${located[3]}`;
    return `ts 블록 ${file.number}/${files.length} (${readmeName} 줄 ${file.line}에서 시작, 오류 위치 ${at}, 파일 ${file.name}): ${located[4]}`;
  });

if (result.status !== 0 && messages.length === 0) {
  messages.push(`tsc가 오류 줄 없이 종료 코드 ${result.status}로 끝났다.`);
}
if (result.status !== 0 || messages.length > 0) {
  console.error(`check-readme: ts 블록 ${files.length}개를 검사했다. 실패:`);
  for (const message of messages) console.error(`  ${message}`);
  process.exit(1);
}
console.log(
  `check-readme: ts 블록 ${files.length}개를 모두 검사했고 선언 파일 ${declarations.length}개를 함께 썼다. 통과`,
);
