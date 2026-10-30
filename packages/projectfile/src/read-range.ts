// 입력에서 필요한 범위만 읽는다. 디코딩이 `Blob`과 `Uint8Array`를 같은 코드로 다루게 한다.
// - `Blob`은 `slice`와 `readBlobBytes`로 범위만 읽는다. 입력 전체를 읽지 않는다.
// - 붙어 있거나 겹친 범위는 읽기 한 번으로 묶는다. 사이가 벌어진 범위는 묶지 않는다.
//   벌어진 틈이 asset 본문일 수 있어서 틈을 읽어 메우지 않는다.
// - 묶음은 `MAX_PARALLEL_READS`개씩 나눠 읽는다. 읽기 호출 수는 그대로이고 동시에 진행하는 수만 줄인다.
// - `Uint8Array`는 복사하지 않고 부분 뷰를 돌려준다. 호출자의 입력이므로 돌려준 뷰를 고치지 않는다.
// - 규칙은 `docs/format.md`의 "읽기 방식"에 있다.
import { blobPartOf, readBlobBytes } from "./blob";

/**
 * `Blob` 입력에서 동시에 진행하는 읽기 수의 상한.
 * 손상 파일은 묶음이 항목 수(최대 `maxFiles` + `maxFolders` + 2)만큼 나뉠 수 있다. 한꺼번에 읽으면 읽기마다 붙는 객체가 한도 검사 전에 메모리를 키운다.
 */
export const MAX_PARALLEL_READS = 16;

/** 반열린 범위 `[start, end)`. ZIP 위치와 파일 위치에 모두 쓰고, 어느 좌표계인지는 호출자가 정한다. */
export interface ByteRange {
  start: number;
  end: number;
}

/** 입력에서 범위를 읽고 asset 범위를 `Blob`으로 내보내는 방법. */
export interface RangeSource {
  /**
   * 범위를 읽어 `ranges`와 같은 순서로 돌려준다. 읽지 못하거나 범위보다 짧게 읽히면 거부(reject)한다.
   * `Blob`이면 붙어 있거나 겹친 범위를 읽기 한 번으로 묶는다. 돌려주는 뷰는 서로 같은 버퍼를 쓸 수 있다.
   */
  read(ranges: readonly ByteRange[]): Promise<Uint8Array[]>;

  /** 범위를 `Blob`으로 만든다. `Blob` 입력이면 읽지 않고 `input.slice`를 쓴다. */
  slice(range: ByteRange): Blob;
}

/** 시작 위치 순서로 붙어 있거나 겹친 범위를 한 덩어리로 묶는다. 덩어리마다 원래 범위의 번호를 담는다. */
function groupRanges(
  ranges: readonly ByteRange[],
): { start: number; end: number; members: number[] }[] {
  const order = ranges
    .map((_, index) => index)
    .sort(
      (a, b) => (ranges[a] as ByteRange).start - (ranges[b] as ByteRange).start,
    );
  const groups: { start: number; end: number; members: number[] }[] = [];
  for (const index of order) {
    const { start, end } = ranges[index] as ByteRange;
    const last = groups[groups.length - 1];
    if (last !== undefined && start <= last.end) {
      last.end = Math.max(last.end, end);
      last.members.push(index);
    } else {
      groups.push({ start, end, members: [index] });
    }
  }
  return groups;
}

/** 입력에서 범위를 읽는 방법을 만든다. */
export function createRangeSource(input: Blob | Uint8Array): RangeSource {
  if (input instanceof Uint8Array) {
    return {
      read: (ranges) =>
        Promise.resolve(
          ranges.map(({ start, end }) => input.subarray(start, end)),
        ),
      slice: ({ start, end }) =>
        new Blob([blobPartOf(input.subarray(start, end))]),
    };
  }
  return {
    async read(ranges) {
      const out: Uint8Array[] = [];
      const groups = groupRanges(ranges);
      // 한 번에 `MAX_PARALLEL_READS`묶음씩 읽는다. 실패하면 남은 묶음을 읽지 않는다.
      for (let first = 0; first < groups.length; first += MAX_PARALLEL_READS) {
        await Promise.all(
          groups.slice(first, first + MAX_PARALLEL_READS).map(async (group) => {
            const bytes = await readBlobBytes(
              input.slice(group.start, group.end),
            );
            // 짧게 읽힌 조각을 손상으로 오판하거나 범위 밖을 읽지 않도록 읽기 실패로 돌린다.
            if (bytes.length !== group.end - group.start) {
              throw new RangeError(
                `범위 [${group.start}, ${group.end})를 ${bytes.length}바이트만 읽었다`,
              );
            }
            for (const index of group.members) {
              const { start, end } = ranges[index] as ByteRange;
              out[index] = bytes.subarray(
                start - group.start,
                end - group.start,
              );
            }
          }),
        );
      }
      return out;
    },
    slice: ({ start, end }) => input.slice(start, end),
  };
}
