/**
 * 프로젝트 파일 이름 규칙 시험.
 * 경로 조작과 대소문자 중복이 파일로 들어오지 않는다. 조각별 글자·길이 규칙은 호출자의 `checkSegment`가 정한다.
 * 컨테이너 무결성 규칙은 `checkSegment`와 무관하게 강제한다.
 */
import { describe, expect, it } from "vitest";
import {
  decodeProjectFile,
  encodeProjectFile,
  MAX_PATH_LENGTH_CEILING,
  type ProjectEntry,
  type ProjectFileRules,
} from "../src/index";
import { craft, decode, KIND, LIMITS, RULES, value } from "./helpers";

describe("프로젝트 파일 이름 규칙", () => {
  const long = `${"a".repeat(125)}.js`;

  it.each([
    ["`..` 조각", [{ path: "a/../b.js" }], "invalid-char"],
    ["앞 `/`가 붙은 절대 경로", [{ path: "/b.js" }], "empty"],
    ["앞뒤 공백", [{ path: "a.js " }], "invalid-char"],
    [
      "형제 사이 대소문자 무시 중복 파일",
      [{ path: "A.js" }, { path: "a.js" }],
      "duplicate",
    ],
    [
      "형제 사이 대소문자 무시 중복 폴더",
      [
        { path: "Img/a.png", type: "asset" },
        { path: "img/b.png", type: "asset" },
      ],
      "duplicate",
    ],
  ] as const)("%s를 거부한다", async (_title, files, cause) => {
    const bytes = craft([...files]);

    expect(await decode(bytes)).toMatchObject({
      ok: false,
      failure: { reason: "invalid-name", cause },
    });
  });

  it("128자 이름은 받고, 다른 폴더의 같은 이름과 같은 폴더 항목의 중복은 받는다", async () => {
    const bytes = craft(
      [{ path: long }, { path: "a/x.js" }, { path: "b/x.js" }],
      { dirs: ["a"] },
    );

    const restored = value(await decode(bytes));

    // 폴더 항목이 있는 `a`만 폴더 목록에 든다. `b`는 파일 경로의 조상일 뿐이다.
    expect(restored.folders).toEqual(["a"]);
    expect(restored.entries.map((entry) => entry.path)).toEqual([
      long,
      "a/x.js",
      "b/x.js",
    ]);
  });

  /** 규칙 `rules`로 `entries`와 `folders`를 인코딩한 결과의 실패 이유. 성공이면 `null`이다. */
  const encodeFailure = async (
    rules: ProjectFileRules,
    entries: ProjectEntry[],
    folders: string[] = [],
  ) => {
    const result = await encodeProjectFile({
      kind: KIND,
      entries,
      folders,
      rules,
      limits: LIMITS,
    });
    return result.ok ? null : result.failure;
  };
  const text = (path: string): ProjectEntry => ({
    path,
    type: "text",
    data: "x",
  });

  it("인코딩도 호출자 규칙을 어긴 항목을 만들지 않는다", async () => {
    expect(
      await encodeFailure(RULES, [text(`a${"b".repeat(125)}.json`)]),
    ).toMatchObject({
      reason: "invalid-name",
      path: `a${"b".repeat(125)}.json`,
      cause: "too-long",
    });
  });

  it("호출자 규칙은 조각의 종류를 받는다: 마지막 조각은 항목 종류, 나머지는 폴더", async () => {
    const seen: string[] = [];
    const rules: ProjectFileRules = {
      ...RULES,
      checkSegment: (kind, segment) => {
        seen.push(`${kind} ${segment}`);
        return null;
      },
    };

    await encodeFailure(
      rules,
      [
        text("a/b.txt"),
        { path: "c/d.png", type: "asset", data: new Uint8Array(1) },
      ],
      ["e"],
    );

    expect(seen).toEqual([
      "folder e",
      "folder a",
      "file b.txt",
      "folder c",
      "asset d.png",
    ]);
  });

  // 호출자 규칙이 없거나 모든 이름을 통과시켜도 컨테이너가 깨지는 이름은 받지 않는다.
  describe.each([
    ["checkSegment가 없어도", { ...RULES, checkSegment: undefined }],
    ["checkSegment가 모두 통과시켜도", { ...RULES, checkSegment: () => null }],
  ] as const)("%s 무결성 규칙을 강제한다", (_title, rules) => {
    it.each([
      ["빈 조각(`//`)", [text("a//b.js")], "empty"],
      ["앞 `/`", [text("/b.js")], "empty"],
      ["공백만 있는 조각", [text("a/ /b.js")], "empty"],
      ["`.` 조각", [text("a/./b.js")], "invalid-char"],
      ["`..` 조각", [text("a/../b.js")], "invalid-char"],
      ["백슬래시", [text("a\\b.js")], "invalid-char"],
      ["제어 문자", [text("a\u0007.js")], "invalid-char"],
      ["앞 공백", [text(" a.js")], "invalid-char"],
      ["뒤 공백", [text("a.js ")], "invalid-char"],
      // `trim`이 떼는 U+FEFF도 공백이다.
      ["앞 U+FEFF", [text("\uFEFFa.js")], "invalid-char"],
      // 짝 없는 서로게이트는 ZIP 이름에서 U+FFFD가 되어 manifest 경로와 달라진다.
      ["짝 없는 상위 서로게이트", [text("a\uD800.js")], "invalid-char"],
      ["짝 없는 하위 서로게이트", [text("a\uDC00.js")], "invalid-char"],
      [
        "하위, 상위 순서의 서로게이트",
        [text("a\uDC00\uD800.js")],
        "invalid-char",
      ],
      ["형제 대소문자 무시 중복", [text("A.js"), text("a.js")], "duplicate"],
    ] as const)("%s를 거부한다", async (_t, entries, cause) => {
      expect(await encodeFailure(rules, [...entries])).toMatchObject({
        reason: "invalid-name",
        cause,
      });
    });

    it("올바른 서로게이트 쌍(이모지)은 받는다", async () => {
      expect(await encodeFailure(rules, [text("a\uD83D\uDE00.js")])).toBeNull();
    });

    it("폴더 목록의 이름도 같은 규칙으로 거부한다", async () => {
      expect(await encodeFailure(rules, [], ["a", "A"])).toMatchObject({
        reason: "invalid-name",
        path: "A",
        cause: "duplicate",
      });
    });

    it("경로 길이 상한을 넘으면 path-too-long으로 거부한다", async () => {
      const short: ProjectFileRules = { ...rules, maxPathLength: 10 };

      expect(await encodeFailure(short, [text("abcdefghi.js")])).toMatchObject({
        reason: "invalid-name",
        cause: "path-too-long",
      });
      expect(await encodeFailure(short, [text("abcdefg.js")])).toBeNull();
    });
  });

  it("규칙의 maxPathLength가 정수가 아니거나 1 미만이면 던진다", async () => {
    for (const maxPathLength of [Number.NaN, 0, -1, 1.5]) {
      await expect(
        encodeFailure({ ...RULES, maxPathLength }, [text("a.js")]),
      ).rejects.toThrow(RangeError);
    }
  });

  it("한도 항목이 0 이상의 안전한 정수가 아니면 던진다", async () => {
    // 2 ** 53은 정수지만 안전한 정수가 아니다.
    for (const value of [
      Number.NaN,
      -1,
      1.5,
      Number.POSITIVE_INFINITY,
      2 ** 53,
    ]) {
      const limits = { ...LIMITS, maxCodeBytes: value };
      await expect(
        encodeProjectFile({
          kind: KIND,
          entries: [text("a.js")],
          rules: RULES,
          limits,
        }),
      ).rejects.toThrow(RangeError);
      await expect(
        decodeProjectFile(new Uint8Array(0), {
          kind: KIND,
          rules: RULES,
          limits,
        }),
      ).rejects.toThrow(RangeError);
    }
  });

  it("maxFiles + maxFolders + 2가 ZIP 항목 수 상한(65,535)을 넘으면 던진다", async () => {
    // 상수를 일부러 리터럴로 둔다. 상한이 바뀌면 실패하게 한다.
    const over = { ...LIMITS, maxFiles: 1, maxFolders: 65_533 };
    const edge = { ...LIMITS, maxFiles: 1, maxFolders: 65_532 };

    await expect(
      encodeProjectFile({
        kind: KIND,
        entries: [text("a.js")],
        rules: RULES,
        limits: over,
      }),
    ).rejects.toThrow(RangeError);
    await expect(
      decodeProjectFile(new Uint8Array(0), {
        kind: KIND,
        rules: RULES,
        limits: over,
      }),
    ).rejects.toThrow(RangeError);

    // 경계 값은 통과한다.
    expect(
      (
        await encodeProjectFile({
          kind: KIND,
          entries: [text("a.js")],
          rules: RULES,
          limits: edge,
        })
      ).ok,
    ).toBe(true);
  });

  it("규칙의 maxPathLength가 상한을 넘으면 던진다", async () => {
    const rules = { ...RULES, maxPathLength: MAX_PATH_LENGTH_CEILING + 1 };

    await expect(encodeFailure(rules, [text("a.js")])).rejects.toThrow(
      RangeError,
    );
    await expect(
      decodeProjectFile(new Uint8Array(0), {
        kind: KIND,
        rules,
        limits: LIMITS,
      }),
    ).rejects.toThrow(RangeError);
  });

  it("호출자 규칙이 먼저 거부하면 그 이유를 돌려준다", async () => {
    const rules: ProjectFileRules = {
      ...RULES,
      checkSegment: (_kind, segment) =>
        segment.endsWith(".exe") ? "invalid-extension" : null,
    };

    expect(await encodeFailure(rules, [text("a.exe")])).toMatchObject({
      reason: "invalid-name",
      cause: "invalid-extension",
    });
  });

  // 형제 중복 판정 키는 소문자로 바꾼 뒤 NFC로 정규화한 값이다("docs/format.md"의 "이름 규칙").
  // 화면에서 같게 보이는 이름이 한 폴더에 둘 생기지 않게 한다. 키만 바뀌고 저장·복원되는 이름은 입력 그대로다.
  // 이름 규칙은 인코딩과 디코딩이 같은 함수(`checkProject`)를 쓰므로 양쪽 경로를 대표 사례로 확인한다.
  describe("형제 중복 판정의 유니코드 정규화", () => {
    // 같은 폴더에 두면 중복인 이름 쌍. 소스 파일에 NFC와 NFD가 섞이지 않도록 이스케이프로 적는다.
    const equivalentPairs = [
      ["NFC와 NFD로 쓴 악센트 문자", "\u00e9", "e\u0301"],
      ["한글 음절과 자모 조합", "\uac00", "\u1100\u1161"],
      ["NFC에서 코드 유닛이 늘어나는 문자", "\u0958", "\u0915\u093c"],
      ["대소문자와 정규형이 모두 다른 이름", "\u00c9", "e\u0301"],
      // 소문자 변환 결과가 NFC가 아니다. NFC를 먼저 하면 두 키가 U+03C9 U+0342와 U+1FF6으로 갈린다.
      [
        "대소문자만 다르고 소문자 결과가 NFC가 아닌 이름",
        "\u03a9\u0342",
        "\u03c9\u0342",
      ],
      ["대문자 분해형과 소문자 합성형", "\u03a9\u0342", "\u1ff6"],
    ] as const;

    describe.each(equivalentPairs)("%s", (_title, first, second) => {
      it("인코딩은 어느 순서로 두어도 둘째 이름을 duplicate로 거부한다", async () => {
        for (const [a, b] of [
          [first, second],
          [second, first],
        ]) {
          expect(
            await encodeFailure(RULES, [text(`${a}.txt`), text(`${b}.txt`)]),
          ).toEqual({
            reason: "invalid-name",
            path: `${b}.txt`,
            cause: "duplicate",
          });
        }
      });

      it("디코딩도 같은 이유로 거부한다", async () => {
        for (const [a, b] of [
          [first, second],
          [second, first],
        ]) {
          const bytes = craft([{ path: `${a}.txt` }, { path: `${b}.txt` }]);

          expect(await decode(bytes)).toEqual({
            ok: false,
            failure: {
              reason: "invalid-name",
              path: `${b}.txt`,
              cause: "duplicate",
            },
          });
        }
      });
    });

    // 키가 합치지 않아 같은 폴더에 함께 둘 수 있는 이름 쌍. 키 정의의 경계를 고정한다.
    it.each([
      ["호환 동치(NFKC)인 합자와 풀어 쓴 글자", "\ufb01", "fi"],
      ["대소문자 접기에서만 같은 이름", "\u00df", "SS"],
      ["로캘 규칙에서만 같은 이름(터키어 점 있는 I)", "\u0130", "i"],
    ])("%s는 다른 이름으로 받는다", async (_title, first, second) => {
      expect(
        await encodeFailure(RULES, [text(first), text(second)]),
      ).toBeNull();
    });

    it("시그마의 소문자는 조각 전체를 문맥으로 정한다", async () => {
      // 단어 끝 U+03A3은 U+03C2, 그 밖은 U+03C3이 된다. `.`은 문맥에서 건너뛰므로 확장자가 붙으면 단어 끝이 아니다.
      const failure = (names: string[]) =>
        encodeFailure(RULES, names.map(text));

      expect(await failure(["\u0391\u03a3", "\u03b1\u03c2"])).toMatchObject({
        cause: "duplicate",
      });
      expect(await failure(["\u0391\u03a3", "\u03b1\u03c3"])).toBeNull();
      expect(
        await failure(["\u0391\u03a3.txt", "\u03b1\u03c3.txt"]),
      ).toMatchObject({
        cause: "duplicate",
      });
    });

    it("다른 폴더에 있으면 받고 복원한 이름은 입력 그대로다", async () => {
      const paths = ["a/\u00e9.txt", "b/e\u0301.txt"];
      const result = await encodeProjectFile({
        kind: KIND,
        entries: paths.map(text),
        rules: RULES,
        limits: LIMITS,
      });

      const restored = value(await decode(value(result)));

      // NFC와 NFD 모양을 그대로 비교한다. 복원이 이름을 정규화하면 실패한다.
      expect(restored.entries.map((entry) => entry.path)).toEqual(paths);
    });

    it("상위 폴더 이름만 정규형이 달라도 같은 폴더로 보고 거부한다", async () => {
      const first = "a/\u00e9/x.txt";
      const second = "a/e\u0301/y.txt";

      expect(
        await encodeFailure(RULES, [text(first), text(second)]),
      ).toMatchObject({
        reason: "invalid-name",
        path: second,
        cause: "duplicate",
      });
      expect(
        await decode(craft([{ path: first }, { path: second }])),
      ).toMatchObject({
        ok: false,
        failure: { reason: "invalid-name", path: second, cause: "duplicate" },
      });
    });

    it("폴더 목록과 파일 사이에서도 정규형이 다른 같은 이름은 거부한다", async () => {
      expect(
        await encodeFailure(RULES, [text("e\u0301")], ["\u00e9"]),
      ).toMatchObject({
        reason: "invalid-name",
        path: "e\u0301",
        cause: "duplicate",
      });
    });
  });
});
