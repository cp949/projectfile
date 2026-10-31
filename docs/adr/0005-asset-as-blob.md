# asset 본문을 Blob으로 주고받고 메모리에 올리지 않는다

디코딩 출력의 asset `data`는 `Blob`이다. 텍스트는 `string`이다.

- `Blob` 입력은 asset을 입력의 `slice`로 돌려준다. asset 본문을 읽지도 복사하지도 않는다.
- 인코딩은 asset 본문을 읽어 모으지 않고 출력 `Blob`의 조각으로 넣는다. asset은 압축하지 않는다.
- ZIP 쓰기를 직접 구현한다. 텍스트와 manifest 압축만 fflate의 raw deflate를 쓴다.

이 결정은 포맷 버전 1에 해당한다. 버전 2는 asset도 섞으므로 이 구조를 쓰지 못한다(ADR-0007).

쓰는 필드, 읽는 범위, `Uint8Array` 입력의 복사는 `docs/format.md`의 "ZIP 쓰기", "읽기 방식", "알려진 한계"에 있다.

## 이유

- 수백 MiB 프로젝트를 다루려고 asset 본문을 메모리에 올리지 않는다. 풀린 크기 256 MiB의 측정은 ADR-0001에 있다.
- asset을 압축하지 않으므로 ZIP 안의 본문 범위가 원본 바이트다. 이 범위를 그대로 `slice`한 `Blob`이 asset이다.
- asset은 이미 압축된 형식이 많아 deflate가 CPU만 쓴다.
- fflate `zipSync`는 항목 본문을 `Uint8Array`로 받는다. 이 함수를 쓰면 asset 본문을 모두 메모리에 올려야 해서 쓰지 않는다.

## 버린 대안

- asset을 `Uint8Array`로 돌려준다. 디코딩마다 asset 본문을 읽고 복사해야 한다.
- `Blob` 입력을 먼저 전부 읽은 뒤 해석한다. 입력 크기만큼 메모리가 든다. 필요한 범위만 읽는다.
- asset을 deflate한다. 이유는 위와 같다. 본문 범위가 원본 바이트가 아니게 되어 `slice`로 돌려줄 수 없다.

## 결과

- 디코딩은 asset 본문을 읽지 않아 손상을 검사하지 못한다. 알려진 한계는 `docs/format.md`의 "알려진 한계"에 있다.
- `Blob`의 수명은 호출자 책임이다. 입력 `Blob`의 원본이 바뀌거나 사라진 뒤에는 asset `Blob`을 읽지 못할 수 있다.
- 큰 파일은 `Blob`이나 `File`로 넘겨야 이 이점을 얻는다. `Uint8Array` 입력은 asset마다 범위를 복사한다.
- Chrome은 메모리에 있는 `Blob` 총량에 한계가 있다. 측정은 ADR-0001의 "Chrome Blob 저장 한계"에 있다.
