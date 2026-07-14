import {
  generatePublicId,
  PUBLIC_ID_ALPHABET,
  PUBLIC_ID_LENGTH,
} from './public-id.util';

describe('generatePublicId', () => {
  it('produces an 11-character id', () => {
    expect(generatePublicId()).toHaveLength(PUBLIC_ID_LENGTH);
  });

  it('uses only the base64url alphabet [A-Za-z0-9_-]', () => {
    for (let i = 0; i < 1000; i++) {
      expect(generatePublicId()).toMatch(/^[A-Za-z0-9_-]{11}$/);
    }
  });

  it('is bias-free — every symbol maps from exactly 4 of the 256 byte values', () => {
    expect(PUBLIC_ID_ALPHABET).toHaveLength(64);

    const counts = new Map<string, number>();
    for (let byte = 0; byte < 256; byte++) {
      const symbol = PUBLIC_ID_ALPHABET[byte & 63];
      counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
    }

    expect(counts.size).toBe(64);
    // 256 / 64 = 4 exactly, so no modulo bias.
    expect([...counts.values()].every((count) => count === 4)).toBe(true);
  });

  it('generates 10k unique ids', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      ids.add(generatePublicId());
    }
    expect(ids.size).toBe(10_000);
  });
});
