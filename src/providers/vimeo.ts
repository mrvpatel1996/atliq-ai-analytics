import * as tus from "tus-js-client";
import { createLogger } from "../utils/logger.js";
import { pollUntil } from "../utils/retry.js";
import type { ProviderAdapter, ProviderVideoInfo, VideoUploadResult, StreamUrls } from "./types.js";
import type { VimeoCredentials } from "../types/index.js";

const log = createLogger("provider:vimeo");
const VIMEO_API = "https://api.vimeo.com";

export class VimeoProviderAdapter implements ProviderAdapter {
  constructor(private readonly creds: VimeoCredentials) {}

  private get headers() {
    return {
      Authorization: `bearer ${this.creds.accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.vimeo.*+json;version=3.4",
    };
  }

  private async apiGet<T>(path: string): Promise<T> {
    const res = await fetch(`${VIMEO_API}${path}`, { headers: this.headers });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Vimeo GET ${path} failed [${res.status}]: ${text}`);
    }
    return res.json() as Promise<T>;
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      const res = await fetch(`${VIMEO_API}/me`, { headers: this.headers });
      return { success: res.ok, error: res.ok ? undefined : `HTTP ${res.status}` };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async listAllVideos(
    onProgress?: (progress: { fetched: number; total: number }) => void
  ): Promise<ProviderVideoInfo[]> {
    const results: ProviderVideoInfo[] = [];
    let page = 1;
    let hasMore = true;
    let total = 0;

    const fields = [
      "uri", "name", "description", "duration", "created_time", "modified_time",
      "status", "privacy", "pictures", "download", "files", "embed",
      "tags", "categories", "transcode",
    ].join(",");

    while (hasMore) {
      const data = await this.apiGet<{
        data: VimeoVideo[];
        paging: { next: string | null };
        total: number;
      }>(`/me/videos?per_page=100&page=${page}&fields=${fields}`);

      if (page === 1) {
        total = data.total ?? 0;
      }

      for (const v of data.data) {
        const videoId = v.uri.split("/").pop()!;
        // Pick best-quality download link by size
        const bestDownload = v.download?.sort((a, b) => (b.size ?? 0) - (a.size ?? 0))[0];

        results.push({
          externalId: videoId,
          title: v.name,
          description: v.description ?? undefined,
          duration: v.duration,
          status: v.status,
          thumbnailUrl: v.pictures?.sizes?.[3]?.link,
          embedUrl: `https://player.vimeo.com/video/${videoId}`,
          streamUrl: bestDownload?.link ?? `https://player.vimeo.com/video/${videoId}`,
          metadata: v as unknown as Record<string, unknown>,
        });
      }

      onProgress?.({ fetched: results.length, total });

      hasMore = data.paging?.next !== null && data.data.length > 0;
      page++;

      // Rate limit: Vimeo allows 1000 req / 15 min — add small delay between pages
      if (hasMore) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    log.info({ count: results.length, total }, "Vimeo video list fetched");
    return results;
  }

  async getVideoDetails(externalId: string): Promise<ProviderVideoInfo> {
    const v = await this.apiGet<VimeoVideo>(
      `/videos/${externalId}?fields=uri,name,description,duration,pictures,status,transcode,download,embed`
    );
    const videoId = v.uri.split("/").pop()!;
    return {
      externalId: videoId,
      title: v.name,
      description: v.description ?? undefined,
      duration: v.duration,
      status: v.status,
      thumbnailUrl: v.pictures?.sizes?.[3]?.link,
      embedUrl: `https://player.vimeo.com/video/${videoId}`,
      streamUrl: v.download?.[0]?.link,
      metadata: v as unknown as Record<string, unknown>,
    };
  }

  async getSourceUrl(externalId: string): Promise<string> {
    const v = await this.apiGet<VimeoVideo>(
      `/videos/${externalId}?fields=download`
    );
    const best = v.download?.sort((a, b) => (b.size ?? 0) - (a.size ?? 0))[0];
    if (!best?.link) {
      throw new Error(`No download URL available for Vimeo video ${externalId}. Account may not support downloads.`);
    }
    return best.link;
  }

  async uploadVideo(
    sourceUrl: string,
    metadata: { title?: string; description?: string; tags?: string[] }
  ): Promise<VideoUploadResult> {
    const title = metadata.title ?? "Untitled Video";

    // 1. Create video record and get TUS upload link
    const createRes = await fetch(`${VIMEO_API}/me/videos`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({
        name: title,
        description: metadata.description ?? "",
        upload: { approach: "pull", link: sourceUrl },
        privacy: { view: this.creds.defaultPrivacy ?? "unlisted" },
      }),
    });

    if (!createRes.ok) {
      const text = await createRes.text();
      throw new Error(`Vimeo create video failed [${createRes.status}]: ${text}`);
    }

    const videoMeta = await createRes.json() as VimeoVideo;
    const videoId = videoMeta.uri.split("/").pop()!;

    log.info({ videoId, title }, "Vimeo video created via pull upload, polling...");

    // 2. Poll until transcoding complete
    const final = await pollUntil(
      () => this.apiGet<VimeoVideo>(
        `/videos/${videoId}?fields=uri,transcode,status,pictures,duration`
      ),
      (v) => v.transcode?.status === "complete" || v.transcode?.status === "error",
      { intervalMs: 10_000, timeoutMs: 30 * 60 * 1000 }
    );

    if (final.transcode?.status === "error") {
      throw new Error(`Vimeo transcoding failed for video ${videoId}`);
    }

    // 3. Add tags if any
    if (metadata.tags?.length) {
      await fetch(`${VIMEO_API}/videos/${videoId}/tags`, {
        method: "PUT",
        headers: this.headers,
        body: JSON.stringify(metadata.tags.map((t) => ({ name: t }))),
      });
    }

    return {
      externalId: videoId,
      embedUrl: `https://player.vimeo.com/video/${videoId}`,
      playerUrl: `https://vimeo.com/${videoId}`,
      thumbnailUrl: final.pictures?.sizes?.[3]?.link,
    };
  }

  async deleteVideo(externalId: string): Promise<void> {
    await fetch(`${VIMEO_API}/videos/${externalId}`, {
      method: "DELETE",
      headers: this.headers,
    });
  }

  async getStreamUrls(externalId: string): Promise<StreamUrls> {
    const v = await this.apiGet<VimeoVideo>(
      `/videos/${externalId}?fields=uri,pictures,embed`
    );
    const videoId = v.uri.split("/").pop()!;
    return {
      embedUrl: `https://player.vimeo.com/video/${videoId}`,
      playerUrl: `https://vimeo.com/${videoId}`,
      thumbnailUrl: v.pictures?.sizes?.[3]?.link,
    };
  }

  /** TUS upload for local-file-based uploads (used by legacy engine) */
  async tusUploadFromFile(
    localPath: string,
    fileSize: number,
    title: string,
    description?: string
  ): Promise<VideoUploadResult> {
    // Create record with TUS approach
    const createRes = await fetch(`${VIMEO_API}/me/videos`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({
        name: title,
        description: description ?? "",
        upload: { approach: "tus", size: fileSize },
        privacy: { view: this.creds.defaultPrivacy ?? "unlisted" },
      }),
    });

    if (!createRes.ok) {
      throw new Error(`Vimeo create failed [${createRes.status}]: ${await createRes.text()}`);
    }

    const meta = await createRes.json() as VimeoVideo;
    const videoId = meta.uri.split("/").pop()!;
    const uploadLink = meta.upload?.upload_link as string;

    await new Promise<void>((resolve, reject) => {
      const file = Bun.file(localPath);
      const upload = new tus.Upload(file as unknown as tus.UploadInput, {
        uploadUrl: uploadLink,
        endpoint: uploadLink,
        retryDelays: [0, 3000, 5000, 10000, 20000],
        chunkSize: 50 * 1024 * 1024,
        headers: { Authorization: `bearer ${this.creds.accessToken}` },
        uploadSize: fileSize,
        onError: reject,
        onSuccess: resolve,
      });
      upload.start();
    });

    const final = await pollUntil(
      () => this.apiGet<VimeoVideo>(`/videos/${videoId}?fields=uri,transcode,pictures`),
      (v) => v.transcode?.status === "complete" || v.transcode?.status === "error",
      { intervalMs: 10_000, timeoutMs: 30 * 60 * 1000 }
    );

    return {
      externalId: videoId,
      embedUrl: `https://player.vimeo.com/video/${videoId}`,
      playerUrl: `https://vimeo.com/${videoId}`,
      thumbnailUrl: final.pictures?.sizes?.[3]?.link,
    };
  }
}

// ─── Vimeo API types ─────────────────────────────────────────

interface VimeoVideo {
  uri: string;
  name: string;
  description: string | null;
  duration?: number;
  status?: string;
  created_time?: string;
  modified_time?: string;
  privacy?: { view: string };
  upload?: {
    upload_link: string;
    approach: string;
    status: string;
  };
  transcode?: {
    status: "complete" | "error" | "in_progress";
  };
  pictures?: {
    sizes: Array<{ width: number; height: number; link: string }>;
  };
  download?: Array<{ quality: string; link: string; size?: number }>;
  files?: Array<{ quality: string; link: string; size?: number; type?: string }>;
  embed?: { html: string };
  tags?: Array<{ name: string }>;
  categories?: Array<{ name: string; uri: string }>;
}
