import { createHash, timingSafeEqual } from "node:crypto";

const HASH_PREFIX = "sha256:";

export const hashPassword = (password: string): string =>
  `${HASH_PREFIX}${createHash("sha256").update(password).digest("hex")}`;

export const verifyPassword = (password: string, storedHash: string): boolean => {
  const parsedHash = storedHash.startsWith(HASH_PREFIX) ? storedHash.slice(HASH_PREFIX.length) : storedHash;
  const incomingHash = hashPassword(password).slice(HASH_PREFIX.length);
  const incoming = Buffer.from(incomingHash);
  const stored = Buffer.from(parsedHash);

  if (incoming.length !== stored.length) {
    return false;
  }

  return timingSafeEqual(incoming, stored);
};
