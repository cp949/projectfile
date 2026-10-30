// CRC32(IEEE 802.3). ZIP이 쓰는 표준 값이다.
// - 헤더 CRC는 scramble 전 ZIP 바이트 기준이다.
// - 이전 결과를 넘기면 조각을 이어서 계산한다. 청크 스트리밍이 들어올 때를 위한 모양이다.
// - 8바이트씩 표 8개를 한 번에 찾는 slice-by-8 방식이다. 결과값은 바이트 단위 계산과 같다.

// 표 8개를 이어 붙인 2,048칸이다. TABLE[k * 256 + n]은 바이트 n 뒤에 0 바이트 k개가 이어질 때의 값이다.
const TABLE = (() => {
  const table = new Uint32Array(8 * 256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[n] = value >>> 0;
  }
  for (let n = 0; n < 256; n += 1) {
    let value = table[n] as number;
    for (let k = 1; k < 8; k += 1) {
      value = (table[value & 0xff] as number) ^ (value >>> 8);
      table[k * 256 + n] = value >>> 0;
    }
  }
  return table;
})();

/** `data`의 CRC32를 부호 없는 32비트 정수로 돌려준다. `previous`는 앞 조각의 결과다. */
export function crc32(data: Uint8Array, previous = 0): number {
  let crc = (previous ^ 0xffffffff) >>> 0;
  const length = data.length;
  const blockEnd = length - (length & 7);
  let i = 0;
  // 바이트를 하나씩 읽어 리틀 엔디언으로 합친다. Uint32Array로 읽으면 byteOffset이 4의 배수여야 하고
  // 값이 플랫폼 엔디안을 따라서 쓰지 않는다. subarray 입력도 그대로 동작한다.
  while (i < blockEnd) {
    const low =
      crc ^
      ((data[i] as number) |
        ((data[i + 1] as number) << 8) |
        ((data[i + 2] as number) << 16) |
        ((data[i + 3] as number) << 24));
    crc =
      (TABLE[7 * 256 + (low & 0xff)] as number) ^
      (TABLE[6 * 256 + ((low >>> 8) & 0xff)] as number) ^
      (TABLE[5 * 256 + ((low >>> 16) & 0xff)] as number) ^
      (TABLE[4 * 256 + (low >>> 24)] as number) ^
      (TABLE[3 * 256 + (data[i + 4] as number)] as number) ^
      (TABLE[2 * 256 + (data[i + 5] as number)] as number) ^
      (TABLE[256 + (data[i + 6] as number)] as number) ^
      (TABLE[data[i + 7] as number] as number);
    i += 8;
  }
  // 8바이트 미만 꼬리는 바이트 단위로 처리한다.
  for (; i < length; i += 1) {
    crc = (TABLE[(crc ^ (data[i] as number)) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
