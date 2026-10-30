// 프로젝트 파일에 담는 파일 항목. 인코딩 입력과 디코딩 출력의 모양이다.
// - 경로는 `/`로 이은 폴더 이름과 파일 이름이다. ZIP 안의 `files/`를 붙이지 않는다.
// - 폴더는 항목이 아니다. 빈 폴더는 `folders`로 따로 주고받는다.

/** 인코딩 입력 항목. */
export type ProjectEntry =
  | {
      path: string;
      type: "text";

      /**
       * UTF-8로 쓰는 문자열.
       *
       * 짝 없는 서로게이트(U+D800..U+DFFF 코드 유닛):
       * - UTF-8 인코딩에서 U+FFFD로 바뀌어 저장된다.
       * - 오류로 알리지 않는다. 디코딩 결과가 입력과 다르다.
       * - 필요하면 호출자가 인코딩 전에 직접 검사한다.
       * - 경로의 짝 없는 서로게이트는 다르다. `invalid-char`로 거부한다.
       */
      data: string;
    }
  | {
      path: string;
      type: "asset";

      /** 그대로 담는 바이트. */
      data: Blob | Uint8Array;
    };

/**
 * 디코딩 출력 항목. MIME 추정은 호출자가 한다.
 * - asset `data`는 입력의 본문 범위다. `Blob` 입력이면 `input.slice`로 만든 `Blob`이라 읽지도 복사하지도 않는다.
 *   `Uint8Array` 입력이면 그 범위를 복사한 `Blob`이다.
 */
export type DecodedProjectEntry =
  | {
      path: string;
      type: "text";

      /** UTF-8로 되돌린 문자열. */
      data: string;
    }
  | {
      path: string;
      type: "asset";

      /** asset 본문. */
      data: Blob;
    };
