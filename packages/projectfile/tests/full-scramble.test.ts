/**
 * 포맷 버전 2(ZIP 전체 scramble) 시험.
 * 버전 1과 달라지는 계약만 본다: 헤더 버전, 평문이 남지 않음, 헤더 CRC 범위, 읽기 실패 보고.
 * 이름·한도·ZIP 구조 검사는 두 버전이 같은 코드를 쓰므로 버전 1 시험이 본다.
 * 규칙은 `docs/format.md`의 "scramble"과 "검사 순서"에 있다.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeProjectFile, readProjectFileHeader } from "../src/index";
import {
  craft,
  decode,
  encodeBytes,
  flatten,
  headerBytesOf,
  LIMITS,
  noise,
  RULES,
  richProject,
  KIND,
  value,
} from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** `haystack` 안에 `needle` 바이트열이 있는지 본다. */
function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    if (needle.every((byte, k) => haystack[i + k] === byte)) return true;
  }
  return false;
}

// 버전 1에서 평문이 남는 두 본문을 담은 작은 프로젝트다.
// - asset은 늘 원본 바이트다.
// - 무작위 한글 음절 20자는 deflate가 stored 블록을 골라 텍스트가 그대로 남는다(fflate 기준).
//   fflate를 올려 아래 시험의 대조 단언이 깨지면 stored 블록이 되는 문자열을 다시 고른다.
const MARKER_ASSET = new TextEncoder().encode("PLAIN-ASSET-BODY-0123456789");
const MARKER_TEXT = "맯꿣꼎흤착칆앝몒륾핫량뒠똻쀺쓻헊봟넄긞츴";
const markerProject = () => ({
  folders: [],
  entries: [
    { path: "a.bin", type: "asset" as const, data: MARKER_ASSET },
    { path: "한글.txt", type: "text" as const, data: MARKER_TEXT },
  ],
});

describe("포맷 버전 2", () => {
  it('scrambleScope를 비우면 헤더 버전 1이고 "all"이면 2다', async () => {
    const project = richProject();

    const metadata = await encodeBytes(project);
    const whole = await encodeBytes(project, KIND, undefined, "all");

    const read = async (bytes: Uint8Array) => {
      const header = await readProjectFileHeader(bytes);
      return header.ok ? header.value.version : header.failure.reason;
    };
    expect(await read(metadata)).toBe(1);
    expect(await read(whole)).toBe(2);
  });

  it("폴더, 빈 폴더, 텍스트, asset을 왕복하고 Uint8Array 입력을 바꾸지 않는다", async () => {
    const project = richProject();
    const bytes = await encodeBytes(project, KIND, undefined, "all");
    const before = bytes.slice();

    const fromBytes = value(await decode(bytes));
    const fromBlob = value(await decode(new Blob([bytes])));

    expect(await flatten(fromBytes)).toEqual(await flatten(project));
    expect(await flatten(fromBlob)).toEqual(await flatten(project));
    expect(bytes).toEqual(before);
    const asset = fromBlob.entries.find((entry) => entry.type === "asset");
    expect(asset?.data).toBeInstanceOf(Blob);
  });

  it("같은 입력은 같은 바이트가 된다", async () => {
    const first = await encodeBytes(richProject(), KIND, undefined, "all");
    const second = await encodeBytes(richProject(), KIND, undefined, "all");

    expect(second).toEqual(first);
  });

  it("asset 본문과 stored 텍스트 본문의 평문이 남지 않는다. 버전 1에는 남는다", async () => {
    const whole = await encodeBytes(markerProject(), KIND, undefined, "all");
    const metadata = await encodeBytes(markerProject());

    expect(contains(whole, MARKER_ASSET)).toBe(false);
    expect(contains(whole, new TextEncoder().encode(MARKER_TEXT))).toBe(false);
    // 대조: 버전 1은 이 두 본문을 섞지 않는다.
    expect(contains(metadata, MARKER_ASSET)).toBe(true);
    expect(contains(metadata, new TextEncoder().encode(MARKER_TEXT))).toBe(
      true,
    );
  });

  it("payload의 어느 한 바이트를 고쳐도 거부한다", async () => {
    const bytes = await encodeBytes(
      {
        folders: ["빈"],
        entries: [
          { path: "a.bin", type: "asset", data: noise(40) },
          { path: "b.txt", type: "text", data: "가나다" },
        ],
      },
      KIND,
      undefined,
      "all",
    );
    expect((await decode(bytes)).ok).toBe(true);

    const accepted: number[] = [];
    for (let at = headerBytesOf(); at < bytes.length; at += 1) {
      const changed = bytes.slice();
      changed[at] = (changed[at] as number) ^ 0x01;
      if ((await decode(changed)).ok) accepted.push(at);
    }

    expect(accepted).toEqual([]);
  });

  it("manifest의 formatVersion이 헤더 버전과 다르면 manifest-invalid다", async () => {
    const files = [{ path: "a.js" }];

    expect((await decode(craft(files, { scope: "all" }))).ok).toBe(true);
    expect(
      await decode(craft(files, { scope: "all", formatVersion: 1 })),
    ).toEqual({ ok: false, failure: { reason: "manifest-invalid" } });
  });

  it('scrambleScope가 "metadata"나 "all"이 아니면 던진다', async () => {
    await expect(
      encodeProjectFile({
        kind: KIND,
        entries: [],
        rules: RULES,
        limits: LIMITS,
        scrambleScope: "full" as never,
      }),
    ).rejects.toThrow();
  });
});

describe("포맷 버전 2의 읽기 실패", () => {
  /** `Response.arrayBuffer`가 `failing`번째 호출에서 거부하게 한다. 0이면 거부하지 않고 호출 수만 센다. */
  function stubReads(failing: number): { calls: () => number } {
    const RealResponse = Response;
    let calls = 0;
    vi.stubGlobal(
      "Response",
      class extends RealResponse {
        arrayBuffer(): Promise<ArrayBuffer> {
          calls += 1;
          return calls === failing
            ? Promise.reject(new DOMException("읽기 실패", "NotReadableError"))
            : super.arrayBuffer();
        }
      },
    );
    return { calls: () => calls };
  }

  it("디코딩은 어느 읽기가 실패해도 read-failed다", async () => {
    const bytes = await encodeBytes(richProject(), KIND, undefined, "all");
    const counter = stubReads(0);
    expect((await decode(new Blob([bytes]))).ok).toBe(true);
    const total = counter.calls();
    vi.unstubAllGlobals();
    // 헤더, 중앙 디렉터리, 로컬 헤더 묶음, 전체 CRC, asset 본문이 모두 읽기다.
    expect(total).toBeGreaterThanOrEqual(5);

    for (let failing = 1; failing <= total; failing += 1) {
      stubReads(failing);
      expect(await decode(new Blob([bytes])), `읽기 ${failing}번`).toEqual({
        ok: false,
        failure: { reason: "read-failed" },
      });
      vi.unstubAllGlobals();
    }
  });

  it("인코딩은 asset을 다시 읽다 실패해도 read-failed와 그 path를 돌려준다", async () => {
    const encode = () =>
      encodeProjectFile({
        kind: KIND,
        entries: [
          { path: "a.bin", type: "asset", data: new Blob([noise(64)]) },
        ],
        rules: RULES,
        limits: LIMITS,
        scrambleScope: "all",
      });
    const counter = stubReads(0);
    expect((await encode()).ok).toBe(true);
    const total = counter.calls();
    vi.unstubAllGlobals();
    // CRC 계산 읽기와 섞는 읽기가 따로 있다.
    expect(total).toBe(2);

    for (let failing = 1; failing <= total; failing += 1) {
      stubReads(failing);
      expect(await encode(), `읽기 ${failing}번`).toEqual({
        ok: false,
        failure: { reason: "read-failed", path: "a.bin" },
      });
      vi.unstubAllGlobals();
    }
  });
});
