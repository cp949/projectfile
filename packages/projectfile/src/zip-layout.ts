// ZIP 레코드의 바이트 배치. 레코드 길이, 서명, 필드 위치, 필드 값을 한 곳에 모은다.
// - 읽기(`zip.ts`, `metadata-scramble.ts`)와 쓰기(`zip-write.ts`)가 같은 값을 쓴다. 배치를 바꾸면 여기만 고친다.
// - 위치는 레코드 시작에서 잰 바이트 수다. 정수는 모두 little-endian이다.
// - 이 코덱이 읽거나 쓰는 필드만 이름을 둔다. 이름이 없는 필드는 0으로 두고 읽지 않는다.
// - 필드 값은 읽기도 검사하는 것(압축 방식, 플래그)만 둔다. 쓰기만 하는 버전과 DOS 날짜는 `zip-write.ts`에 있다.
// - 규칙은 `docs/format.md`의 "ZIP과 manifest"에 있다.

/** 로컬 헤더 서명. 레코드 맨 앞 4바이트다. */
export const LOCAL_SIGNATURE = 0x04034b50;

/** 중앙 디렉터리 항목 서명. 레코드 맨 앞 4바이트다. */
export const CENTRAL_SIGNATURE = 0x02014b50;

/** 끝 레코드 서명. 레코드 맨 앞 4바이트다. */
export const EOCD_SIGNATURE = 0x06054b50;

/** 로컬 헤더의 고정 부분 길이. 이름이 바로 뒤따른다. */
export const LOCAL_BYTES = 30;

/** 중앙 디렉터리 항목의 고정 부분 길이. 이름이 바로 뒤따른다. */
export const CENTRAL_BYTES = 46;

/** 끝 레코드 길이. 이 코덱의 ZIP은 주석이 없다. */
export const EOCD_BYTES = 22;

/** 로컬 헤더: 필요한 버전 */
export const LOCAL_VERSION_AT = 4;

/** 로컬 헤더: 일반 목적 플래그 */
export const LOCAL_FLAGS_AT = 6;

/** 로컬 헤더: 압축 방식 */
export const LOCAL_METHOD_AT = 8;

/** 로컬 헤더: DOS 시각 */
export const LOCAL_TIME_AT = 10;

/** 로컬 헤더: DOS 날짜 */
export const LOCAL_DATE_AT = 12;

/** 로컬 헤더: CRC32 */
export const LOCAL_CRC_AT = 14;

/** 로컬 헤더: 압축 크기 */
export const LOCAL_COMPRESSED_SIZE_AT = 18;

/** 로컬 헤더: 풀린 크기 */
export const LOCAL_SIZE_AT = 22;

/** 로컬 헤더: 이름 길이 */
export const LOCAL_NAME_LENGTH_AT = 26;

/** 로컬 헤더: extra 길이 */
export const LOCAL_EXTRA_LENGTH_AT = 28;

/** 중앙 디렉터리 항목: 만든 버전 */
export const CENTRAL_VERSION_MADE_AT = 4;

/** 중앙 디렉터리 항목: 필요한 버전 */
export const CENTRAL_VERSION_NEEDED_AT = 6;

/** 중앙 디렉터리 항목: 일반 목적 플래그 */
export const CENTRAL_FLAGS_AT = 8;

/** 중앙 디렉터리 항목: 압축 방식 */
export const CENTRAL_METHOD_AT = 10;

/** 중앙 디렉터리 항목: DOS 시각 */
export const CENTRAL_TIME_AT = 12;

/** 중앙 디렉터리 항목: DOS 날짜 */
export const CENTRAL_DATE_AT = 14;

/** 중앙 디렉터리 항목: CRC32 */
export const CENTRAL_CRC_AT = 16;

/** 중앙 디렉터리 항목: 압축 크기 */
export const CENTRAL_COMPRESSED_SIZE_AT = 20;

/** 중앙 디렉터리 항목: 풀린 크기 */
export const CENTRAL_SIZE_AT = 24;

/** 중앙 디렉터리 항목: 이름 길이 */
export const CENTRAL_NAME_LENGTH_AT = 28;

/** 중앙 디렉터리 항목: extra 길이 */
export const CENTRAL_EXTRA_LENGTH_AT = 30;

/** 중앙 디렉터리 항목: 주석 길이 */
export const CENTRAL_COMMENT_LENGTH_AT = 32;

/** 중앙 디렉터리 항목: 로컬 헤더 시작 위치 */
export const CENTRAL_LOCAL_OFFSET_AT = 42;

/** 끝 레코드: 이 디스크의 번호 */
export const EOCD_DISK_AT = 4;

/** 끝 레코드: 중앙 디렉터리가 시작하는 디스크의 번호 */
export const EOCD_CENTRAL_DISK_AT = 6;

/** 끝 레코드: 이 디스크의 중앙 디렉터리 항목 수 */
export const EOCD_DISK_ENTRIES_AT = 8;

/** 끝 레코드: 중앙 디렉터리 전체 항목 수 */
export const EOCD_ENTRIES_AT = 10;

/** 끝 레코드: 중앙 디렉터리 바이트 수 */
export const EOCD_CENTRAL_SIZE_AT = 12;

/** 끝 레코드: 중앙 디렉터리 시작 위치 */
export const EOCD_CENTRAL_OFFSET_AT = 16;

/** 끝 레코드: ZIP 주석 길이 */
export const EOCD_COMMENT_LENGTH_AT = 20;

/** 압축 방식: 저장 */
export const METHOD_STORED = 0;

/** 압축 방식: deflate */
export const METHOD_DEFLATE = 8;

/** 일반 목적 비트 0. 항목이 암호화되어 있다. */
export const ENCRYPTED_FLAG = 0x0001;

/** 일반 목적 비트 11. 이름이 UTF-8이다. */
export const UTF8_FLAG = 0x0800;
