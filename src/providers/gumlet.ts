import { createLogger } from "../utils/logger.js";
import { pollUntil } from "../utils/retry.js";
import type { ProviderAdapter, ProviderVideoInfo, VideoUploadResult, StreamUrls } from "./types.js";
import type { GumletCredentials } from "../types/index.js";

const log = createLogger("provider:gumlet");
const GUMLET_API = "https://api.gumlet.com/v1";

export class GumletProviderAdapter implements ProviderAdapter {
  constructor(private readonly creds: GumletCredentials) {}

  private get authHeaders() {
    return {
      Authorization: `Bearer ${this.creds.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  private async apiRequest<T>(
    method: "GET" | "POST" | "DELETE" | "PATCH",
    path: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    const res = await fetch(`${GUMLET_API}${path}`, {
      method,
      headers: this.authHeaders,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Gumlet ${method} ${path} [${res.status}]: ${text}`);
    }

    if (res.status === 204) return {} as T;
    return res.json() as Promise<T>;
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      await this.apiRequest("GET", "/video/collections");
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async listAllVideos(): Promise<ProviderVideoInfo[]> {
    const results: ProviderVideoInfo[] = [];
    let page = 1;
    let hasMore = true;
    const collectionId = this.creds.collectionId;

    while (hasMore) {
      const path = collectionId
        ? `/video/assets?collection_id=${collectionId}&page=${page}&limit=100`
        : `/video/assets?page=${page}&limit=100`;

      const data = await this.apiRequest<{
        data: GumletAsset[];
        page_info?: { has_next_page: boolean };
      }>("GET", path);

      for (const asset of data.data ?? []) {
        results.push(this.assetToVideoInfo(asset));
      }

      hasMore = data.page_info?.has_next_page === true;
      page++;
    }

    log.info({ count: results.length }, "Gumlet video list fetched");
    return results;
  }

  async getVideoDetails(externalId: string): Promise<ProviderVideoInfo> {
    const asset = await this.apiRequest<GumletAsset>(
      "GET",
      `/video/assets/${externalId}`
    );
    return this.assetToVideoInfo(asset);
  }

  async getSourceUrl(externalId: string): Promise<string> {
    const asset = await this.apiRequest<GumletAsset>(
      "GET",
      `/video/assets/${externalId}`
    );
    const url = asset.output?.hls ?? asset.output?.mp4;
    if (!url) throw new Error(`No stream URL available for Gumlet asset ${externalId}`);
    return url;
  }

  async uploadVideo(
    sourceUrl: string,
    metadata: { title?: string; description?: string; tags?: string[] }
  ): Promise<VideoUploadResult> {
    const body: Record<string, unknown> = {
      source_url: sourceUrl,
      ...(this.creds.collectionId ? { collection_id: this.creds.collectionId } : {}),
      ...(metadata.title ? { title: metadata.title } : {}),
      ...(metadata.tags?.length ? { tag: metadata.tags } : {}),
    };

    const res = await this.apiRequest<{ asset_id: string }>(
      "POST",
      "/video/assets",
      body
    );
    const assetId = res.asset_id;

    log.info({ assetId }, "Gumlet asset created, polling...");

    const final = await pollUntil(
      () => this.apiRequest<GumletAsset>("GET", `/video/assets/${assetId}`),
      (a) => a.status === "ready" || a.status === "error" || a.status === "failed",
      { intervalMs: 8_000, timeoutMs: 30 * 60 * 1000 }
    );

    if (final.status === "error" || final.status === "failed") {
      throw new Error(`Gumlet processing failed for asset ${assetId}`);
    }

    return {
      externalId: assetId,
      hlsUrl: final.output?.hls,
      playerUrl: `https://play.gumlet.io/embed/${assetId}`,
      thumbnailUrl: final.output?.thumbnail,
    };
  }

  async deleteVideo(externalId: string): Promise<void> {
    await this.apiRequest("DELETE", `/video/assets/${externalId}`);
  }

  async getStreamUrls(externalId: string): Promise<StreamUrls> {
    const asset = await this.apiRequest<GumletAsset>(
      "GET",
      `/video/assets/${externalId}`
    );
    return {
      hlsUrl: asset.output?.hls,
      playerUrl: `https://play.gumlet.io/embed/${externalId}`,
      thumbnailUrl: asset.output?.thumbnail,
    };
  }

  private assetToVideoInfo(asset: GumletAsset): ProviderVideoInfo {
    return {
      externalId: asset.asset_id,
      title: asset.title,
      duration: asset.duration,
      status: asset.status,
      thumbnailUrl: asset.output?.thumbnail,
      streamUrl: asset.output?.hls,
      embedUrl: `https://play.gumlet.io/embed/${asset.asset_id}`,
      metadata: asset as unknown as Record<string, unknown>,
    };
  }
}

// ─── Gumlet API types ─────────────────────────────────────────

interface GumletAsset {
  asset_id: string;
  collection_id?: string;
  status: "queued" | "processing" | "ready" | "error" | "failed";
  title?: string;
  duration?: number;
  width?: number;
  height?: number;
  format?: string;
  output?: {
    hls?: string;
    dash?: string;
    thumbnail?: string;
    mp4?: string;
  };
}
