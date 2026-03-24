import { createLogger } from "../utils/logger.js";
import { pollUntil } from "../utils/retry.js";
import type { ProviderAdapter, ProviderVideoInfo, VideoUploadResult, StreamUrls } from "./types.js";
import type { CloudflareCredentials } from "../types/index.js";

const log = createLogger("provider:cloudflare");

export class CloudflareProviderAdapter implements ProviderAdapter {
  constructor(private readonly creds: CloudflareCredentials) {}

  private get baseUrl(): string {
    return `https://api.cloudflare.com/client/v4/accounts/${this.creds.accountId}`;
  }

  private get headers() {
    return {
      Authorization: `Bearer ${this.creds.apiToken}`,
      "Content-Type": "application/json",
    };
  }

  private async apiRequest<T>(
    method: "GET" | "POST" | "DELETE" | "PATCH",
    path: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Cloudflare ${method} ${path} [${res.status}]: ${text}`);
    }

    if (res.status === 204) return {} as T;
    return res.json() as Promise<T>;
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      await this.apiRequest("GET", "/stream?limit=1");
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async listAllVideos(): Promise<ProviderVideoInfo[]> {
    const results: ProviderVideoInfo[] = [];
    let start: string | undefined;
    let hasMore = true;

    while (hasMore) {
      const path = `/stream${start ? `?start=${start}` : "?limit=100"}`;
      const data = await this.apiRequest<{
        result: CFVideo[];
        result_info?: { next_cursor?: string };
      }>("GET", path);

      for (const v of data.result ?? []) {
        results.push(this.videoToInfo(v));
      }

      const cursor = data.result_info?.next_cursor;
      if (cursor) {
        start = cursor;
      } else {
        hasMore = false;
      }
    }

    log.info({ count: results.length }, "Cloudflare Stream video list fetched");
    return results;
  }

  async getVideoDetails(externalId: string): Promise<ProviderVideoInfo> {
    const data = await this.apiRequest<{ result: CFVideo }>(
      "GET",
      `/stream/${externalId}`
    );
    return this.videoToInfo(data.result);
  }

  async getSourceUrl(externalId: string): Promise<string> {
    const data = await this.apiRequest<{ result: CFVideo }>(
      "GET",
      `/stream/${externalId}`
    );
    const url = data.result.playback?.hls ?? data.result.playback?.dash;
    if (!url) throw new Error(`No playback URL for Cloudflare video ${externalId}`);
    return url;
  }

  async uploadVideo(
    sourceUrl: string,
    metadata: { title?: string; description?: string; tags?: string[] }
  ): Promise<VideoUploadResult> {
    const body = {
      url: sourceUrl,
      meta: {
        name: metadata.title ?? "Untitled Video",
        ...(metadata.tags?.length ? { tags: metadata.tags } : {}),
      },
      requireSignedURLs: false,
    };

    const res = await this.apiRequest<{ result: CFVideo }>(
      "POST",
      "/stream/copy",
      body
    );
    const videoUid = res.result.uid;

    log.info({ videoUid }, "Cloudflare Stream video created, polling...");

    const final = await pollUntil(
      () => this.apiRequest<{ result: CFVideo }>("GET", `/stream/${videoUid}`),
      (v) => v.result.status?.state === "ready" || v.result.status?.state === "error",
      { intervalMs: 8_000, timeoutMs: 30 * 60 * 1000 }
    );

    if (final.result.status?.state === "error") {
      throw new Error(
        `Cloudflare Stream failed: ${final.result.status.errorReasonText ?? "unknown"}`
      );
    }

    return {
      externalId: videoUid,
      hlsUrl: final.result.playback?.hls,
      dashUrl: final.result.playback?.dash,
      playerUrl: `https://iframe.cloudflarestream.com/${videoUid}`,
      thumbnailUrl: final.result.thumbnail,
    };
  }

  async deleteVideo(externalId: string): Promise<void> {
    await this.apiRequest("DELETE", `/stream/${externalId}`);
  }

  async getStreamUrls(externalId: string): Promise<StreamUrls> {
    const data = await this.apiRequest<{ result: CFVideo }>(
      "GET",
      `/stream/${externalId}`
    );
    const v = data.result;
    return {
      hlsUrl: v.playback?.hls,
      dashUrl: v.playback?.dash,
      playerUrl: `https://iframe.cloudflarestream.com/${externalId}`,
      thumbnailUrl: v.thumbnail,
    };
  }

  private videoToInfo(v: CFVideo): ProviderVideoInfo {
    return {
      externalId: v.uid,
      title: typeof v.meta?.name === "string" ? v.meta.name : undefined,
      duration: v.duration,
      size: v.size,
      status: v.status?.state,
      thumbnailUrl: v.thumbnail,
      streamUrl: v.playback?.hls,
      embedUrl: `https://iframe.cloudflarestream.com/${v.uid}`,
      metadata: v as unknown as Record<string, unknown>,
    };
  }
}

// ─── Cloudflare API types ─────────────────────────────────────

interface CFVideo {
  uid: string;
  status?: {
    state: "pendingupload" | "downloading" | "queued" | "inprogress" | "ready" | "error";
    errorReasonCode?: string;
    errorReasonText?: string;
  };
  meta?: Record<string, unknown>;
  playback?: { hls?: string; dash?: string };
  thumbnail?: string;
  duration?: number;
  size?: number;
  readyToStream?: boolean;
}
