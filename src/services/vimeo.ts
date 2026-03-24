import * as tus from "tus-js-client";
import { config } from "../utils/config.js";
import { createLogger } from "../utils/logger.js";
import { pollUntil, withRetry } from "../utils/retry.js";
import type { UploadResult, VimeoOptions } from "../types/index.js";

const log = createLogger("vimeo");

const VIMEO_API = "https://api.vimeo.com";

// ─── Vimeo Service ────────────────────────────────────────────

export const vimeoService = {
  // ── Upload via TUS ────────────────────────────────────────

  async upload(
    localPath: string,
    fileSize: number,
    options: {
      title?: string;
      description?: string;
      tags?: string[];
      vimeoOptions?: VimeoOptions;
    } = {}
  ): Promise<UploadResult> {
    const { title, description, tags = [], vimeoOptions = {} } = options;

    log.info({ localPath, fileSize, title }, "Starting Vimeo TUS upload");

    // 1. Create the video record and get TUS upload link
    const videoMeta = await this.createVideoRecord({
      name: title ?? "Untitled Video",
      description: description ?? "",
      size: fileSize,
      privacy: { view: vimeoOptions.privacy ?? config.VIMEO_DEFAULT_PRIVACY },
      ...(vimeoOptions.password ? { password: vimeoOptions.password } : {}),
    });

    const uploadLink: string = videoMeta.upload.upload_link;
    const videoUri: string = videoMeta.uri; // e.g. /videos/123456789
    const videoId = videoUri.split("/").pop()!;

    log.info({ videoId, uploadLink }, "Vimeo video record created");

    // 2. TUS upload
    await this.tusUpload(localPath, fileSize, uploadLink);

    // 3. Add tags if any
    if (tags.length > 0) {
      await this.setTags(videoId, tags);
    }

    // 4. Move to folder if specified
    if (vimeoOptions.folderId) {
      await withRetry(() => this.moveToFolder(videoId, vimeoOptions.folderId!), {
        maxAttempts: 3,
      });
    }

    // 5. Poll until transcoding is complete
    const finalMeta = await pollUntil(
      () => this.getVideoMeta(videoId),
      (meta) => meta.transcode?.status === "complete" || meta.transcode?.status === "error",
      {
        intervalMs: 10_000,
        timeoutMs: 30 * 60 * 1000,
        onPoll: (meta, elapsed) =>
          log.debug({ videoId, status: meta.transcode?.status, elapsed }, "Polling Vimeo status"),
      }
    );

    if (finalMeta.transcode?.status === "error") {
      throw new Error(`Vimeo transcoding failed for video ${videoId}`);
    }

    const embedUrl = `https://player.vimeo.com/video/${videoId}`;
    const playerUrl = `https://vimeo.com/${videoId}`;

    log.info({ videoId, embedUrl }, "Vimeo upload complete");

    return {
      platformId: videoId,
      status: "READY",
      embedUrl,
      playerUrl,
      thumbnailUrl: finalMeta.pictures?.sizes?.[3]?.link,
      platformMeta: {
        uri: videoUri,
        duration: finalMeta.duration,
        width: finalMeta.width,
        height: finalMeta.height,
      },
    };
  },

  // ── Create video record ───────────────────────────────────

  async createVideoRecord(body: Record<string, unknown>): Promise<VimeoVideoResponse> {
    const res = await fetch(`${VIMEO_API}/me/videos`, {
      method: "POST",
      headers: {
        Authorization: `bearer ${config.VIMEO_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/vnd.vimeo.*+json;version=3.4",
      },
      body: JSON.stringify({
        ...body,
        upload: { approach: "tus", size: body.size },
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Vimeo create video failed [${res.status}]: ${text}`);
    }

    return res.json() as Promise<VimeoVideoResponse>;
  },

  // ── TUS upload ────────────────────────────────────────────

  tusUpload(localPath: string, fileSize: number, uploadUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const file = Bun.file(localPath);

      // tus-js-client expects a File-like object
      const upload = new tus.Upload(file as unknown as tus.UploadInput, {
        uploadUrl,
        endpoint: uploadUrl,
        retryDelays: [0, 3000, 5000, 10000, 20000],
        chunkSize: 50 * 1024 * 1024, // 50MB chunks
        headers: {
          Authorization: `bearer ${config.VIMEO_ACCESS_TOKEN}`,
          Accept: "application/vnd.vimeo.*+json;version=3.4",
        },
        uploadSize: fileSize,
        onError: (err) => {
          log.error({ err, uploadUrl }, "TUS upload error");
          reject(err);
        },
        onProgress: (bytesUploaded, bytesTotal) => {
          const pct = ((bytesUploaded / bytesTotal) * 100).toFixed(1);
          log.debug({ pct, bytesUploaded, bytesTotal }, "Vimeo TUS progress");
        },
        onSuccess: () => {
          log.info({ uploadUrl }, "TUS upload complete");
          resolve();
        },
      });

      upload.start();
    });
  },

  // ── Get video metadata ────────────────────────────────────

  async getVideoMeta(videoId: string): Promise<VimeoVideoResponse> {
    const res = await fetch(
      `${VIMEO_API}/videos/${videoId}?fields=uri,transcode,status,pictures,duration,width,height`,
      {
        headers: {
          Authorization: `bearer ${config.VIMEO_ACCESS_TOKEN}`,
          Accept: "application/vnd.vimeo.*+json;version=3.4",
        },
      }
    );

    if (!res.ok) {
      throw new Error(`Vimeo getVideoMeta failed [${res.status}] for video ${videoId}`);
    }

    return res.json() as Promise<VimeoVideoResponse>;
  },

  // ── Set tags ──────────────────────────────────────────────

  async setTags(videoId: string, tags: string[]): Promise<void> {
    await fetch(`${VIMEO_API}/videos/${videoId}/tags`, {
      method: "PUT",
      headers: {
        Authorization: `bearer ${config.VIMEO_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(tags.map((t) => ({ name: t }))),
    });
  },

  // ── Move to folder ────────────────────────────────────────

  async moveToFolder(videoId: string, folderId: string): Promise<void> {
    const res = await fetch(`${VIMEO_API}/me/folders/${folderId}/videos/${videoId}`, {
      method: "PUT",
      headers: {
        Authorization: `bearer ${config.VIMEO_ACCESS_TOKEN}`,
      },
    });

    if (!res.ok && res.status !== 204) {
      log.warn({ videoId, folderId, status: res.status }, "Failed to move video to folder");
    }
  },

  // ── Delete ────────────────────────────────────────────────

  async deleteVideo(videoId: string): Promise<void> {
    await fetch(`${VIMEO_API}/videos/${videoId}`, {
      method: "DELETE",
      headers: {
        Authorization: `bearer ${config.VIMEO_ACCESS_TOKEN}`,
      },
    });
  },

  // ── Bulk import: paginate all videos ────────────────────────

  async importAllVideos(
    credentials: { accessToken: string },
    onProgress?: (progress: { current: number; total: number; videoId: string }) => void
  ): Promise<{ total: number; fetched: number }> {
    const headers = {
      Authorization: `bearer ${credentials.accessToken}`,
      Accept: "application/vnd.vimeo.*+json;version=3.4",
    };

    const fields = [
      "uri", "name", "description", "duration", "created_time", "modified_time",
      "status", "privacy", "pictures", "download", "embed", "tags", "categories",
    ].join(",");

    let page = 1;
    let fetched = 0;
    let total = 0;
    let hasMore = true;

    while (hasMore) {
      const res = await fetch(
        `${VIMEO_API}/me/videos?per_page=100&page=${page}&fields=${fields}`,
        { headers }
      );

      if (!res.ok) {
        throw new Error(`Vimeo list videos failed [${res.status}]: ${await res.text().catch(() => "")}`);
      }

      const data = await res.json() as {
        data: Array<{
          uri: string;
          name: string;
          description?: string | null;
          duration?: number;
          status?: string;
          pictures?: { sizes: Array<{ link: string }> };
          download?: Array<{ link: string; size?: number }>;
          embed?: { html: string };
        }>;
        paging: { next: string | null };
        total: number;
      };

      if (page === 1) total = data.total ?? 0;

      for (const v of data.data) {
        const videoId = v.uri.split("/").pop()!;
        fetched++;
        onProgress?.({ current: fetched, total, videoId });
      }

      hasMore = data.paging?.next !== null && data.data.length > 0;
      page++;

      // Respect Vimeo rate limit: ~1000 req / 15 min
      if (hasMore) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    log.info({ total, fetched }, "Vimeo import all videos complete");
    return { total, fetched };
  },

  // ── Health check ──────────────────────────────────────────

  async healthCheck(): Promise<{ status: "ok" | "error"; latencyMs: number; error?: string }> {
    const start = Date.now();
    try {
      const res = await fetch(`${VIMEO_API}/me`, {
        headers: {
          Authorization: `bearer ${config.VIMEO_ACCESS_TOKEN}`,
          Accept: "application/vnd.vimeo.*+json;version=3.4",
        },
      });

      if (!res.ok) {
        return {
          status: "error",
          latencyMs: Date.now() - start,
          error: `HTTP ${res.status}`,
        };
      }

      return { status: "ok", latencyMs: Date.now() - start };
    } catch (err) {
      return {
        status: "error",
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

// ─── Vimeo API types ─────────────────────────────────────────

interface VimeoVideoResponse {
  uri: string;
  upload: {
    status: string;
    upload_link: string;
    approach: string;
  };
  transcode?: {
    status: "complete" | "error" | "in_progress";
  };
  status?: string;
  duration?: number;
  width?: number;
  height?: number;
  pictures?: {
    sizes: Array<{ width: number; height: number; link: string }>;
  };
}
