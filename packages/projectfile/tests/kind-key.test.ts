/**
 * 프로젝트 파일 kind와 scramble 키 규칙 시험.
 * 옵션이 규칙을 어기면 던지고(호출자 버그), 키가 맞는 파일을 고르는 동작을 고정한다.
 * 규칙은 `docs/format.md`의 "kind"와 "scramble 키"에 있다.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SCRAMBLE_KEY,
  decodeProjectFile,
  encodeProjectFile,
} from "../src/index";
import {
  decode,
  encodeBytes,
  flatten,
  KIND,
  LIMITS,
  noise,
  richProject,
  RULES,
  value,
} from "./helpers";

describe("프로젝트 파일 kind 규칙", () => {
  it.each([
    ["빈 문자열", ""],
    ["대문자", "Example.blocks"],
    ["첫 글자가 하이픈", "-blocks"],
    ["첫 글자가 점", ".blocks"],
    ["공백", "example blocks"],
    ["ASCII가 아닌 글자", "예제"],
    ["길이 65", "a".repeat(65)],
  ])(
    "옵션 kind가 규칙을 어기면(%s) 인코딩과 디코딩 모두 던진다",
    async (_title, kind) => {
      await expect(
        encodeProjectFile({
          kind,
          entries: [],
          rules: RULES,
          limits: LIMITS,
        }),
      ).rejects.toThrow("kind");
      await expect(
        decodeProjectFile(new Uint8Array(0), {
          kind,
          rules: RULES,
          limits: LIMITS,
        }),
      ).rejects.toThrow("kind");
    },
  );
});

describe("프로젝트 파일 scramble 키", () => {
  const defaultKeyCopy = DEFAULT_SCRAMBLE_KEY.slice();
  const other = () => noise(16);
  const reasonOf = async (
    bytes: Uint8Array,
    keys?: readonly Uint8Array[],
  ): Promise<string> => {
    const result = await decode(bytes, KIND, {}, keys);
    return result.ok ? "ok" : result.failure.reason;
  };

  afterEach(() => {
    DEFAULT_SCRAMBLE_KEY.set(defaultKeyCopy);
  });

  it("길이가 16이 아닌 scrambleKey는 인코딩이 던진다", async () => {
    for (const length of [0, 15, 17]) {
      await expect(
        encodeProjectFile({
          kind: KIND,
          entries: [],
          rules: RULES,
          limits: LIMITS,
          scrambleKey: new Uint8Array(length),
        }),
      ).rejects.toThrow("scrambleKey");
    }
  });

  it.each([
    ["빈 배열", () => []],
    ["길이가 16이 아닌 키", () => [new Uint8Array(15)]],
    ["키 확인값이 같은 키 둘", () => [other(), other()]],
  ])("scrambleKeys가 %s이면 디코딩이 던진다", async (_title, keys) => {
    await expect(decode(new Uint8Array(0), KIND, {}, keys())).rejects.toThrow(
      "scrambleKeys",
    );
  });

  it("사용처 키로 봉인한 파일을 그 키가 든 목록으로 열고 항목이 같다", async () => {
    const project = richProject();
    const key = other();
    const bytes = await encodeBytes(project, KIND, key);

    const restored = value(
      await decode(bytes, KIND, {}, [new Uint8Array(16).fill(7), key]),
    );

    expect(await flatten(restored)).toEqual(await flatten(project));
    // 키가 다르면 섞는 범위의 바이트가 다르다.
    expect(bytes).not.toEqual(await encodeBytes(project));
  });

  it("목록을 주면 기본 키를 자동으로 더하지 않는다", async () => {
    const withDefault = await encodeBytes(richProject());

    expect(await reasonOf(withDefault, [other()])).toBe(
      "scramble-key-mismatch",
    );
    expect(await reasonOf(withDefault, [other(), DEFAULT_SCRAMBLE_KEY])).toBe(
      "ok",
    );
  });

  it("사용처 키로 봉인한 파일을 기본 키로 열면 scramble-key-mismatch다", async () => {
    const bytes = await encodeBytes(richProject(), KIND, other());

    expect(await reasonOf(bytes)).toBe("scramble-key-mismatch");
  });

  it("내보낸 DEFAULT_SCRAMBLE_KEY를 호출자가 바꿔도 기본 동작은 변하지 않는다", async () => {
    const bytes = await encodeBytes(richProject());

    DEFAULT_SCRAMBLE_KEY.fill(0);

    expect(await encodeBytes(richProject())).toEqual(bytes);
    expect(await reasonOf(bytes)).toBe("ok");
  });
});

describe("호출자 버그 검사 순서", () => {
  /** reject 값의 클래스 이름과 `:` 앞 메시지. 어느 검사가 던졌는지 가린다. */
  const thrown = async (promise: Promise<unknown>) => {
    const error = (await promise.then(
      () => null,
      (reason: unknown) => reason,
    )) as Error | null;
    return error === null ? null : [error.name, error.message.split(":")[0]];
  };
  const badRules = { ...RULES, maxPathLength: 0 };
  const badLimits = { ...LIMITS, maxCodeBytes: -1 };
  const rulesError = [
    "RangeError",
    "maxPathLength는 1 이상 1024 이하의 정수여야 한다",
  ];
  const limitsError = ["RangeError", "maxCodeBytes는 0 이상의 정수여야 한다"];

  it("인코딩은 kind, 키, rules, limits 순서로 먼저 어긴 하나만 던진다", async () => {
    let options = {
      kind: "",
      entries: [],
      rules: badRules,
      limits: badLimits,
      scrambleKey: new Uint8Array(15),
    };

    expect(await thrown(encodeProjectFile(options))).toEqual([
      "Error",
      "kind가 규칙을 어겼다",
    ]);
    options = { ...options, kind: KIND };
    expect(await thrown(encodeProjectFile(options))).toEqual([
      "RangeError",
      "scrambleKey는 길이 16의 Uint8Array여야 한다",
    ]);
    options = { ...options, scrambleKey: new Uint8Array(16) };
    expect(await thrown(encodeProjectFile(options))).toEqual(rulesError);
    options = { ...options, rules: RULES };
    expect(await thrown(encodeProjectFile(options))).toEqual(limitsError);
  });

  it("디코딩은 kind, 키, rules, limits 순서로 먼저 어긴 하나만 던진다", async () => {
    const input = new Uint8Array(0);
    let options = {
      kind: "",
      rules: badRules,
      limits: badLimits,
      scrambleKeys: [new Uint8Array(15)],
    };

    expect(await thrown(decodeProjectFile(input, options))).toEqual([
      "Error",
      "kind가 규칙을 어겼다",
    ]);
    options = { ...options, kind: KIND };
    expect(await thrown(decodeProjectFile(input, options))).toEqual([
      "RangeError",
      "scrambleKeys의 키는 길이 16의 Uint8Array여야 한다",
    ]);
    options = { ...options, scrambleKeys: [new Uint8Array(16)] };
    expect(await thrown(decodeProjectFile(input, options))).toEqual(rulesError);
    options = { ...options, rules: RULES };
    expect(await thrown(decodeProjectFile(input, options))).toEqual(
      limitsError,
    );
  });
});
