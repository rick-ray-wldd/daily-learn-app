/** cyrb53 — 53-bit 純 JS 雜湊（public domain），Hermes 安全（只用 Math.imul/位元運算）。 */
export function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** 兩個 seed 串接 → ~106-bit、file-path 安全（[0-9a-z]）。 */
export function stableHash(input: string): string {
  return cyrb53(input, 0).toString(36) + cyrb53(input, 1).toString(36);
}
