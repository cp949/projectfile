/**
 * 속성 기반 시험. 무작위 입력으로 코덱의 두 약속을 확인한다.
 * - 인코딩이 성공한 프로젝트는 같은 kind, rules, limits, 키로 디코딩하면 그대로 돌아온다.
 * - 디코딩은 어떤 바이트를 받아도 던지지 않고 결과를 돌려준다.
 * - 약속의 출처는 `docs/format.md`의 "경계"와 "검사 순서"다.
 *
 * 재현:
 * - 시드와 실행 횟수를 상수로 고정한다. 같은 소스에서는 같은 입력열이 나온다.
 * - 실패하면 fast-check가 시드, `path`, 축소한 반례를 출력한다.
 * - `path`를 `PARAMETERS`에 더하면 그 사례 하나만 다시 돈다(`{ ...PARAMETERS, path: "..." }`).
 *
 * 환경: vitest의 node 환경. 입력은 `tests/helpers.ts`의 `RULES`와 `LIMITS`를 쓴다.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  decodeProjectFile,
  encodeProjectFile,
  readProjectFileHeader,
  type ProjectEntry,
  type ProjectFileFailure,
  type ProjectFileLimits,
  type ProjectNameCause,
} from "../src/index";
import {
  decode,
  flatten,
  KIND,
  LIMITS,
  listEntries,
  RULES,
  restoreMetadata,
  wrap,
} from "./helpers";

/** 실패를 다시 만들 수 있게 고정한 시드. 바꾸면 시험이 보는 입력열이 달라진다. */
const SEED = 20261030;

/** 한 속성이 도는 횟수. 전체 시험 시간을 눈에 띄게 늘리지 않는 값이다. */
const NUM_RUNS = 300;

const PARAMETERS = { seed: SEED, numRuns: NUM_RUNS };

/** 인코딩 성공 비율의 하한. 생성기가 입력 대부분을 실패로 보내면 왕복 단언이 비어 버린다. */
const MIN_SUCCESS_RATIO = 0.6;

/** 인코딩이 돌려줄 수 있는 실패 이유. 이 시험의 asset `Blob`은 모두 읽을 수 있어서 `read-failed`는 없다. */
const ENCODE_REASONS = new Set<ProjectFileFailure["reason"]>([
  "invalid-name",
  "limit-exceeded",
  "manifest-too-large",
]);

/** 이 시험의 `RULES`와 코덱 무결성 검사가 `invalid-name`으로 돌려줄 수 있는 원인. */
const NAME_CAUSES = new Set<ProjectNameCause>([
  "empty",
  "too-long",
  "invalid-char",
  "duplicate",
  "path-too-long",
]);

/** 입력이 `Uint8Array`일 때 디코딩이 돌려줄 수 있는 실패 이유. `read-failed`는 `Blob` 읽기 실패 전용이다. */
const DECODE_REASONS = new Set<ProjectFileFailure["reason"]>([
  "bad-magic",
  "unsupported-version",
  "kind-invalid",
  "kind-mismatch",
  "length-mismatch",
  "scramble-key-mismatch",
  "crc-mismatch",
  "zip-corrupt",
  "manifest-invalid",
  "manifest-kind-mismatch",
  "invalid-name",
  "limit-exceeded",
  "input-too-large",
]);

/** 헤더만 읽는 `readProjectFileHeader`가 `Uint8Array` 입력에 돌려줄 수 있는 실패 이유. */
const HEADER_REASONS = new Set<ProjectFileFailure["reason"]>([
  "bad-magic",
  "unsupported-version",
  "kind-invalid",
  "length-mismatch",
]);

const LIMIT_NAMES = new Set<keyof ProjectFileLimits>(
  Object.keys(LIMITS) as (keyof ProjectFileLimits)[],
);

/** 실패 결과가 알려진 이유 집합 안인지 단언한다. */
function expectKnownFailure(
  failure: ProjectFileFailure,
  reasons: ReadonlySet<ProjectFileFailure["reason"]>,
): void {
  expect(
    reasons.has(failure.reason),
    `알 수 없는 이유: ${failure.reason}`,
  ).toBe(true);
  if (failure.reason === "invalid-name") {
    expect(typeof failure.path).toBe("string");
    expect(
      NAME_CAUSES.has(failure.cause),
      `알 수 없는 원인: ${failure.cause}`,
    ).toBe(true);
  }
  if (failure.reason === "limit-exceeded") {
    expect(LIMIT_NAMES.has(failure.limit)).toBe(true);
  }
}

// 생성기.
// - 경로 조각은 대부분 올바른 이름이고 가끔 규칙을 어긴 이름이다. 실패 경로도 보되 성공이 주류여야 한다.
// - 자주 겹치는 이름(`src`, `b`와 `B` 등)을 섞어 폴더 공유와 대소문자 중복이 나오게 한다.
// - 반례를 읽을 수 있도록 `Blob`은 시험 본문에서 만든다. 생성기는 바이트만 돌려준다.
// - 길이 상한까지 만들어야 하는 바이트·문자열 생성기는 `size: "max"`를 준다. 기본 size는 길이를 10 안팎으로 줄인다.

/** 올바른 조각을 이루는 문자 하나. ASCII, 한글, 그 밖의 BMP, 이모지 같은 보조 평면 문자, 안쪽 공백이다. */
const validUnit = fc.oneof(
  { weight: 6, arbitrary: fc.constantFrom(..."abcxyz019._-") },
  {
    weight: 2,
    arbitrary: fc.integer({ min: 0xac00, max: 0xd7a3 }).map(codePointToString),
  },
  {
    weight: 1,
    arbitrary: fc.integer({ min: 0x80, max: 0xd7ff }).map(codePointToString),
  },
  {
    weight: 1,
    arbitrary: fc
      .integer({ min: 0x10000, max: 0x10ffff })
      .map(codePointToString),
  },
  { weight: 1, arbitrary: fc.constant(" ") },
);

function codePointToString(codePoint: number): string {
  return String.fromCodePoint(codePoint);
}

/** 앞뒤 공백을 떼고 `.`, `..`, 빈 조각을 피한 올바른 조각. */
const validSegment = fc
  .string({ unit: validUnit, minLength: 1, maxLength: 8 })
  .map((raw) => {
    const trimmed = raw.trim();
    return trimmed === "" || trimmed === "." || trimmed === ".."
      ? `n${trimmed}`
      : trimmed;
  });

/** 짝 없는 서로게이트가 든 문자열. */
const loneSurrogateText = fc
  .tuple(
    fc.string({ unit: "grapheme-ascii", maxLength: 3 }),
    fc.integer({ min: 0xd800, max: 0xdfff }),
    fc.string({ unit: "grapheme-ascii", maxLength: 3 }),
  )
  .map(([head, unit, tail]) => head + String.fromCharCode(unit) + tail);

/** 규칙을 어길 수 있는 조각: 제어 문자, `\`, 앞뒤 공백, 빈 조각, `.`·`..`, 짝 없는 서로게이트, 128자 초과. */
const badSegment = fc.oneof(
  fc.string({ unit: "binary-ascii", minLength: 1, maxLength: 4 }),
  loneSurrogateText,
  fc.constantFrom("", ".", "..", " a", "a ", "\\", "a\u0000b"),
  fc.constant("a".repeat(129)),
);

const segment = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.constantFrom(
      "src",
      "img",
      "a",
      "b",
      "B",
      "index.html",
      "x.js",
      // 정규 동치인 이름 쌍. 형제 중복 판정이 NFC로 합치는 경로를 무작위 입력에도 태운다.
      "\u00e9",
      "e\u0301",
    ),
  },
  { weight: 45, arbitrary: validSegment },
  { weight: 1, arbitrary: badSegment },
);

const pathArb = fc
  .array(segment, { minLength: 1, maxLength: 3 })
  .map((segments) => segments.join("/"));

// 텍스트 본문의 짝 없는 서로게이트는 U+FFFD로 바뀌어 왕복 결과가 입력과 다르다(README "사용").
// 그래서 왕복 속성에서는 만들지 않는다. 바뀌는 동작은 roundtrip.test.ts가 고정한다.
/** 텍스트 본문. 올바른 서로게이트 쌍이 든 문자열과 압축이 잘 되는 반복 문자열을 섞는다. */
const textArb = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.string({ unit: "binary", maxLength: 120, size: "max" }),
  },
  {
    weight: 2,
    arbitrary: fc
      .tuple(
        fc.string({ unit: "grapheme-ascii", minLength: 1, maxLength: 8 }),
        fc.nat({ max: 3000 }),
      )
      .map(([unit, times]) => unit.repeat(times)),
  },
  { weight: 1, arbitrary: fc.constant("") },
);

/** 생성한 항목. `ProjectEntry`로의 변환은 `toEntry`가 한다. */
type EntrySpec =
  | { path: string; type: "text"; text: string }
  | { path: string; type: "asset"; bytes: Uint8Array; asBlob: boolean };

const entryArb: fc.Arbitrary<EntrySpec> = fc.oneof(
  fc.record({
    path: pathArb,
    type: fc.constant("text" as const),
    text: textArb,
  }),
  fc.record({
    path: pathArb,
    type: fc.constant("asset" as const),
    bytes: fc.uint8Array({ maxLength: 300, size: "max" }),
    asBlob: fc.boolean(),
  }),
);

function toEntry(spec: EntrySpec): ProjectEntry {
  if (spec.type === "text") {
    return { path: spec.path, type: "text", data: spec.text };
  }
  return {
    path: spec.path,
    type: "asset",
    data: spec.asBlob ? new Blob([spec.bytes as BlobPart]) : spec.bytes,
  };
}

/** 대부분 웹 한도이고 가끔 아주 작은 한도다. 작은 한도는 인코딩과 디코딩이 같은 한도 판정을 하는지 본다. */
const limitsArb: fc.Arbitrary<ProjectFileLimits> = fc.oneof(
  { weight: 6, arbitrary: fc.constant(LIMITS) },
  {
    weight: 1,
    arbitrary: fc.record({
      maxFiles: fc.nat({ max: 6 }),
      maxFolders: fc.nat({ max: 6 }),
      maxAssetBytes: fc.nat({ max: 200 }),
      maxAssetsTotalBytes: fc.nat({ max: 400 }),
      maxCodeBytes: fc.nat({ max: 2000 }),
      maxUncompressedBytes: fc.nat({ max: 2500 }),
    }),
  },
);

const kindArb = fc.oneof(
  { weight: 3, arbitrary: fc.constant(KIND) },
  { weight: 1, arbitrary: fc.stringMatching(/^[a-z0-9][a-z0-9._-]{0,63}$/) },
);

const keyArb = fc.oneof(
  { weight: 2, arbitrary: fc.constant(undefined) },
  { weight: 1, arbitrary: fc.uint8Array({ minLength: 16, maxLength: 16 }) },
);

const projectArb = fc.record({
  kind: kindArb,
  entries: fc.array(entryArb, { maxLength: 6 }),
  folders: fc.array(pathArb, { maxLength: 3 }),
  limits: limitsArb,
  key: keyArb,
});

/** `index` 위치 바이트에 `mask`를 XOR한다. `mask`가 0이 아니면 바이트가 바뀐다. */
function flip(bytes: Uint8Array, index: number, mask: number): void {
  bytes[index] = (bytes[index] as number) ^ mask;
}

/** 경로의 조상 폴더 경로. `a/b/c.txt`는 `a`, `a/b`다. */
function ancestorsOf(path: string): string[] {
  const parts = path.split("/");
  return parts
    .slice(0, -1)
    .map((_, index) => parts.slice(0, index + 1).join("/"));
}

describe("프로젝트 파일 속성 시험", () => {
  it("인코딩이 성공한 프로젝트는 같은 옵션으로 디코딩하면 같은 항목과 폴더가 돌아온다", async () => {
    let successes = 0;

    await fc.assert(
      fc.asyncProperty(projectArb, async (project) => {
        const entries = project.entries.map(toEntry);
        const encoded = await encodeProjectFile({
          kind: project.kind,
          entries,
          folders: project.folders,
          rules: RULES,
          limits: project.limits,
          scrambleKey: project.key,
        });
        if (!encoded.ok) {
          expectKnownFailure(encoded.failure, ENCODE_REASONS);
          return;
        }
        successes += 1;

        const bytes = new Uint8Array(await encoded.value.arrayBuffer());
        const decoded = await decodeProjectFile(bytes, {
          kind: project.kind,
          rules: RULES,
          limits: project.limits,
          scrambleKeys: project.key === undefined ? undefined : [project.key],
        });
        // 인코딩이 만든 파일을 디코딩이 거부하면 계약 위반이다.
        expect(decoded.ok, JSON.stringify(decoded)).toBe(true);
        if (!decoded.ok) return;

        expect(decoded.value.kind).toBe(project.kind);
        expect(
          await flatten({ entries: decoded.value.entries, folders: [] }),
        ).toEqual(await flatten({ entries, folders: [] }));
        // 폴더 순서는 정하지 않았다. 조상으로 생긴 폴더까지 같은 집합인지 본다.
        const expectedFolders = new Set([
          ...project.folders.flatMap((path) => [...ancestorsOf(path), path]),
          ...entries.flatMap((entry) => ancestorsOf(entry.path)),
        ]);
        expect(new Set(decoded.value.folders)).toEqual(expectedFolders);
        expect(decoded.value.folders).toHaveLength(expectedFolders.size);
      }),
      PARAMETERS,
    );

    expect(successes / NUM_RUNS).toBeGreaterThanOrEqual(MIN_SUCCESS_RATIO);
  });

  it("임의 바이트를 디코딩해도 던지지 않고 알려진 이유로 거부하거나 성공한다", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ maxLength: 200, size: "max" }),
        fc.boolean(),
        async (random, withMagic) => {
          // 무작위 바이트는 대부분 `bad-magic`이다. 앞에 magic을 붙이면 길이와 버전 검사까지 간다. 그 뒤 단계는 변조 시험이 본다.
          const input = withMagic
            ? Uint8Array.from([0x4f, 0x43, 0x4f, 0x44, ...random])
            : random;
          await expectDecodeContract(input);
        },
      ),
      PARAMETERS,
    );
  });

  describe("올바른 파일을 변조해도", () => {
    /** 변조 대상 파일. 기본 키로 인코딩해서 `restoreMetadata`로 풀 수 있다. */
    const sourceArb = fc.record({
      entries: fc.array(entryArb, { minLength: 1, maxLength: 6 }),
      folders: fc.array(pathArb, { maxLength: 3 }),
    });

    /** 인코딩이 거부한 프로젝트는 변조 대상에서 뺀다. */
    async function encodeSource(source: {
      entries: EntrySpec[];
      folders: string[];
    }): Promise<Uint8Array> {
      const encoded = await encodeProjectFile({
        kind: KIND,
        entries: source.entries.map(toEntry),
        folders: source.folders,
        rules: RULES,
        limits: LIMITS,
      });
      fc.pre(encoded.ok);
      if (!encoded.ok) throw new Error("도달하지 않는다");
      return new Uint8Array(await encoded.value.arrayBuffer());
    }

    it("바이트 하나를 뒤집은 입력은 던지지 않는다", async () => {
      await fc.assert(
        fc.asyncProperty(
          sourceArb,
          fc.nat(),
          fc.integer({ min: 1, max: 255 }),
          async (source, at, mask) => {
            const bytes = await encodeSource(source);
            const changed = bytes.slice();
            flip(changed, at % changed.length, mask);
            await expectDecodeContract(changed);
          },
        ),
        PARAMETERS,
      );
    });

    it("잘라낸 입력은 던지지 않는다", async () => {
      await fc.assert(
        fc.asyncProperty(sourceArb, fc.nat(), async (source, at) => {
          const bytes = await encodeSource(source);
          await expectDecodeContract(bytes.slice(0, at % bytes.length));
        }),
        PARAMETERS,
      );
    });

    it("뒤에 덧붙인 입력은 던지지 않는다", async () => {
      await fc.assert(
        fc.asyncProperty(
          sourceArb,
          fc.uint8Array({ minLength: 1, maxLength: 64, size: "max" }),
          async (source, tail) => {
            const bytes = await encodeSource(source);
            await expectDecodeContract(Uint8Array.from([...bytes, ...tail]));
          },
        ),
        PARAMETERS,
      );
    });

    // 메타데이터 범위의 변조는 CRC 검사에서 먼저 걸려 ZIP과 manifest 검사에 닿지 않는다.
    // 변조한 ZIP에 CRC를 다시 맞춰 봉인하면 그 뒤 검사가 변조 바이트를 읽는다.
    it("CRC를 다시 맞춘 로컬 헤더와 manifest 변조는 던지지 않는다", async () => {
      let reachedDeep = 0;

      await fc.assert(
        fc.asyncProperty(
          sourceArb,
          fc.nat(),
          fc.integer({ min: 1, max: 255 }),
          async (source, at, mask) => {
            const bytes = await encodeSource(source);
            const { zip, centralStart } = restoreMetadata(bytes);
            // 로컬 헤더와 manifest 본문 위치만 고른다. 인코더는 로컬 헤더에 extra 필드를 쓰지 않아 로컬 헤더는 30 + 이름 바이트다.
            const targets = listEntries(zip, centralStart).flatMap((entry) => {
              const end = entry.dataStart;
              const start =
                end - 30 - new TextEncoder().encode(entry.name).length;
              const body =
                entry.name === "manifest.json" ? entry.compressedSize : 0;
              return Array.from(
                { length: end + body - start },
                (_, i) => start + i,
              );
            });
            const position = targets[at % targets.length] as number;
            const changed = zip.slice();
            flip(changed, position, mask);

            let sealed: Uint8Array;
            try {
              sealed = wrap(changed);
            } catch {
              // 로컬 헤더 변조로 봉인 도구가 ZIP 모양을 못 읽는 경우다. 코덱 밖이라 건너뛴다.
              fc.pre(false);
              return;
            }
            const result = await expectDecodeContract(sealed);
            if (!result.ok && result.failure.reason !== "crc-mismatch") {
              reachedDeep += 1;
            }
          },
        ),
        PARAMETERS,
      );

      // CRC를 맞췄으므로 CRC 단계를 지나는 입력이 있어야 한다.
      expect(reachedDeep).toBeGreaterThan(0);
    });
  });
});

/**
 * 디코딩 계약을 단언하고 결과를 돌려준다.
 * - `Uint8Array`와 같은 바이트의 `Blob`은 같은 결과를 돌려준다.
 * - 던지지 않는다. 호출자 버그로 던지는 옵션은 넣지 않는다.
 * - 실패면 이유가 알려진 집합 안이다. `readProjectFileHeader`도 던지지 않는다.
 */
async function expectDecodeContract(bytes: Uint8Array) {
  const result = await decode(bytes);
  const viaBlob = await decode(new Blob([bytes as BlobPart]));
  expect(viaBlob.ok).toBe(result.ok);
  if (result.ok && viaBlob.ok) {
    expect(await flatten(viaBlob.value)).toEqual(await flatten(result.value));
  } else if (!result.ok && !viaBlob.ok) {
    expect(viaBlob.failure).toEqual(result.failure);
  }
  if (!result.ok) expectKnownFailure(result.failure, DECODE_REASONS);

  const header = await readProjectFileHeader(bytes);
  if (!header.ok) expectKnownFailure(header.failure, HEADER_REASONS);
  return result;
}
