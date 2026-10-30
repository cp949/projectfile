/**
 * 인코딩의 `Blob` asset 읽기 시험.
 * 인코딩은 `Blob` asset의 CRC32를 `Blob.slice`와 `Response`로 조각씩 읽어 계산한다.
 * 디코딩은 asset 본문을 읽지 않아 CRC가 틀려도 왕복 시험이 통과하므로, 같은 내용의 `Uint8Array` 인코딩과 바이트를 비교한다.
 */
import { describe, expect, it } from "vitest";
import { encodeBytes, noise, type Project } from "../tests/helpers";

// CRC 조각 크기(`zip-write.ts`의 `CRC_CHUNK_BYTES`, 1 MiB)를 두 번 넘고 끝 조각이 짧게 남는 크기.
const BIG = 2 * 1024 * 1024 + 17;

describe("인코딩의 Blob asset 읽기", () => {
  it("같은 내용이면 asset이 Blob이든 Uint8Array든 같은 바이트가 된다", async () => {
    const content = noise(BIG);
    const withData = (data: Blob | Uint8Array): Project => ({
      folders: [],
      entries: [{ path: "x.bin", type: "asset", data }],
    });

    const fromBlob = await encodeBytes(withData(new Blob([content])));
    const fromBytes = await encodeBytes(withData(content));

    expect(fromBlob).toEqual(fromBytes);
  });
});
