// ─── Provider Adapter Interface ───────────────────────────────
// Each provider implements this interface for the provider management system.
// Credentials are passed per-call so one adapter class can serve multiple accounts.

export interface ProviderVideoInfo {
  externalId: string;       // Platform's own ID
  title?: string;
  description?: string;
  duration?: number;        // seconds
  size?: number;            // bytes
  status?: string;          // platform-native status string
  thumbnailUrl?: string;
  streamUrl?: string;       // Primary stream URL (HLS preferred)
  embedUrl?: string;
  metadata: Record<string, unknown>; // Raw API response
}

export interface VideoUploadResult {
  externalId: string;
  embedUrl?: string;
  hlsUrl?: string;
  dashUrl?: string;
  playerUrl?: string;
  thumbnailUrl?: string;
}

export interface StreamUrls {
  embedUrl?: string;
  hlsUrl?: string;
  dashUrl?: string;
  playerUrl?: string;
  thumbnailUrl?: string;
}

export interface ProviderAdapter {
  /** Verify credentials are valid and the API is reachable */
  testConnection(): Promise<{ success: boolean; error?: string }>;

  /** Fetch all videos from the platform (paginates automatically) */
  listAllVideos(): Promise<ProviderVideoInfo[]>;

  /** Fetch full details for a single video */
  getVideoDetails(externalId: string): Promise<ProviderVideoInfo>;

  /** Get a downloadable/streamable URL for a video (presigned URL for S3, etc.) */
  getSourceUrl(externalId: string): Promise<string>;

  /** Upload a video from a source URL to this provider */
  uploadVideo(
    sourceUrl: string,
    metadata: { title?: string; description?: string; tags?: string[] }
  ): Promise<VideoUploadResult>;

  /** Delete a video from the platform */
  deleteVideo(externalId: string): Promise<void>;

  /** Get all playback URLs for an existing video */
  getStreamUrls(externalId: string): Promise<StreamUrls>;
}
