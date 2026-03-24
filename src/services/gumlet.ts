import { config } from "../utils/config.js";
import { createLogger } from "../utils/logger.js";
import { pollUntil } from "../utils/retry.js";
import type { GumletOptions, UploadResult } from "../types/index.js";

const log = createLogger("gumlet");

const GUMLET_API = "https://api.gumlet.com/v1";

// ─── Gumlet Service ───────────────────────────────────────────

export const gumletService = {
  // ── Upload asset from URL ────────────────────────────────
  // Gumlet can ingest from a public or presigned URL — most efficient approach

  async uploadFromUrl(
    videoUrl: string,
    options: {
      title?: string;
      tags?: string[];
      gumletOptions?: GumletOptions;
    } = {}
  ): Promise<UploadResult> {
    const { title, tags = [], gumletOptions = {} } = options;
    const collectionId = gumletOptions.collectionId ?? config.GUMLET_COLLECTION_ID;

    log.info({ videoUrl: videoUrl.slice(0, 80), collectionId, title }, "Starting Gumlet ingest");

    const body: Record<string, unknown> = {
      source_url: videoUrl,
      collection_id: collectionId,
      ...(title ? { title } : {}),
      ...(tags.length ? { tag: tags } : {}),
      ...(gumletOptions.encodingProfileId
        ? { format: gumletOptions.encodingProfileId }
        : {}),
    };

    const res = await this.apiRequest<GumletAssetResponse>("POST", "/video/assets", body);
    const assetId = res.asset_id;

    log.info({ assetId }, "Gumlet asset created, polling status");

    // Poll until processing is done
    const finalStatus = await pollUntil(
      () => this.getAsset(assetId),
      (asset) =>
        asset.status === "ready" ||
        asset.status === "error" ||
        asset.status === "failed",
      {
        intervalMs: 8_000,
        timeoutMs: 30 * 60 * 1000,
        onPoll: (asset, elapsed) =>
          log.debug({ assetId, status: asset.status, elapsed }, "Polling Gumlet status"),
      }
    );

    if (finalStatus.status === "error" || finalStatus.status === "failed") {
      throw new Error(`Gumlet processing failed for asset ${assetId}: ${finalStatus.message ?? "unknown error"}`);
    }

    const hlsUrl = finalStatus.output?.hls;
    const thumbnailUrl = finalStatus.output?.thumbnail;

    log.info({ assetId, hlsUrl }, "Gumlet upload complete");

    return {
      platformId: assetId,
      status: "READY",
      hlsUrl,
      thumbnailUrl,
      playerUrl: `https://play.gumlet.io/embed/${assetId}`,
      platformMeta: {
        collectionId,
        duration: finalStatus.duration,
        width: finalStatus.width,
        height: finalStatus.height,
        format: finalStatus.format,
      },
    };
  },

  // ── Get asset status ──────────────────────────────────────

  async getAsset(assetId: string): Promise<GumletAssetStatusResponse> {
    return this.apiRequest<GumletAssetStatusResponse>("GET", `/video/assets/${assetId}`);
  },

  // ── Delete asset ──────────────────────────────────────────

  async deleteAsset(assetId: string): Promise<void> {
    await this.apiRequest("DELETE", `/video/assets/${assetId}`);
  },

  // ── List collections ──────────────────────────────────────

  async listCollections(): Promise<GumletCollection[]> {
    const res = await this.apiRequest<{ data: GumletCollection[] }>("GET", "/video/collections");
    return res.data ?? [];
  },

  // ── Raw API helper ────────────────────────────────────────

  async apiRequest<T = unknown>(
    method: "GET" | "POST" | "DELETE" | "PATCH",
    path: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    const url = `${GUMLET_API}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${config.GUMLET_API_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Gumlet API ${method} ${path} failed [${res.status}]: ${text}`);
    }

    // 204 No Content
    if (res.status === 204) return {} as T;

    return res.json() as Promise<T>;
  },

  // ── Health check ──────────────────────────────────────────

  async healthCheck(): Promise<{ status: "ok" | "error"; latencyMs: number; error?: string }> {
    const start = Date.now();
    try {
      await this.listCollections();
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

// ─── Gumlet API types ─────────────────────────────────────────

interface GumletAssetResponse {
  asset_id: string;
  collection_id: string;
  status: string;
}

interface GumletAssetStatusResponse {
  asset_id: string;
  collection_id: string;
  status: "queued" | "processing" | "ready" | "error" | "failed";
  message?: string;
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

interface GumletCollection {
  id: string;
  name: string;
  created_at: string;
}
