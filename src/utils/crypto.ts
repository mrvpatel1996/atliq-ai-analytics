import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { config } from "./config.js";

// ─── AES-256-GCM Encryption ───────────────────────────────────
// Format: base64( iv[12] || authTag[16] || ciphertext )

const ALGORITHM = "aes-256-gcm";

function getKey(): Buffer {
  const key = Buffer.from(config.ENCRYPTION_KEY.slice(0, 64), "hex");
  if (key.length !== 32) {
    throw new Error("ENCRYPTION_KEY must decode to exactly 32 bytes (64 hex chars)");
  }
  return key;
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(12); // 96-bit IV recommended for GCM
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag(); // 16 bytes
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

export function decrypt(encoded: string): string {
  const buf = Buffer.from(encoded, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const encrypted = buf.subarray(28);
  const decipher = createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
    "utf8"
  );
}

export function encryptCredentials(credentials: Record<string, unknown>): string {
  return encrypt(JSON.stringify(credentials));
}

export function decryptCredentials<T = Record<string, unknown>>(
  encrypted: string
): T {
  return JSON.parse(decrypt(encrypted)) as T;
}
