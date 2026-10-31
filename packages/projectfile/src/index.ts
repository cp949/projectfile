// `@cp949/projectfile`의 공개 API. 여기서 내보내는 것이 전부다.
// - 규칙은 `docs/format.md`에 있다.
export { decodeProjectFile } from "./decode";
export type { DecodedProject, DecodeOptions } from "./decode";
export { encodeProjectFile, PROJECT_FILE_MIME } from "./encode";
export type { EncodeOptions } from "./encode";
export type { DecodedProjectEntry, ProjectEntry } from "./entry";
export type {
  ProjectFileFailure,
  ProjectFileResult,
  ProjectNameCause,
} from "./errors";
export { MAX_HEADER_BYTES } from "./header";
export type { ProjectKind, ScrambleScope } from "./header";
export { readProjectFileHeader } from "./header-info";
export type { ProjectFileHeaderInfo } from "./header-info";
export {
  MAX_PATH_LENGTH_CEILING,
  MAX_UNCOMPRESSED_BYTES_CEILING,
  maxProjectFileBytes,
} from "./limits";
export type { ProjectFileLimits } from "./limits";
export type { ProjectFileRules, SegmentKind } from "./rules";
export { DEFAULT_SCRAMBLE_KEY } from "./scramble";
