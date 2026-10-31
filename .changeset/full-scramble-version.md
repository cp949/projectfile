---
"@cp949/projectfile": minor
---

ZIP 전체를 scramble하는 포맷 버전 2를 더한다.

- `encodeProjectFile`의 옵션 `scrambleScope`(`"metadata"` 또는 `"all"`)가 scramble 범위를 고른다. 비우면 `"metadata"`이고 포맷 버전 1이다.
- `"all"`은 포맷 버전 2다. 텍스트와 asset 본문까지 섞고, 헤더 CRC가 ZIP 전체를 본다.
- `decodeProjectFile`은 옵션 없이 헤더 버전을 보고 두 버전을 모두 연다. 버전 2 파일의 asset `data`는 입력의 `slice`가 아니라 새 `Blob`이다.
- `readProjectFileHeader`의 `version`이 1이나 2를 돌려준다. 1과 2가 아닌 버전은 `unsupported-version`이다.
- 타입 `ScrambleScope`를 내보낸다.
