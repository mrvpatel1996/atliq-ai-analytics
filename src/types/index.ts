// ─── Shared Types — Video Sync Service ──────────────────────

export type Platform = "VIMEO" | "GUMLET" | "CLOUDFLARE";

export type SyncStatus =
  | "PENDING"
  | "DOWNLOADING"
  | "UPLOADING"
  | "PROCESSING"
  | "READY"
  | "FAILED"
  | "CANCELLED";

// ─── Job Payloads ────────────────────────────────────────────

export interface StartSyncRequest {
  /** S3 object key of the source video */
  sourceKey: string;
  /** S3 bucket (defaults to S3_BUCKET env) */
  sourceBucket?: string;
  /** Human-readable title */
  title?: string;
  /** Description for platform metadata */
  description?: string;
  /** Tags to attach on all platforms */
  tags?: string[];
  /** Target platforms (defaults to SYNC_DEFAULT_DESTINATIONS) */
  destinations?: Platform[];
  /** Per-platform overrides */
  platformOptions?: PlatformOptions;
}

export interface PlatformOptions {
  vimeo?: VimeoOptions;
  gumlet?: GumletOptions;
  cloudflare?: CloudflareOptions;
}

export interface VimeoOptions {
  privacy?: "anybody" | "nobody" | "contacts" | "password" | "unlisted" | "users";
  password?: string;
  folderId?: string;
  description?: string;
}

export interface GumletOptions {
  collectionId?: string;
  encodingProfileId?: string;
  format?: string;
}

export interface CloudflareOptions {
  requireSignedURLs?: boolean;
  allowedOrigins?: string[];
  watermark?: {
    uid: string;
    position?: string;
    scale?: number;
    opacity?: number;
    padding?: number;
  };
}

// ─── BullMQ Job Data ─────────────────────────────────────────

export interface SyncJobData {
  jobId: string;
  // Legacy S3 source
  sourceKey?: string;
  sourceBucket?: string;
  // Provider-based source (new system)
  sourceProviderId?: string;
  destinationProviderIds?: string[];
  sourceVideoId?: string;
  title?: string;
  description?: string;
  tags?: string[];
  destinations?: Platform[];
  platformOptions?: PlatformOptions;
}

export interface SyncJobResult {
  jobId: string;
  results: PlatformSyncResult[];
}

export interface PlatformSyncResult {
  platform: Platform;
  status: SyncStatus;
  platformId?: string;
  embedUrl?: string;
  playerUrl?: string;
  hlsUrl?: string;
  dashUrl?: string;
  thumbnailUrl?: string;
  error?: string;
}

// ─── Service Response Types ──────────────────────────────────

export interface S3VideoInfo {
  key: string;
  bucket: string;
  etag: string;
  size: number;
  contentType: string;
  lastModified: Date;
}

export interface UploadResult {
  platformId: string;
  status: SyncStatus;
  embedUrl?: string;
  playerUrl?: string;
  hlsUrl?: string;
  dashUrl?: string;
  thumbnailUrl?: string;
  platformMeta?: Record<string, unknown>;
}

// ─── API Response Shapes ─────────────────────────────────────

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface JobStatusResponse {
  id: string;
  status: SyncStatus;
  sourceKey: string;
  sourceBucket: string;
  title?: string | null;
  destinations: Platform[];
  attempts: number;
  maxAttempts: number;
  lastError?: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
  results: PlatformResultResponse[];
}

export interface PlatformResultResponse {
  platform: Platform;
  status: SyncStatus;
  platformId?: string | null;
  embedUrl?: string | null;
  playerUrl?: string | null;
  hlsUrl?: string | null;
  dashUrl?: string | null;
  thumbnailUrl?: string | null;
  error?: string | null;
  updatedAt: string;
}

export interface HealthStatus {
  status: "ok" | "degraded" | "down";
  uptime: number;
  database: PlatformHealth;
  redis: PlatformHealth;
  platforms: {
    s3: PlatformHealth;
    vimeo: PlatformHealth;
    gumlet: PlatformHealth;
    cloudflare: PlatformHealth;
  };
}

export interface PlatformHealth {
  status: "ok" | "error";
  latencyMs?: number;
  error?: string;
}

// ─── Webhook Types ───────────────────────────────────────────

export interface VimeoWebhookPayload {
  type: string;
  data: {
    id: number | string;
    uri: string;
    status?: string;
    transcode?: { status: string };
  };
}

export interface GumletWebhookPayload {
  type: string;
  asset_id: string;
  collection_id?: string;
  status?: string;
  message?: string;
  output_url?: string;
  thumbnail?: string;
}

export interface CloudflareWebhookPayload {
  uid: string;
  status: {
    state: string;
    errorReasonCode?: string;
    errorReasonText?: string;
  };
  meta?: Record<string, unknown>;
  playback?: {
    hls?: string;
    dash?: string;
  };
  thumbnail?: string;
}

// ─── Provider Types ──────────────────────────────────────────

export type ProviderType = "S3" | "VIMEO" | "GUMLET" | "CLOUDFLARE";

export interface S3Credentials {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  endpoint?: string;
}

export interface VimeoCredentials {
  accessToken: string;
  defaultPrivacy?: "anybody" | "nobody" | "contacts" | "password" | "unlisted" | "users";
}

export interface GumletCredentials {
  apiKey: string;
  collectionId?: string;
}

export interface CloudflareCredentials {
  accountId: string;
  apiToken: string;
  signingKey?: string;
}

export type ProviderCredentials =
  | S3Credentials
  | VimeoCredentials
  | GumletCredentials
  | CloudflareCredentials;

export interface ProviderVideoInfo {
  externalId: string;
  title?: string;
  description?: string;
  duration?: number;
  size?: number;
  status?: string;
  thumbnailUrl?: string;
  streamUrl?: string;
  embedUrl?: string;
  metadata: Record<string, unknown>;
}

export interface VideoUploadResult {
  externalId: string;
  embedUrl?: string;
  hlsUrl?: string;
  dashUrl?: string;
  playerUrl?: string;
  thumbnailUrl?: string;
}
