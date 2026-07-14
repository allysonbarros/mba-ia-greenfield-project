import { randomBytes } from 'node:crypto';

// base64url alphabet — 64 symbols, all within the route-param class
// [A-Za-z0-9_-] (phase-03-videos/TD-05).
export const PUBLIC_ID_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
export const PUBLIC_ID_LENGTH = 11;

/**
 * 11-char base64url identifier from CSPRNG bytes. `byte & 63` is bias-free
 * because 64 divides 256 exactly, so every symbol is equally likely.
 * 64^11 = 2^66 of entropy — collision handling is a UNIQUE + single retry at
 * the persistence layer, not here.
 */
export function generatePublicId(): string {
  const bytes = randomBytes(PUBLIC_ID_LENGTH);
  let id = '';
  for (let i = 0; i < PUBLIC_ID_LENGTH; i++) {
    id += PUBLIC_ID_ALPHABET[bytes[i] & 63];
  }
  return id;
}
