// `test-vectors/`의 파일과 `vectors.json`을 메모리에서 만든다. 디스크는 건드리지 않는다.
// - 라이브러리는 인자로 받는다. 명령줄(`generate-vectors.mjs`)은 `dist`를, 시험은 `src`를 넘긴다.
// - 같은 입력이 같은 바이트가 되므로 다시 만들어도 결과가 같다. 난수와 시각을 쓰지 않는다.
// - 정상 파일은 라이브러리 인코더로 만든다. 실패 파일은 정상 파일의 바이트를 고쳐 만든다.
// - 기대 값은 라이브러리 함수가 아니라 이 파일이 손으로 적거나 만든 바이트에서 읽는다.
//   그래서 라이브러리가 틀리면 시험이 실패한다.
// - 인코더가 거부하는 이름(정규 동치 형제)을 담은 파일은 `craftTextFile`이 라이브러리 없이 직접 조립한다.
//   인코더가 받는 입력으로는 같은 모양의 정상 파일을 만들어 바이트가 같은지 먼저 확인한다.
// - 규칙은 `docs/format.md`에 있다. 사용법은 `test-vectors/README.md`에 있다.
import { deflateSync } from "fflate";

/** 인코딩에 쓰는 한도. 모든 항목이 필요하다. 디코딩에도 같은 값을 쓴다. */
const LIMITS = {
  maxFiles: 201,
  maxFolders: 201,
  maxAssetBytes: 5 * 1024 * 1024,
  maxAssetsTotalBytes: 50 * 1024 * 1024,
  maxCodeBytes: 1024 * 1024,
  maxUncompressedBytes: 51 * 1024 * 1024,
};

/** 이름과 코드 판정 규칙. `vectors.json`의 `rules`로 옮겨 적는다. */
const RULES = {
  maxPathLength: 1024,
  maxSegmentLength: 128,
  codeRootFiles: ["index.html"],
  codeExtensions: [".js", ".css"],
};

/** 시험 기본 kind. 사용처 이름이 없는 중립 이름이다. */
const KIND = "example.blocks";

/** 사용처 키로 쓰는 고정 16바이트. 난수가 아니다. */
const CUSTOM_KEY = Uint8Array.from({ length: 16 }, (_, index) => index);

/** 시험 파일 확장자. */
const EXTENSION = ".bin";

const hex = (bytes) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** 시드가 같으면 같은 바이트가 나온다. 압축되지 않는 바이트열을 만든다. */
function noise(length) {
  const out = new Uint8Array(length);
  let x = 12345;
  for (let i = 0; i < length; i += 1) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

/** 정상 파일의 헤더에서 기대 값을 읽는다. 라이브러리 함수를 쓰지 않는다. */
function headerOf(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kindLength = bytes[5];
  return {
    ok: true,
    version: bytes[4],
    kind: String.fromCharCode(...bytes.subarray(22, 22 + kindLength)),
    payloadLength: view.getUint32(6, true),
    headerBytes: 22 + kindLength,
    keyCheck: view.getUint32(18, true),
  };
}

/** 키스트림을 `vectors.json`에 적는 위치 수. 위치 0부터 이 개수만큼이다. */
const STREAM_POSITIONS = 16;

/**
 * 키의 치환표와 앞쪽 위치의 키스트림을 만든다. 라이브러리를 쓰지 않는다.
 * - `docs/format.md`의 "scramble 알고리즘" 절차를 그대로 옮겼다.
 * - `BigInt`로 계산하고 32비트 연산마다 하위 32비트만 남긴다. `Math.imul`과 부호 있는 정수를 피해
 *   라이브러리와 다른 방식으로 같은 값을 얻는다.
 * @param {Uint8Array} key 16바이트 scramble 키
 * @returns {{ table: Uint8Array, stream: Uint8Array, streamByte: (position: number) => number }}
 *   `streamByte`는 임의 위치의 키스트림 바이트다. `stream`은 앞쪽 위치만 담는다.
 */
function scrambleSteps(key) {
  const mask = 0xffffffffn;
  const mul32 = (a, b) => (a * b) & mask;
  const add32 = (a, b) => (a + b) & mask;
  const word = (k) =>
    BigInt(key[4 * k]) |
    (BigInt(key[4 * k + 1]) << 8n) |
    (BigInt(key[4 * k + 2]) << 16n) |
    (BigInt(key[4 * k + 3]) << 24n);
  const [w0, w1, w2, w3] = [0, 1, 2, 3].map(word);

  // 치환표 만들기.
  const table = Array.from({ length: 256 }, (_, x) => x);
  let state = w3;
  for (let i = 255; i >= 1; i -= 1) {
    state = add32(state, 0x6d2b79f5n);
    let r = mul32(state ^ (state >> 15n), state | 1n);
    r ^= add32(r, mul32(r ^ (r >> 7n), r | 61n));
    const u = r ^ (r >> 14n);
    const j = Number((u * BigInt(i + 1)) >> 32n);
    [table[i], table[j]] = [table[j], table[i]];
  }

  // 위치별 키스트림 바이트.
  const streamByte = (position) => {
    let x = (BigInt(position) & mask) ^ w0;
    x = mul32(x ^ (x >> 16n), 0x85ebca6bn);
    x = mul32(x ^ (x >> 13n) ^ w1, 0xc2b2ae35n);
    x ^= x >> 16n;
    x = mul32(x ^ w2, 0x27d4eb2fn);
    return Number((x ^ (x >> 15n)) & 0xffn);
  };
  const stream = Array.from({ length: STREAM_POSITIONS }, (_, p) =>
    streamByte(p),
  );
  return {
    table: Uint8Array.from(table),
    stream: Uint8Array.from(stream),
    streamByte,
  };
}

const utf8 = (text) => new TextEncoder().encode(text);

/** 바이트 조각을 이어 붙인다. */
function concat(parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** 리틀 엔디안 정수 `width`바이트. */
const le = (value, width) =>
  Uint8Array.from({ length: width }, (_, i) => (value >>> (8 * i)) & 0xff);

/** CRC32(IEEE). 비트 단위로 계산한다. 라이브러리 구현을 쓰지 않는다. */
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 텍스트 파일만 담은 프로젝트 파일을 라이브러리 없이 조립한다. 인코더가 거부하는 이름도 담을 수 있다.
 * - `docs/format.md`의 "ZIP 쓰기", "항목 순서", "scramble" 절차를 그대로 옮겼다.
 * - 경로에 `/`가 없는 파일만 받는다. 폴더 항목은 `files/` 하나다.
 * @param {{ path: string, text: string }[]} files 파일 목록. 순서가 manifest와 ZIP 순서다
 * @param {string} kind
 * @param {Uint8Array} key 16바이트 scramble 키
 * @returns {Uint8Array}
 */
function craftTextFile(files, kind, key) {
  const manifest = utf8(
    JSON.stringify({
      formatVersion: 1,
      kind,
      files: files.map(({ path }) => ({ path, type: "text" })),
    }),
  );
  const items = [
    { name: "manifest.json", plain: manifest, method: 8, scrambled: true },
    { name: "files/", plain: new Uint8Array(0), method: 0, scrambled: false },
    ...files.map(({ path, text }) => ({
      name: `files/${path}`,
      plain: utf8(text),
      method: 8,
      scrambled: false,
    })),
  ].map((item) => ({
    ...item,
    body: item.method === 8 ? deflateSync(item.plain) : item.plain,
    name: utf8(item.name),
  }));

  // ZIP을 조립하면서 섞는 범위를 모은다: 로컬 헤더, manifest 본문, 중앙 디렉터리와 끝 레코드.
  const flags = 0x0800;
  const date = 0x0021;
  const pieces = [];
  const ranges = [];
  let at = 0;
  const push = (bytes, scrambled) => {
    pieces.push(bytes);
    if (scrambled) ranges.push([at, at + bytes.length]);
    at += bytes.length;
  };
  const offsets = [];
  for (const item of items) {
    offsets.push(at);
    push(
      concat([
        le(0x04034b50, 4),
        le(20, 2),
        le(flags, 2),
        le(item.method, 2),
        le(0, 2),
        le(date, 2),
        le(crc32(item.plain), 4),
        le(item.body.length, 4),
        le(item.plain.length, 4),
        le(item.name.length, 2),
        le(0, 2),
        item.name,
      ]),
      true,
    );
    push(item.body, item.scrambled);
  }
  const centralStart = at;
  const central = items.map((item, index) =>
    concat([
      le(0x02014b50, 4),
      le(20, 2),
      le(20, 2),
      le(flags, 2),
      le(item.method, 2),
      le(0, 2),
      le(date, 2),
      le(crc32(item.plain), 4),
      le(item.body.length, 4),
      le(item.plain.length, 4),
      le(item.name.length, 2),
      le(0, 2),
      le(0, 2),
      le(0, 2),
      le(0, 2),
      le(0, 4),
      le(offsets[index], 4),
      item.name,
    ]),
  );
  const centralBytes = concat(central);
  const eocd = concat([
    le(0x06054b50, 4),
    le(0, 2),
    le(0, 2),
    le(items.length, 2),
    le(items.length, 2),
    le(centralBytes.length, 4),
    le(centralStart, 4),
    le(0, 2),
  ]);
  push(concat([centralBytes, eocd]), true);

  // 섞는 범위의 평문을 ZIP 순서로 이어 CRC를 구한 뒤, 같은 범위를 섞는다.
  const zip = concat(pieces);
  const { table, streamByte } = scrambleSteps(key);
  const plain = concat(ranges.map(([from, to]) => zip.subarray(from, to)));
  const sealed = zip.slice();
  for (const [from, to] of ranges) {
    for (let i = from; i < to; i += 1) {
      sealed[i] = table[zip[i] ^ streamByte(i)];
    }
  }
  const kindBytes = utf8(kind);
  const header = concat([
    utf8("OCOD"),
    Uint8Array.of(1, kindBytes.length),
    le(zip.length, 4),
    le(crc32(plain), 4),
    le(centralStart, 4),
    le(crc32(key), 4),
    kindBytes,
  ]);
  return concat([header, sealed]);
}

/**
 * 시험 파일과 `vectors.json` 내용을 만든다.
 * @param {{ encodeProjectFile: Function, DEFAULT_SCRAMBLE_KEY: Uint8Array }} lib 라이브러리 공개 API
 * @returns {Promise<{ files: Map<string, Uint8Array>, json: string }>}
 *   `files`는 파일 이름에서 바이트로, `json`은 `vectors.json` 문자열이다.
 */
export async function buildVectors(lib) {
  const files = new Map();
  const cases = [];

  const encode = async (project, kind = KIND, scrambleKey) => {
    const result = await lib.encodeProjectFile({
      ...project,
      kind,
      scrambleKey,
      limits: LIMITS,
      rules: {
        maxPathLength: RULES.maxPathLength,
        checkSegment: (_kind, segment) =>
          segment.length > RULES.maxSegmentLength ? "too-long" : null,
        isCode: (path) =>
          RULES.codeRootFiles.includes(path) ||
          RULES.codeExtensions.some((ext) => path.toLowerCase().endsWith(ext)),
      },
    });
    if (!result.ok) throw new Error(`인코딩 실패: ${result.failure.reason}`);
    return new Uint8Array(await result.value.arrayBuffer());
  };

  /** 디코딩 성공 기대 값. 파일 내용을 손으로 적은 프로젝트에서 만든다. */
  const contentOf = (project) => ({
    ok: true,
    folders: project.expectedFolders,
    entries: project.entries.map((entry) =>
      entry.type === "text"
        ? { path: entry.path, type: "text", text: entry.data }
        : { path: entry.path, type: "asset", hex: hex(entry.data) },
    ),
  });

  /** 사례를 더한다. `name`이 파일 이름이다. `bytes`가 없으면 파일은 더하지 않는다(같은 파일을 쓴다). */
  const add = (name, bytes, entry) => {
    const file = entry.file ?? `${name}${EXTENSION}`;
    if (bytes !== undefined) files.set(file, bytes);
    cases.push({
      name,
      file,
      kind: entry.kind ?? KIND,
      scrambleKeys: entry.scrambleKeys ?? null,
      header: entry.header,
      decode: entry.decode,
      ...(entry.description === undefined
        ? {}
        : { description: entry.description }),
    });
  };

  const small = {
    entries: [
      { path: "index.html", type: "text", data: "<html></html>" },
      { path: "sketch.js", type: "text", data: "let a = 1;" },
      { path: "style.css", type: "text", data: "body {}" },
    ],
    // 파일의 조상 폴더는 `folders`에 없어도 ZIP 폴더 항목이 된다. 없으면 폴더가 없다.
    expectedFolders: [],
  };
  const mixed = {
    folders: ["빈폴더", "img", "img/깊은"],
    entries: [
      { path: "img/깊은/소리.bin", type: "asset", data: noise(16) },
      { path: "img/고양이.png", type: "asset", data: noise(24) },
      { path: "data.json", type: "text", data: '{"가":"나"}' },
      { path: "한글/메모.txt", type: "text", data: "안녕\n두 줄" },
      { path: "index.html", type: "text", data: "<html></html>" },
    ],
    // 폴더 항목은 중앙 디렉터리 순서다. 인코더가 정한다: `files/` 아래 트리 선행 순회.
    expectedFolders: ["빈폴더", "img", "img/깊은", "한글"],
  };

  // 정상 파일.
  const base = await encode(small);
  const normal = (name, bytes, project, extra = {}) =>
    add(name, bytes, {
      ...extra,
      header: headerOf(bytes),
      decode: contentOf(project),
    });
  normal("default-key", base, small);
  const customBytes = await encode(small, KIND, CUSTOM_KEY);
  normal("custom-key", customBytes, small, { scrambleKeys: [hex(CUSTOM_KEY)] });
  const kind1 = await encode(small, "a");
  normal("kind-length-1", kind1, small, { kind: "a" });
  const kind64 = `example.${"x".repeat(56)}`;
  const kind64Bytes = await encode(small, kind64);
  normal("kind-length-64", kind64Bytes, small, { kind: kind64 });
  const empty = { entries: [], expectedFolders: [] };
  normal("empty-project", await encode(empty), empty);
  normal("mixed-project", await encode(mixed), mixed);

  // 헤더 실패. `readProjectFileHeader`와 `decodeProjectFile`이 같은 이유로 거부한다.
  /** 복사본의 바이트를 고친다. `[위치, 값]` 목록이다. */
  const patched = (bytes, ...edits) => {
    const copy = bytes.slice();
    for (const [index, byte] of edits) copy[index] = byte;
    return copy;
  };
  const headerFail = (name, bytes, reason, extra = {}, kind = KIND) => {
    const failure = { ok: false, reason, ...extra };
    add(name, bytes, { kind, header: failure, decode: failure });
  };
  const kindBytes = Array.from(base.subarray(22, 22 + KIND.length));
  const kindAt = (kind) => [...kind].map((c, i) => [22 + i, c.charCodeAt(0)]);

  headerFail(
    "bad-magic",
    patched(base, [0, 0x58], [1, 0x58], [2, 0x58], [3, 0x58]),
    "bad-magic",
  );
  headerFail("magic-truncated", base.slice(0, 3), "bad-magic");
  headerFail(
    "unsupported-version",
    patched(base, [4, 2]),
    "unsupported-version",
    { version: 2 },
  );
  headerFail("kind-length-0", patched(base, [5, 0]), "kind-invalid");
  headerFail("kind-length-65", patched(base, [5, 65]), "kind-invalid");
  headerFail(
    "kind-uppercase",
    patched(base, ...kindAt(KIND.toUpperCase())),
    "kind-invalid",
  );
  // 끝 줄바꿈. 어떤 정규식 엔진은 `$`가 끝 줄바꿈 앞에서도 맞아서 이 kind를 받는다.
  // 디코딩 기대 kind는 `abc`다. 끝 공백을 잘라 비교하는 구현이 kind 단계를 지나 다른 이유로 실패하게 한다.
  const newline = await encode(small, "abcd");
  headerFail(
    "kind-trailing-newline",
    patched(newline, [25, 0x0a]),
    "kind-invalid",
    {},
    "abc",
  );
  headerFail("header-under-22-bytes", base.slice(0, 21), "length-mismatch");
  headerFail(
    "header-under-22-plus-n",
    base.slice(0, 22 + kindBytes.length - 1),
    "length-mismatch",
  );
  headerFail("truncated", base.slice(0, base.length - 1), "length-mismatch");
  const appended = new Uint8Array(base.length + 1);
  appended.set(base);
  headerFail("appended", appended, "length-mismatch");

  // 디코딩 실패. 헤더는 통과하고 `decodeProjectFile`만 거부한다.
  const headerOk = headerOf(base);
  add("scramble-key-mismatch", undefined, {
    file: `custom-key${EXTENSION}`,
    scrambleKeys: null,
    header: headerOf(customBytes),
    decode: { ok: false, reason: "scramble-key-mismatch" },
  });
  add("crc-mismatch", patched(base, [10, base[10] ^ 0xff]), {
    header: headerOk,
    decode: { ok: false, reason: "crc-mismatch" },
  });
  // 첫 로컬 헤더의 서명 바이트를 바꾼다. 범위 정하기는 이 바이트를 보지 않고, CRC 범위에는 든다.
  // CRC를 로컬 헤더 해석보다 먼저 봐야 `zip-corrupt`가 아니라 `crc-mismatch`다.
  const local = headerOk.headerBytes;
  add("crc-mismatch-local", patched(base, [local, base[local] ^ 0xff]), {
    header: headerOk,
    decode: { ok: false, reason: "crc-mismatch" },
  });

  // 이름 검사 실패. 헤더는 통과하고 `decodeProjectFile`만 이름 규칙으로 거부한다.
  // 인코더는 이 파일을 만들지 않으므로 직접 조립한다. 조립기가 맞는지는 정상 파일의 바이트로 먼저 확인한다.
  const crafted = (files) =>
    craftTextFile(files, KIND, lib.DEFAULT_SCRAMBLE_KEY);
  const sameAsEncoder = crafted(
    small.entries.map(({ path, data }) => ({ path, text: data })),
  );
  if (hex(sameAsEncoder) !== hex(base)) {
    throw new Error("직접 조립한 정상 파일이 인코더 출력과 다르다");
  }
  const composed = "\uac00.txt";
  const decomposed = "\u1100\u1161.txt";
  const duplicate = crafted([
    { path: composed, text: "a" },
    { path: decomposed, text: "b" },
  ]);
  add("duplicate-nfc-nfd", duplicate, {
    header: headerOf(duplicate),
    decode: {
      ok: false,
      reason: "invalid-name",
      path: decomposed,
      cause: "duplicate",
    },
    description:
      "같은 폴더의 두 파일 이름이 NFC로 같다. 첫째 이름은 U+AC00 + '.txt'(음절 가), 둘째 이름은 U+1100 U+1161 + '.txt'(자모 조합)다. 형제 중복 키는 소문자 변환 뒤 NFC 정규화이므로 디코딩은 둘째 이름을 duplicate로 거부한다. decode.path는 둘째 이름이다.",
  });

  const steps = scrambleSteps(lib.DEFAULT_SCRAMBLE_KEY);
  const vectors = {
    description:
      "프로젝트 파일 시험 벡터. 각 사례의 file을 header 기대 값(readProjectFileHeader)과 decode 기대 값(decodeProjectFile)에 맞춰 검사한다.",
    defaultScrambleKey: hex(lib.DEFAULT_SCRAMBLE_KEY),
    defaultScrambleTable: hex(steps.table),
    defaultScrambleStream: hex(steps.stream),
    rules: RULES,
    limits: LIMITS,
    cases,
  };
  return { files, json: `${JSON.stringify(vectors, null, 2)}\n` };
}
