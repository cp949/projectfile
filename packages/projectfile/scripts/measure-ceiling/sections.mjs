// 텍스트 위주 시간 구간 측정의 작업 내용. Node와 브라우저가 같은 코드를 실행한다.
// - `text-heavy` 시나리오의 입력(`workload.mjs`)으로 인코딩과 디코딩의 구간 시간을 잰다.
// - 구간은 라이브러리 내부 코드(`zip-write.ts`, `zip.ts`, `decode.ts`)가 부르는 호출을 같은 인자로 따로 돈다.
//   fflate `deflateSync`와 `Inflate`는 기본 수준과 조각 크기를 그대로 쓰고, `crc32`는 호출자가 `src/crc32.ts`에서 넘긴다.
// - 전체 시간은 공개 API(`encodeProjectFile`, `decodeProjectFile`)를 부른 시간이다.
// - 워밍업 1회는 결과에서 빼고, 이어서 `runs`회 잰다. 한 회에서 모든 구간을 차례로 돈다.
// - 이 파일은 Node 내장 모듈을 가져오지 않는다. 브라우저 페이지가 그대로 불러온다.
// - 방법과 결과 해석은 ADR-0001에 있다.
import { deflateSync, Inflate } from "fflate";
import { buildPlan, KIND, makeEntries, settingsFor } from "./workload.mjs";

/** `zip.ts`의 `INFLATE_CHUNK_BYTES`와 같은 값. `Inflate`에 한 번에 미는 압축 바이트. */
const INFLATE_CHUNK_BYTES = 16 * 1024;

/** `zip-write.ts`의 `CRC_CHUNK_BYTES`와 같은 값. asset `Blob`을 읽는 단위. */
const CRC_CHUNK_BYTES = 1024 * 1024;

/** 구간 이름. 결과 표의 행 순서다. */
export const ENCODE_SEGMENTS = ["utf8", "crc32", "deflate", "total"];
export const DECODE_SEGMENTS = ["inflate", "crc32", "utf8", "total"];

/** 시간을 잰다. 동기 함수의 값과 걸린 시간(ms)을 돌려준다. */
function timed(fn) {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

/** 비동기 함수의 값과 걸린 시간(ms)을 돌려준다. */
async function timedAsync(fn) {
  const start = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - start };
}

/** `zip.ts`의 `inflateEntry`와 같은 방식으로 deflate 본문을 푼다. 선언 크기와 다르게 풀리면 던진다. */
function inflateLikeZip(body, size) {
  const out = new Uint8Array(size);
  let written = 0;
  const inflate = new Inflate((chunk) => {
    if (written + chunk.length > out.length) throw new Error("선언 크기 초과");
    out.set(chunk, written);
    written += chunk.length;
  });
  for (let start = 0; start < body.length; start += INFLATE_CHUNK_BYTES) {
    const end = Math.min(start + INFLATE_CHUNK_BYTES, body.length);
    inflate.push(body.subarray(start, end), end === body.length);
  }
  if (written !== size) throw new Error("풀린 길이가 선언과 다르다");
  return out;
}

/** asset `Blob`을 조각으로 읽어 CRC32를 이어서 계산한다. `zip-write.ts`의 `crcOfBlob`과 같은 읽기다. */
async function crcOfBlob(blob, crc32) {
  let crc = 0;
  for (let start = 0; start < blob.size; start += CRC_CHUNK_BYTES) {
    const slice = blob.slice(start, start + CRC_CHUNK_BYTES);
    crc = crc32(new Uint8Array(await new Response(slice).arrayBuffer()), crc);
  }
  return crc;
}

/** CRC32 목록이 같은지 대조한다. 다르면 던진다. */
function assertSameCrcs(actual, expected, label) {
  for (let i = 0; i < expected.length; i += 1) {
    if (actual[i] !== expected[i]) {
      throw new Error(`${label}: 텍스트 ${i}의 CRC32가 다르다`);
    }
  }
}

/**
 * 구간 시간을 잰다.
 * - `lib`는 `@cp949/projectfile`의 공개 API다. `deps.crc32`는 `src/crc32.ts`의 함수다.
 * - 반환값의 `encode`와 `decode`는 구간 이름별 시간(ms) 배열이다. 배열 길이는 `runs`다.
 *   `assetCrc`는 인코딩 전체에 든 asset `Blob`의 읽기와 CRC32 시간이다. 구간이 아닌 참고 값이다.
 * - 워밍업 1회에서 라이브러리 결과를 대조한다. 다르면 던진다.
 */
export async function runSections(lib, deps, runs, log) {
  const { crc32 } = deps;
  const plan = buildPlan("text-heavy");
  const { rules, limits } = settingsFor(
    plan,
    lib.MAX_UNCOMPRESSED_BYTES_CEILING,
  );
  const entries = makeEntries(plan);
  const texts = entries.filter((entry) => entry.type === "text");
  const assets = entries.filter((entry) => entry.type === "asset");
  const options = {
    kind: KIND,
    entries,
    folders: plan.folders,
    rules,
    limits,
  };

  const result = {
    encode: Object.fromEntries(ENCODE_SEGMENTS.map((name) => [name, []])),
    decode: Object.fromEntries(DECODE_SEGMENTS.map((name) => [name, []])),
    assetCrc: [],
    sizes: {},
  };
  let encodedBlob = null;

  // 워밍업 1회(회차 0)는 기록하지 않는다. 라이브러리 결과 대조와 크기 기록은 여기서 한다.
  for (let run = 0; run <= runs; run += 1) {
    const record = (side, name, ms) => {
      if (run > 0) result[side][name].push(ms);
    };
    log(run === 0 ? "워밍업" : `${run}/${runs}회`);

    // 인코딩 구간. 라이브러리가 항목마다 하는 일을 구간별로 모두 돈다.
    const encoder = new TextEncoder();
    const utf8 = timed(() => texts.map((entry) => encoder.encode(entry.data)));
    record("encode", "utf8", utf8.ms);

    const crc = timed(() => utf8.value.map((bytes) => crc32(bytes)));
    record("encode", "crc32", crc.ms);

    const deflate = timed(() => utf8.value.map((bytes) => deflateSync(bytes)));
    record("encode", "deflate", deflate.ms);

    const asset = await timedAsync(() =>
      Promise.all(assets.map((entry) => crcOfBlob(entry.data, crc32))),
    );
    if (run > 0) result.assetCrc.push(asset.ms);

    const total = await timedAsync(() => lib.encodeProjectFile(options));
    record("encode", "total", total.ms);
    if (!total.value.ok) {
      throw new Error(`인코딩 실패: ${JSON.stringify(total.value.failure)}`);
    }

    if (run === 0) {
      encodedBlob = total.value.value;
      result.sizes = {
        textBytes: utf8.value.reduce((sum, bytes) => sum + bytes.length, 0),
        deflatedBytes: deflate.value.reduce(
          (sum, body) => sum + body.length,
          0,
        ),
        encodedBytes: encodedBlob.size,
      };
    }

    // 디코딩 구간. 압축 본문은 인코딩 구간의 deflate 결과를 쓴다. 라이브러리가 ZIP에 쓰는 본문과 같다.
    const inflate = timed(() =>
      deflate.value.map((body, i) =>
        inflateLikeZip(body, utf8.value[i].length),
      ),
    );
    record("decode", "inflate", inflate.ms);

    const check = timed(() => inflate.value.map((bytes) => crc32(bytes)));
    record("decode", "crc32", check.ms);
    assertSameCrcs(check.value, crc.value, "디코딩 CRC32");

    const text = timed(() =>
      inflate.value.map((bytes) =>
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          bytes,
        ),
      ),
    );
    record("decode", "utf8", text.ms);

    const decoded = await timedAsync(() =>
      lib.decodeProjectFile(encodedBlob, { kind: KIND, rules, limits }),
    );
    record("decode", "total", decoded.ms);
    if (!decoded.value.ok) {
      throw new Error(`디코딩 실패: ${JSON.stringify(decoded.value.failure)}`);
    }

    if (run === 0) {
      // 구간 코드가 라이브러리와 같은 결과를 내는지 대조한다.
      const libTexts = decoded.value.value.entries.filter(
        (entry) => entry.type === "text",
      );
      if (libTexts.length !== texts.length) {
        throw new Error("디코딩 텍스트 개수가 다르다");
      }
      for (let i = 0; i < texts.length; i += 1) {
        if (
          text.value[i] !== texts[i].data ||
          libTexts[i].data !== texts[i].data
        ) {
          throw new Error(`텍스트 ${i}가 입력과 다르다`);
        }
      }
    }
  }
  return result;
}
