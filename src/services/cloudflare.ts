import { config } from "../utils/config.js";
import { createLogger } from "../utils/logger.js";
import { pollUntil } from "../utils/retry.js";
import type { CloudflareOptions, UploadResult } from "../types/index.js";

const log = createLogger("cloudflare");

// ─── Cloudflare Stream Service ────────────────────────────────

export const cloudflareService = {
  // ── Upload from URL ───────────────────────────────────────
  // Cloudflare pulls from a public/presigned URL — no local transfer needed

  async uploadFromUrl(
    videoUrl: string,
    options: {
      title?: string;
      tags?: string[];
      cfOptions?: CloudflareOptions;
    } = {}
  ): Promise<UploadResult> {
    const { title, tags = [], cfOptions = {} } = options;

    log.info({ videoUrl: videoUrl.slice(0, 80), title }, "Starting Cloudflare Stream ingest");

    const body: Record<string, unknown> = {
      url: videoUrl,
      meta: {
        name: title ?? "Untitled Video",
        ...(tags.length ? { tags } : {}),
      },
      requireSignedURLs: cfOptions.requireSignedURLs ?? false,
      ...(cfOptions.allowedOrigins ? { allowedOrigins: cfOptions.allowedOrigins } : {}),
      ...(cfOptions.watermark ? { watermark: cfOptions.watermark } : {}),
    };

    const res = await this.apiRequest<CloudflareVideoResponse>(
      "POST",
      "/stream/copy",
      body
    );

    const videoUid = res.result.uid;
    log.info({ videoUid }, "Cloudflare Stream video created, polling status");

    // Poll until ready
    const finalStatus = await pollUntil(
      () => this.getVideo(videoUid),
      (v) =>
        v.result.status.state === "ready" ||
        v.result.status.state === "error",
      {
        intervalMs: 8_000,
        timeoutMs: 30 * 60 * 1000,
        onPoll: (v, elapsed) =>
          log.debug(
            { videoUid, state: v.result.status.state, elapsed },
            "Polling Cloudflare Stream status"
          ),
      }
    );

    const video = finalStatus.result;

    if (video.status.state === "error") {
      throw new Error(
        `Cloudflare Stream failed for ${videoUid}: ${video.status.errorReasonText ?? "unknown"}`
      );
    }

    const hlsUrl = video.playback?.hls;
    const dashUrl = video.playback?.dash;
    const thumbnailUrl = video.thumbnail;

    log.info({ videoUid, hlsUrl }, "Cloudflare Stream upload complete");

    return {
      platformId: videoUid,
      status: "READY",
      hlsUrl,
      dashUrl,
      thumbnailUrl,
      playerUrl: `https://iframe.cloudflarestream.com/${videoUid}`,
      platformMeta: {
        uid: videoUid,
        duration: video.duration,
        size: video.size,
        readyToStream: video.readyToStream,
      },
    };
  },

  // ── TUS upload (for direct binary upload) ─────────────────

  async uploadViaTus(
    localPath: string,
    fileSize: number,
    options: {
      title?: string;
      cfOptions?: CloudflareOptions;
    } = {}
  ): Promise<UploadResult> {
    const { title, cfOptions = {} } = options;

    log.info({ localPath, fileSize }, "Starting Cloudflare Stream TUS upload");

    // Step 1: Create TUS upload endpoint
    const metadata = [
      `name ${btoa(title ?? "Untitled Video")}`,
      `requiresignedurls ${cfOptions.requireSignedURLs ? "true" : "false"}`,
    ].join(",");

    const initRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${config.CLOUDFLARE_ACCOUNT_ID}/stream`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.CLOUDFLARE_API_TOKEN}`,
          "Tus-Resumable": "1.0.0",
          "Upload-Length": String(fileSize),
          "Upload-Metadata": metadata,
        },
      }
    );

    if (!initRes.ok) {
      const text = await initRes.text();
      throw new Error(`Cloudflare TUS init failed [${initRes.status}]: ${text}`);
    }

    const uploadUrl = initRes.headers.get("Location");
    const videoUid = initRes.headers.get("stream-media-id");

    if (!uploadUrl || !videoUid) {
      throw new Error("Cloudflare TUS init did not return Location or stream-media-id headers");
    }

    // Step 2: Upload data in chunks
    const CHUNK_SIZE = 50 * 1024 * 1024; // 50MB
    const file = Bun.file(localPath);
    let offset = 0;

    while (offset < fileSize) {
      const chunk = await file.slice(offset, Math.min(offset + CHUNK_SIZE, fileSize)).arrayBuffer();

      const patchRes = await fetch(uploadUrl, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${config.CLOUDFLARE_API_TOKEN}`,
          "Tus-Resumable": "1.0.0",
          "Upload-Offset": String(offset),
          "Content-Type": "application/offset+octet-stream",
          "Content-Length": String(chunk.byteLength),
        },
        body: chunk,
      });

      if (!patchRes.ok) {
        const text = await patchRes.text();
        throw new Error(`Cloudflare TUS patch failed [${patchRes.status}]: ${text}`);
      }

      offset += chunk.byteLength;
      log.debug({ videoUid, offset, fileSize, pct: ((offset / fileSize) * 100).toFixed(1) }, "TUS progress");
    }

    // Step 3: Poll for readiness
    const finalStatus = await pollUntil(
      () => this.getVideo(videoUid),
      (v) => v.result.status.state === "ready" || v.result.status.state === "error",
      { intervalMs: 8_000, timeoutMs: 30 * 60 * 1000 }
    );

    const video = finalStatus.result;

    if (video.status.state === "error") {
      throw new Error(`Cloudflare Stream failed: ${video.status.errorReasonText}`);
    }

    return {
      platformId: videoUid,
      status: "READY",
      hlsUrl: video.playback?.hls,
      dashUrl: video.playback?.dash,
      thumbnailUrl: video.thumbnail,
      playerUrl: `https://iframe.cloudflarestream.com/${videoUid}`,
      platformMeta: { uid: videoUid, duration: video.duration },
    };
  },

  // ── Get video ─────────────────────────────────────────────

  async getVideo(videoUid: string): Promise<{ result: CloudflareVideo }> {
    return this.apiRequest<{ result: CloudflareVideo }>(
      "GET",
      `/stream/${videoUid}`
    );
  },

  // ── Generate signed URL ───────────────────────────────────

  async getSignedUrl(
    videoUid: string,
    expiresInSeconds = 3600
  ): Promise<string> {
    if (!config.CLOUDFLARE_STREAM_SIGNING_KEY) {
      throw new Error("CLOUDFLARE_STREAM_SIGNING_KEY is not configured");
    }

    const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;

    const res = await this.apiRequest<{ result: { token: string } }>(
      "POST",
      `/stream/${videoUid}/token`,
      { exp }
    );

    return `https://cloudflarestream.com/${res.result.token}/manifest/video.m3u8`;
  },

  // ── Delete ────────────────────────────────────────────────

  async deleteVideo(videoUid: string): Promise<void> {
    await this.apiRequest("DELETE", `/stream/${videoUid}`);
  },

  // ── Raw API helper ────────────────────────────────────────

  async apiRequest<T = unknown>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    const url = `https://api.cloudflare.com/client/v4/accounts/${config.CLOUDFLARE_ACCOUNT_ID}${path}`;

    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${config.CLOUDFLARE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Cloudflare API ${method} ${path} failed [${res.status}]: ${text}`);
    }

    if (res.status === 204) return {} as T;

    return res.json() as Promise<T>;
  },

  // ── Health check ──────────────────────────────────────────

  async healthCheck(): Promise<{ status: "ok" | "error"; latencyMs: number; error?: string }> {
    const start = Date.now();
    try {
      await this.apiRequest("GET", "/stream?limit=1");
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

// ─── Cloudflare API types ─────────────────────────────────────

interface CloudflareVideo {
  uid: string;
  status: {
    state: "pendingupload" | "downloading" | "queued" | "inprogress" | "ready" | "error";
    errorReasonCode?: string;
    errorReasonText?: string;
  };
  meta?: Record<string, unknown>;
  playback?: {
    hls?: string;
    dash?: string;
  };
  thumbnail?: string;
  duration?: number;
  size?: number;
  readyToStream?: boolean;
}

interface CloudflareVideoResponse {
  result: CloudflareVideo;
  success: boolean;
  errors: unknown[];
}
