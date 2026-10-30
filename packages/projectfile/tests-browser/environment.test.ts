/**
 * 브라우저 시험이 브라우저에서 도는지 확인한다.
 * 이 파일이 통과해야 같은 설정으로 돈 다른 시험의 통과가 Chromium에서 난 결과라고 말할 수 있다.
 */
import { describe, expect, it } from "vitest";

describe("브라우저 시험 환경", () => {
  it("Chromium 계열 브라우저의 window와 userAgent가 있다", () => {
    expect(typeof window).toBe("object");
    expect(typeof document).toBe("object");
    expect(navigator.userAgent).toMatch(/Chrome\/\d+/);
  });

  it("코덱이 쓰는 전역이 모두 있다", () => {
    expect(typeof Blob).toBe("function");
    expect(typeof Response).toBe("function");
    expect(typeof TextEncoder).toBe("function");
    expect(typeof TextDecoder).toBe("function");
  });
});
