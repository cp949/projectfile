/**
 * 프로젝트 파일 왕복 시험.
 * 저장한 프로젝트를 다시 열 때 잃는 것이 없어야 한다. 노드 종류, 빈 폴더, 큰 텍스트, 바이트가 대상이다.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decode,
  encodeBytes,
  flatten,
  noise,
  type Project,
  richProject,
  value,
} from "./helpers";

/** `bytes`를 `SharedArrayBuffer`에 복사한 뷰. */
function shared(bytes: Uint8Array): Uint8Array {
  const view = new Uint8Array(new SharedArrayBuffer(bytes.length));
  view.set(bytes);
  return view;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("프로젝트 파일 왕복", () => {
  it("인코딩한 바이트를 디코딩하면 폴더, 빈 폴더, 텍스트, asset, 노드 종류가 같다", async () => {
    const project = richProject();
    const bytes = await encodeBytes(project);

    const restored = value(await decode(bytes));

    expect(await flatten(restored)).toEqual(await flatten(project));
    // 80,000바이트 이상인 텍스트가 asset으로 바뀌지 않는다.
    const big = restored.entries.find((entry) => entry.path === "img/big.txt");
    expect(big?.type).toBe("text");
    expect(
      new TextEncoder().encode(big?.data as string).length,
    ).toBeGreaterThan(80_000);
  });

  it.each([
    ["길이 1", "a"],
    ["점, 밑줄, 하이픈이 든", "acme-app_v2.blocks"],
    ["길이 64", "a".repeat(64)],
  ])(
    "%s kind로 인코딩하면 같은 kind로 열리고 항목이 같다",
    async (_title, kind) => {
      const project = richProject();
      const bytes = await encodeBytes(project, kind);

      const restored = value(await decode(bytes, kind));

      expect(restored.kind).toBe(kind);
      expect(await flatten(restored)).toEqual(await flatten(project));
    },
  );

  it("텍스트 맨 앞의 U+FEFF도 그대로 돌아온다", async () => {
    const project: Project = {
      folders: [],
      entries: [{ path: "data.txt", type: "text", data: "﻿가" }],
    };

    const restored = value(await decode(await encodeBytes(project)));

    expect(await flatten(restored)).toEqual(await flatten(project));
  });

  it("텍스트 본문의 짝 없는 서로게이트는 오류 없이 U+FFFD로 바뀌어 돌아온다", async () => {
    // UTF-8로 쓸 수 없는 코드 유닛이라 U+FFFD가 된다. 이 동작은 README "사용"이 약속한다.
    // 맨 앞 하위, 중간 상위, 하위·상위 역순, 맨 끝 상위를 함께 넣는다. 한 자리만 틀리는 변환도 잡는다.
    const project: Project = {
      folders: [],
      entries: [
        {
          path: "data.txt",
          type: "text",
          data: "\uDC00x\uD800y\uDC00\uD800z\uDBFF",
        },
      ],
    };

    const restored = value(await decode(await encodeBytes(project)));

    expect(restored.entries).toEqual([
      {
        path: "data.txt",
        type: "text",
        data: "\uFFFDx\uFFFDy\uFFFD\uFFFDz\uFFFD",
      },
    ]);
  });

  it("SharedArrayBuffer 뷰인 asset과 입력도 왕복한다", async () => {
    // 브라우저 Blob 생성자는 공유 버퍼 뷰를 TypeError로 거부한다. Node는 받으므로 같게 흉내 낸다.
    const RealBlob = Blob;
    vi.stubGlobal(
      "Blob",
      class extends RealBlob {
        constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
          const sharedView = parts?.some(
            (part) =>
              ArrayBuffer.isView(part) &&
              part.buffer instanceof SharedArrayBuffer,
          );
          if (sharedView) throw new TypeError("공유 버퍼 뷰는 받지 않는다");
          super(parts, options);
        }
      },
    );
    const content = noise(3000);
    const project: Project = {
      folders: [],
      entries: [{ path: "x.bin", type: "asset", data: shared(content) }],
    };

    const bytes = await encodeBytes(project);
    const restored = value(await decode(shared(bytes)));

    expect(await flatten(restored)).toEqual(
      await flatten({
        folders: [],
        entries: [{ path: "x.bin", type: "asset", data: content }],
      }),
    );
  });
});
