# @cp949/projectfile

## 0.1.0

### Minor Changes

- 첫 배포한다.
- 공개 API:
  - `encodeProjectFile`: 항목 목록을 `Blob` 하나로 만든다.
  - `decodeProjectFile`: `Blob`이나 `Uint8Array`를 항목 목록으로 되돌린다. 열 수 없는 파일은 던지지 않고 `ok: false`를 돌려준다.
  - `readProjectFileHeader`: 키 없이 헤더만 읽고 검사한다. 서버가 헤더만 검사하는 용도다.
  - `maxProjectFileBytes`: 한도 안의 항목을 인코딩한 파일이 넘지 않는 크기를 계산한다.
  - 상수: `PROJECT_FILE_MIME`, `MAX_HEADER_BYTES`, `MAX_PATH_LENGTH_CEILING`, `MAX_UNCOMPRESSED_BYTES_CEILING`, `DEFAULT_SCRAMBLE_KEY`.
- 포맷:
  - 헤더는 magic `OCOD`, 포맷 버전 1, kind 문자열, payload 길이, CRC32, 키 확인값이다. 길이는 22 + kind 길이 바이트다.
  - payload는 ZIP이다. 로컬 헤더, `manifest.json` 본문, 중앙 디렉터리, 끝 레코드를 scramble한다.
  - kind는 사용처가 정하는 문자열이다. 규칙은 `^[a-z0-9][a-z0-9._-]{0,63}$`다.
  - scramble 키는 호출자가 넘기는 16바이트다. 비우면 `DEFAULT_SCRAMBLE_KEY`를 쓴다.
  - 디코딩한 asset의 `data`는 `Blob`이다. `Blob` 입력이면 입력을 `slice`한 `Blob`이다.
  - `Blob` 입력은 필요한 범위만 읽는다. asset 본문은 읽지 않는다.
  - `maxUncompressedBytes`의 절대 상한은 256 MiB다. 넘는 한도는 던진다.
  - `maxFiles` + `maxFolders` + 2는 65,535 이하여야 한다. ZIP 끝 레코드의 항목 수가 uint16이다. 넘는 한도는 던진다.
  - 형제 이름 중복은 대소문자와 NFC 정규형 차이를 무시한다. 한글 음절과 자모 조합이 같은 이름으로 취급된다. 저장하고 복원하는 이름은 입력 그대로다.
- 브라우저 하한은 Chrome 75다.
