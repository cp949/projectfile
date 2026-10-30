// 코덱이 모르는 정책을 호출자가 주입하는 규칙. 파일 트리, 에디터, 프로필을 코덱은 모른다.
// - 컨테이너 무결성 규칙은 코덱이 항상 강제한다(`check.ts`). 이 규칙으로 약하게 만들 수 없다.
// - 규칙은 `docs/format.md`의 "이름 규칙"에 있다.
import { MAX_PATH_LENGTH_CEILING } from "./limits";
import type { ProjectNameCause } from "./errors";

/** 경로 조각이 놓이는 자리. 마지막 조각만 항목 종류를 따르고 나머지는 `folder`다. */
export type SegmentKind = "file" | "folder" | "asset";

/** 호출자가 주입하는 규칙. */
export interface ProjectFileRules {
  /**
   * 항목 경로의 최대 길이(UTF-16 코드 유닛). `MAX_PATH_LENGTH_CEILING` 이하여야 한다.
   * 입력 크기 상한(`maxProjectFileBytes`)이 그 값으로 이름 길이를 잡는다.
   */
  maxPathLength: number;

  /**
   * 경로 조각 하나를 검사한다. 통과하면 `null`, 아니면 거부 이유다.
   * 코덱의 무결성 검사보다 먼저 불린다. 비우면 무결성 검사만 한다.
   */
  checkSegment?: (
    kind: SegmentKind,
    segment: string,
  ) => ProjectNameCause | null;

  /**
   * 코드 한도(`maxCodeBytes`)에 세는 텍스트 항목이면 참이다. 아니면 asset 한도에 센다.
   * 텍스트 항목의 경로만 넘긴다. asset 항목은 늘 asset 한도에 센다.
   */
  isCode: (path: string) => boolean;
}

/** 규칙이 코덱의 전제를 어기면 던진다. 호출자 버그다. */
export function assertRules(rules: ProjectFileRules): void {
  const { maxPathLength } = rules;
  // NaN이나 음수가 통과하면 경로 길이 검사가 조용히 사라진다.
  if (
    !Number.isInteger(maxPathLength) ||
    maxPathLength < 1 ||
    maxPathLength > MAX_PATH_LENGTH_CEILING
  ) {
    throw new RangeError(
      `maxPathLength는 1 이상 ${MAX_PATH_LENGTH_CEILING} 이하의 정수여야 한다: ${maxPathLength}`,
    );
  }
}
