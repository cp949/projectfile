/** `build-vectors.mjs`의 타입. 시험이 `src`의 공개 API를 넘겨 부른다. */
import type { encodeProjectFile } from "../src/index";

/** 시험 벡터가 쓰는 라이브러리 공개 API. */
export interface VectorLibrary {
  encodeProjectFile: typeof encodeProjectFile;
  DEFAULT_SCRAMBLE_KEY: Uint8Array;
}

/** 시험 파일과 `vectors.json` 내용. 디스크에 쓰지 않는다. */
export interface BuiltVectors {
  /** 파일 이름에서 바이트로. */
  files: Map<string, Uint8Array>;

  /** `vectors.json` 문자열. */
  json: string;
}

export function buildVectors(lib: VectorLibrary): Promise<BuiltVectors>;
