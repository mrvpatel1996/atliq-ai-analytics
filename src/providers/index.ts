// ─── Provider Factory ─────────────────────────────────────────
// Creates the right adapter for a given Provider DB record.

import { decryptCredentials } from "../utils/crypto.js";
import { S3ProviderAdapter } from "./s3.js";
import { VimeoProviderAdapter } from "./vimeo.js";
import { GumletProviderAdapter } from "./gumlet.js";
import { CloudflareProviderAdapter } from "./cloudflare.js";
import type { ProviderAdapter } from "./types.js";
import type {
  S3Credentials,
  VimeoCredentials,
  GumletCredentials,
  CloudflareCredentials,
} from "../types/index.js";

export type { ProviderAdapter };
export type { ProviderVideoInfo, VideoUploadResult, StreamUrls } from "./types.js";
export { S3ProviderAdapter } from "./s3.js";
export { VimeoProviderAdapter } from "./vimeo.js";
export { GumletProviderAdapter } from "./gumlet.js";
export { CloudflareProviderAdapter } from "./cloudflare.js";

/** Create a provider adapter from a DB provider record (decrypts credentials). */
export function createProviderAdapter(provider: {
  type: string;
  credentials: string;
}): ProviderAdapter {
  const creds = decryptCredentials(provider.credentials);

  switch (provider.type) {
    case "S3":
      return new S3ProviderAdapter(creds as S3Credentials);
    case "VIMEO":
      return new VimeoProviderAdapter(creds as VimeoCredentials);
    case "GUMLET":
      return new GumletProviderAdapter(creds as GumletCredentials);
    case "CLOUDFLARE":
      return new CloudflareProviderAdapter(creds as CloudflareCredentials);
    default:
      throw new Error(`Unknown provider type: ${provider.type}`);
  }
}
