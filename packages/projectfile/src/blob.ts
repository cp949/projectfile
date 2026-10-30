// `Blob` 읽기. 브라우저 하한(Chrome 75)에 `Blob.prototype.arrayBuffer()`가 없어서 `Response`로 읽는다.

/**
 * `Blob`의 바이트를 새 버퍼로 읽는다.
 * 돌려주는 `Uint8Array`는 호출자가 소유한다. 복사 없이 제자리에서 고쳐도 된다.
 * 읽지 못하면 거부(reject)한다.
 */
export async function readBlobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await new Response(blob).arrayBuffer());
}

/**
 * `Uint8Array`를 `Blob` 생성자에 넘길 조각으로 만든다.
 * 브라우저 `Blob` 생성자는 `SharedArrayBuffer` 뷰를 받지 않고 `TypeError`를 던진다. 그때만 복사한다.
 */
export function blobPartOf(bytes: Uint8Array): BlobPart {
  return typeof SharedArrayBuffer !== "undefined" &&
    bytes.buffer instanceof SharedArrayBuffer
    ? bytes.slice()
    : (bytes as Uint8Array<ArrayBuffer>);
}
