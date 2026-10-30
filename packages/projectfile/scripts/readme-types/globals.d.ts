// README의 ts 코드 블록이 설명 없이 쓰는 이름을 채운다.
// - `scripts/check-readme.mjs`가 블록 파일과 같은 디렉터리에 복사해 함께 검사한다.
// - 타입은 모두 실제 `src` 타입을 가리킨다. `any`로 채우면 호출 검사가 사라진다.
// - 블록이 같은 이름을 선언하거나 import하면 블록의 선언이 이 선언을 가린다.
// - 라이브러리 이름은 전역으로 열지 않는다. 블록이 import를 빠뜨리면 오류로 드러나야 하기 때문이다.
//   앞 블록의 import를 이어 쓰는 블록의 이름은 `scripts/check-readme.mjs`의 `CONTINUATION_IMPORT`가 채운다.

declare const kind: import("@cp949/projectfile").ProjectKind;
declare const rules: import("@cp949/projectfile").ProjectFileRules;
declare const limits: import("@cp949/projectfile").ProjectFileLimits;
declare const entries: import("@cp949/projectfile").ProjectEntry[];

declare const catBlob: Blob;
declare const file: Blob | Uint8Array;
declare const fileOrBytes: Blob | Uint8Array;
