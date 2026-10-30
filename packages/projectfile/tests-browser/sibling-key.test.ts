/**
 * 형제 중복 판정 키의 브라우저 시험.
 * 키는 `toLowerCase`와 `normalize("NFC")`의 결과라서 엔진의 유니코드 데이터를 따른다.
 * Node와 같은 키를 Chromium에서도 만드는지 대표 쌍으로 확인한다. 규칙은 `docs/format.md`의 "이름 규칙"에 있다.
 */
import { describe, expect, it } from "vitest";
import { encodeProjectFile } from "../src/index";
import { KIND, LIMITS, RULES } from "../tests/helpers";

describe("브라우저의 형제 중복 판정 키", () => {
  // 정규형만 다른 쌍(한글 음절과 자모 조합)과, 소문자 결과가 NFC가 아니라 순서에 따라 키가 갈리는 쌍.
  it.each([
    ["가.txt", "가.txt"],
    ["Ω͂.txt", "ῶ.txt"],
  ])("%s 다음의 %s를 duplicate로 거부한다", async (first, second) => {
    const result = await encodeProjectFile({
      kind: KIND,
      entries: [first, second].map((path) => ({
        path,
        type: "text" as const,
        data: "x",
      })),
      rules: RULES,
      limits: LIMITS,
    });

    expect(result).toEqual({
      ok: false,
      failure: { reason: "invalid-name", path: second, cause: "duplicate" },
    });
  });
});
