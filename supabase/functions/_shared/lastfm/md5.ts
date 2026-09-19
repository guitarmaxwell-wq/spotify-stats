/**
 * MD5, because Last.fm's api_sig requires it and Web Crypto does not offer it.
 *
 * Standalone (RFC 1321) rather than `node:crypto`, so the Edge Function, the
 * test runner and `deno check` all see the same code with no npm type
 * dependency. Verified against RFC 1321's test suite and against Last.fm's own
 * documented auth.getSession example in lastfm.test.ts.
 *
 * MD5 is used here only because the remote API demands it. Nothing security-
 * sensitive depends on its collision resistance.
 */

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const K = new Uint32Array(64);
for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);

const rotl = (x: number, c: number) => (x << c) | (x >>> (32 - c));

export function md5Bytes(input: Uint8Array): Uint8Array {
  const len = input.length;
  const withPad = new Uint8Array((((len + 8) >> 6) + 1) << 6);
  withPad.set(input);
  withPad[len] = 0x80;
  const bits = len * 8;
  const dv = new DataView(withPad.buffer);
  dv.setUint32(withPad.length - 8, bits >>> 0, true);
  dv.setUint32(withPad.length - 4, Math.floor(bits / 4294967296), true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const M = new Uint32Array(16);
  for (let off = 0; off < withPad.length; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + rotl(F, S[i])) >>> 0;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16);
  new DataView(out.buffer).setUint32(0, a0, true);
  new DataView(out.buffer).setUint32(4, b0, true);
  new DataView(out.buffer).setUint32(8, c0, true);
  new DataView(out.buffer).setUint32(12, d0, true);
  return out;
}

/** md5 of the UTF-8 encoding of `s`, lower-case hex. */
export function md5Hex(s: string): string {
  return [...md5Bytes(new TextEncoder().encode(s))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
