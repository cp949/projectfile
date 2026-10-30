// 상한 측정의 작업 내용. Node와 브라우저가 같은 코드를 실행한다.
// - 시나리오마다 풀린 크기 합계가 정확히 256 MiB인 프로젝트를 결정적으로 만들고, 인코딩 → 디코딩 → 대조를 돈다.
// - 시나리오는 입력 구성(asset 위주, 텍스트 위주)과 입력 형태(asset을 Blob이나 Uint8Array로 주기, 디코딩 입력)를 나눈다.
// - 난수·시각을 쓰지 않는다. asset과 텍스트는 고정 시드의 PRNG에서 나온다.
// - 이 파일은 Node 내장 모듈을 가져오지 않는다. 브라우저 페이지가 그대로 불러온다.
// - 측정 절차와 해석은 ADR-0001에 있다.

/** 측정 파일의 kind. */
export const KIND = "ceiling.measure";

const MIB = 1024 * 1024;

/** asset 본문을 만들고 대조하는 단위(바이트). 한 번에 메모리에 올리는 양의 상한이다. */
const CHUNK_BYTES = MIB;

/** 풀린 크기 합계의 목표(바이트). */
export const TARGET_BYTES = 256 * MIB;

const KIB = 1024;

/** 코드 파일 묶음. 경로가 `.js`로 끝나서 `isCode`가 참이다. */
const CODE_GROUP = {
  type: "text",
  count: 64,
  bytes: 256 * KIB,
  pathOf: (i) => `src/mod-${String(i).padStart(2, "0")}.js`,
};

/** asset 위주 구성. 코드 16 MiB, 큰 asset 192 MiB, 작은 asset 48 MiB. */
const ASSET_HEAVY_GROUPS = [
  CODE_GROUP,
  {
    type: "asset",
    count: 3,
    bytes: 64 * MIB,
    pathOf: (i) => `assets/big-${i}.bin`,
  },
  {
    type: "asset",
    count: 48,
    bytes: MIB,
    pathOf: (i) => `assets/small/s-${String(i).padStart(2, "0")}.bin`,
  },
];

/** 텍스트 위주 구성. 코드 아닌 텍스트 224 MiB, 코드 16 MiB, asset 16 MiB. */
const TEXT_HEAVY_GROUPS = [
  {
    type: "text",
    count: 28,
    bytes: 8 * MIB,
    pathOf: (i) => `docs/doc-${String(i).padStart(2, "0")}.txt`,
  },
  CODE_GROUP,
  {
    type: "asset",
    count: 16,
    bytes: MIB,
    pathOf: (i) => `assets/a-${String(i).padStart(2, "0")}.bin`,
  },
];

/**
 * 시나리오 목록. 풀린 크기 합계는 모두 TARGET_BYTES다.
 * - `groups`는 파일 묶음이고 순서가 인코딩 입력 순서다. 디코딩 출력도 같은 순서여야 한다.
 * - `assetInput`은 인코딩에 넘기는 asset의 형태다(`blob`, `bytes`).
 * - `decodeInput`은 디코딩에 넘기는 입력의 형태다. `blob`은 인코딩 출력 그대로, `bytes`는 `Uint8Array`로 바꾼 것이다.
 * - `releaseInput`이 참이면 인코딩이 끝난 뒤 인코딩 입력 항목의 참조를 놓는다. 없으면 대조 전까지 쥔다.
 *   `asset-bytes-decode`만 참이다. Chrome은 살아 있는 `Blob` 총량이 약 500 MiB를 넘으면 이후 `Blob`을 읽지 못한다.
 *   입력 asset `Blob`을 쥔 채 `Uint8Array`로 디코딩하면 이 한계를 넘는다(ADR-0001 "Chrome Blob 저장 한계").
 */
export const SCENARIOS = {
  "asset-blob": {
    summary: "asset 위주. asset을 Blob으로 넣고 Blob 입력으로 디코딩한다",
    assetInput: "blob",
    decodeInput: "blob",
    groups: ASSET_HEAVY_GROUPS,
  },
  "asset-bytes-encode": {
    summary: "asset 위주. asset을 Uint8Array로 넣고 Blob 입력으로 디코딩한다",
    assetInput: "bytes",
    decodeInput: "blob",
    groups: ASSET_HEAVY_GROUPS,
  },
  "asset-bytes-decode": {
    summary:
      "asset 위주. asset을 Blob으로 넣고, 인코딩 뒤 입력을 놓고 Uint8Array 입력으로 디코딩한다",
    assetInput: "blob",
    decodeInput: "bytes",
    releaseInput: true,
    groups: ASSET_HEAVY_GROUPS,
  },
  "asset-bytes-all": {
    summary:
      "asset 위주. asset을 Uint8Array로 넣고 Uint8Array 입력으로 디코딩한다",
    assetInput: "bytes",
    decodeInput: "bytes",
    groups: ASSET_HEAVY_GROUPS,
  },
  "text-heavy": {
    summary:
      "텍스트 위주(코드 아닌 텍스트 224 MiB). asset은 Blob, 디코딩 입력은 Blob",
    assetInput: "blob",
    decodeInput: "blob",
    groups: TEXT_HEAVY_GROUPS,
  },
};

/** 텍스트에 섞는 낱말. 한글을 넣어 UTF-8 다중 바이트 경로도 지나게 한다. */
const WORDS = [
  "const",
  "function",
  "return",
  "export",
  "import",
  "value",
  "state",
  "block",
  "render",
  "update",
  "// 한글 주석",
  "프로젝트",
  "다음 단계",
  "{",
  "}",
  "=>",
  "await",
  "items.map(",
  ");",
];

const encoder = new TextEncoder();
const WORD_BYTES = WORDS.map((word) => encoder.encode(`${word} `).length);

/**
 * 32비트 PRNG(mulberry32)를 만든다. 같은 시드는 같은 수열을 낸다.
 * 암호용이 아니다. 압축되지 않는 바이트가 필요할 뿐이다.
 */
function createPrng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

/** asset 번호와 조각 번호에서 시드를 만든다. 조각마다 독립적으로 다시 만들 수 있다. */
function chunkSeed(assetIndex, chunkIndex) {
  return (
    Math.imul(assetIndex + 1, 0x9e3779b1) ^
    Math.imul(chunkIndex + 1, 0x85ebca6b)
  );
}

/** asset의 조각 하나를 만든다. 마지막 조각은 `bytes`보다 짧을 수 있다. */
function makeChunk(assetIndex, chunkIndex, bytes) {
  const next = createPrng(chunkSeed(assetIndex, chunkIndex));
  const words = new Uint32Array(CHUNK_BYTES / 4);
  for (let i = 0; i < words.length; i += 1) words[i] = next();
  return new Uint8Array(words.buffer, 0, bytes);
}

/** UTF-8 바이트가 정확히 `bytes`인 텍스트를 만든다. 끝은 공백으로 채운다. */
function makeText(textIndex, bytes) {
  const next = createPrng(0x1000 + textIndex);
  const parts = [];
  let used = 0;
  for (;;) {
    const pick = next() % WORDS.length;
    if (used + WORD_BYTES[pick] > bytes) break;
    parts.push(WORDS[pick], " ");
    used += WORD_BYTES[pick];
  }
  return parts.join("") + " ".repeat(bytes - used);
}

/** 한 조각씩 이어 붙여 asset `Blob`을 만든다. 조각 목록을 한꺼번에 쥐지 않는다. */
function makeAssetBlob(assetIndex, bytes) {
  let blob = new Blob([]);
  for (let offset = 0, k = 0; offset < bytes; offset += CHUNK_BYTES, k += 1) {
    const size = Math.min(CHUNK_BYTES, bytes - offset);
    blob = new Blob([blob, makeChunk(assetIndex, k, size)]);
  }
  return blob;
}

/** 조각을 이어 붙여 asset `Uint8Array`를 만든다. 내용은 `makeAssetBlob`과 같다. */
function makeAssetBytes(assetIndex, bytes) {
  const out = new Uint8Array(bytes);
  for (let offset = 0, k = 0; offset < bytes; offset += CHUNK_BYTES, k += 1) {
    const size = Math.min(CHUNK_BYTES, bytes - offset);
    out.set(makeChunk(assetIndex, k, size), offset);
  }
  return out;
}

/** 경로가 `.js`로 끝나면 코드다. 측정이 쓰는 `rules.isCode`다. */
export function isCodePath(path) {
  return path.endsWith(".js");
}

/** 파일 경로의 모든 조상 폴더를 사전순으로 돌려준다. */
function foldersOf(paths) {
  const folders = new Set();
  for (const path of paths) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i += 1) {
      folders.add(parts.slice(0, i).join("/"));
    }
  }
  return [...folders].sort();
}

/**
 * 시나리오의 입력 구성표를 만든다. 데이터는 아직 만들지 않는다.
 * 항목 순서는 `groups` 순서다. 디코딩 출력이 같은 순서여야 한다.
 */
export function buildPlan(name) {
  const scenario = SCENARIOS[name];
  if (scenario === undefined) throw new Error(`알 수 없는 시나리오: ${name}`);
  const files = [];
  let textIndex = 0;
  let assetIndex = 0;
  for (const group of scenario.groups) {
    for (let i = 0; i < group.count; i += 1) {
      const index = group.type === "text" ? textIndex++ : assetIndex++;
      files.push({
        type: group.type,
        path: group.pathOf(i),
        bytes: group.bytes,
        index,
      });
    }
  }
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  if (total !== TARGET_BYTES) {
    throw new Error(
      `입력 구성 합계가 목표와 다르다: ${total} != ${TARGET_BYTES}`,
    );
  }
  return {
    name,
    ...scenario,
    files,
    folders: foldersOf(files.map((file) => file.path)),
    total,
  };
}

/**
 * 규칙과 한도를 구성표에서 정한다. 한도는 입력이 통과하는 최소 범위다.
 * 코드가 아닌 텍스트는 asset 한도로 센다(`docs/format.md` "한도").
 */
export function settingsFor(plan, ceiling) {
  const isCode = isCodePath;
  const sum = (list) => list.reduce((acc, file) => acc + file.bytes, 0);
  const codes = plan.files.filter(
    (file) => file.type === "text" && isCode(file.path),
  );
  const assets = plan.files.filter((file) => !codes.includes(file));
  const rules = {
    maxPathLength: Math.max(...plan.files.map((file) => file.path.length)),
    isCode,
  };
  const limits = {
    maxFiles: plan.files.length,
    maxFolders: plan.folders.length,
    maxAssetBytes: Math.max(...assets.map((file) => file.bytes)),
    maxAssetsTotalBytes: sum(assets),
    maxCodeBytes: sum(codes),
    maxUncompressedBytes: ceiling,
  };
  return { rules, limits };
}

/** 구성표에서 인코딩 입력 항목을 만든다. asset 형태는 시나리오의 `assetInput`을 따른다. */
export function makeEntries(plan) {
  const makeAsset =
    plan.assetInput === "bytes" ? makeAssetBytes : makeAssetBlob;
  return plan.files.map((file) =>
    file.type === "text"
      ? {
          path: file.path,
          type: "text",
          data: makeText(file.index, file.bytes),
        }
      : {
          path: file.path,
          type: "asset",
          data: makeAsset(file.index, file.bytes),
        },
  );
}

/** 디코딩 결과가 구성표와 모든 바이트까지 같은지 대조한다. 다르면 던진다. */
async function verifyDecoded(decoded, plan) {
  const { entries, folders } = decoded;
  if (entries.length !== plan.files.length) {
    throw new Error(
      `항목 수가 다르다: ${entries.length} != ${plan.files.length}`,
    );
  }
  const folderList = [...folders].sort();
  if (folderList.join("|") !== plan.folders.join("|")) {
    throw new Error(`폴더 목록이 다르다: ${folderList.join(",")}`);
  }
  for (const [i, file] of plan.files.entries()) {
    const entry = entries[i];
    if (entry.path !== file.path || entry.type !== file.type) {
      throw new Error(
        `항목 ${i}의 경로나 종류가 다르다: ${entry.path} (${entry.type})`,
      );
    }
    if (file.type === "text") {
      if (entry.data !== makeText(file.index, file.bytes)) {
        throw new Error(`텍스트 내용이 다르다: ${file.path}`);
      }
      continue;
    }
    if (entry.data.size !== file.bytes) {
      throw new Error(
        `asset 크기가 다르다: ${file.path} ${entry.data.size} != ${file.bytes}`,
      );
    }
    for (
      let offset = 0, k = 0;
      offset < file.bytes;
      offset += CHUNK_BYTES, k += 1
    ) {
      const size = Math.min(CHUNK_BYTES, file.bytes - offset);
      const actual = new Uint8Array(
        await entry.data.slice(offset, offset + size).arrayBuffer(),
      );
      const expected = makeChunk(file.index, k, size);
      for (let b = 0; b < size; b += 1) {
        if (actual[b] !== expected[b]) {
          throw new Error(
            `asset 바이트가 다르다: ${file.path} 조각 ${k} 위치 ${b}`,
          );
        }
      }
    }
  }
}

/**
 * 시나리오 하나로 인코딩 → 디코딩 → 대조를 한 번 돈다.
 * - `lib`는 `@cp949/projectfile`의 공개 API다.
 * - `phase(이름)`은 단계가 바뀔 때 부른다. 메모리 표본을 단계별로 나누는 데 쓴다.
 *   단계는 prepare, encode, convert(디코딩 입력이 `bytes`일 때만), decode, verify, done 순서다.
 * - 입력 항목은 대조 전까지 놓지 않는다. 호출자가 입력을 쥐고 있는 경우의 최고점이다.
 *   예외: 시나리오의 `releaseInput`이 참이면 인코딩 직후 항목의 참조를 놓는다.
 * - 결과는 JSON으로 직렬화할 수 있다. 실패하면 던진다.
 */
export async function runWorkload(lib, phase, scenarioName) {
  const plan = buildPlan(scenarioName);
  const { rules, limits } = settingsFor(
    plan,
    lib.MAX_UNCOMPRESSED_BYTES_CEILING,
  );

  await phase("prepare");
  const entries = makeEntries(plan);

  await phase("encode");
  const encodeStart = performance.now();
  let encoded = await lib.encodeProjectFile({
    kind: KIND,
    entries,
    folders: plan.folders,
    rules,
    limits,
  });
  const encodeMs = performance.now() - encodeStart;
  if (!encoded.ok)
    throw new Error(
      `인코딩 실패: ${JSON.stringify(encoded.failure ?? encoded)}`,
    );
  const encodedBytes = encoded.value.size;
  let input = encoded.value;
  encoded = null;

  // 인코딩 입력 asset의 참조를 놓는다. 해제 시점은 가비지 수집에 달려 있다.
  if (plan.releaseInput === true) entries.length = 0;

  // 디코딩 입력이 `bytes`면 인코딩 출력을 `Uint8Array`로 바꾼다. 변환 시간은 재지 않는다.
  // Blob 참조는 버리지만 해제 시점은 가비지 수집에 달려 있다.
  if (plan.decodeInput === "bytes") {
    await phase("convert");
    input = new Uint8Array(await input.arrayBuffer());
  }

  await phase("decode");
  const decodeStart = performance.now();
  const decoded = await lib.decodeProjectFile(input, {
    kind: KIND,
    rules,
    limits,
  });
  const decodeMs = performance.now() - decodeStart;
  if (!decoded.ok)
    throw new Error(
      `디코딩 실패: ${JSON.stringify(decoded.failure ?? decoded)}`,
    );

  await phase("verify");
  const verifyStart = performance.now();
  await verifyDecoded(decoded.value, plan);
  const verifyMs = performance.now() - verifyStart;

  await phase("done");
  return {
    scenario: plan.name,
    uncompressedBytes: plan.total,
    fileCount: plan.files.length,
    folderCount: plan.folders.length,
    encodedBytes,
    encodeMs,
    decodeMs,
    verifyMs,
    rules: { maxPathLength: rules.maxPathLength },
    limits,
  };
}
