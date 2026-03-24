// ─── Sync Engine ─────────────────────────────────────────────
// Orchestrates video sync between providers.
// Supports both legacy (S3 key → platform enum) and new (providerId → providerId) modes.

import { unlink } from "fs/promises";
import { prisma } from "../db.js";
import { s3Service } from "../services/s3.js";
import { vimeoService } from "../services/vimeo.js";
import { gumletService } from "../services/gumlet.js";
import { cloudflareService } from "../services/cloudflare.js";
import { createProviderAdapter } from "../providers/index.js";
import { createLogger } from "../utils/logger.js";
import type { SyncExecuteParams } from "./rules.js";
import type { PlatformOptions, UploadResult } from "../types/index.js";

const log = createLogger("sync-engine");

// ─── Main export ─────────────────────────────────────────────

export const syncEngine = {
  async execute(params: SyncExecuteParams): Promise<void> {
    if (params.sourceProviderId) {
      await executeProviderSync(params);
    } else if (params.sourceKey) {
      await executeLegacySync(params);
    } else {
      throw new Error("Either sourceProviderId or sourceKey must be provided");
    }
  },
};

// ─── Provider-based sync ─────────────────────────────────────

async function executeProviderSync(params: SyncExecuteParams): Promise<void> {
  const { jobId, sourceProviderId, destinationProviderIds = [], sourceVideoId } = params;
  const progress = params.onProgress ?? (async () => {});

  log.info({ jobId, sourceProviderId, destinationProviderIds }, "Starting provider sync");

  // 1. Load source provider
  const sourceProvider = await prisma.provider.findUniqueOrThrow({
    where: { id: sourceProviderId! },
  });

  const sourceAdapter = createProviderAdapter(sourceProvider);
  await progress(5);

  // 2. Determine which videos to sync
  let videoExternalIds: string[] = [];

  if (sourceVideoId) {
    // Sync a specific ProviderVideo
    const pv = await prisma.providerVideo.findUniqueOrThrow({
      where: { id: sourceVideoId },
    });
    videoExternalIds = [pv.externalId];
  } else {
    // Sync all videos from source provider
    const videos = await prisma.providerVideo.findMany({
      where: { providerId: sourceProviderId! },
      select: { externalId: true },
    });
    videoExternalIds = videos.map((v) => v.externalId);
  }

  log.info({ jobId, videoCount: videoExternalIds.length }, "Videos to sync");
  await progress(10);

  // 3. Load destination providers
  const destProviders = await prisma.provider.findMany({
    where: { id: { in: destinationProviderIds }, isActive: true },
  });

  // 4. Sync each video to all destinations
  let done = 0;
  for (const externalId of videoExternalIds) {
    // Get source URL from source provider
    let sourceUrl: string;
    try {
      sourceUrl = await sourceAdapter.getSourceUrl(externalId);
    } catch (err) {
      log.error({ externalId, err }, "Failed to get source URL, skipping video");
      continue;
    }

    // Upload to each destination in parallel
    await Promise.allSettled(
      destProviders.map(async (destProvider) => {
        // Create/update SyncJobResult for this destination
        const resultRecord = await prisma.syncJobResult.upsert({
          where: { jobId_providerId: { jobId, providerId: destProvider.id } },
          create: { jobId, providerId: destProvider.id, status: "UPLOADING", startedAt: new Date() },
          update: { status: "UPLOADING", startedAt: new Date() },
        });

        try {
          const destAdapter = createProviderAdapter(destProvider);
          const result = await destAdapter.uploadVideo(sourceUrl, {
            title: params.title,
            description: params.description,
            tags: params.tags,
          });

          await prisma.syncJobResult.update({
            where: { id: resultRecord.id },
            data: {
              status: "READY",
              externalId: result.externalId,
              urls: {
                embedUrl: result.embedUrl,
                hlsUrl: result.hlsUrl,
                dashUrl: result.dashUrl,
                playerUrl: result.playerUrl,
                thumbnailUrl: result.thumbnailUrl,
              },
              completedAt: new Date(),
            },
          });

          log.info({ jobId, destProviderId: destProvider.id, externalId: result.externalId }, "Uploaded to destination");
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await prisma.syncJobResult.update({
            where: { id: resultRecord.id },
            data: { status: "FAILED", error: message, completedAt: new Date() },
          });
          log.error({ jobId, destProviderId: destProvider.id, err }, "Upload to destination failed");
        }
      })
    );

    done++;
    await progress(10 + Math.floor((done / videoExternalIds.length) * 85));
  }

  await progress(100);
  log.info({ jobId }, "Provider sync complete");
}

// ─── Legacy S3-based sync ─────────────────────────────────────

async function executeLegacySync(params: SyncExecuteParams): Promise<void> {
  const {
    jobId,
    sourceKey,
    sourceBucket,
    destinations = [],
    platformOptions = {},
    title,
    description,
    tags = [],
  } = params;

  const progress = params.onProgress ?? (async () => {});
  log.info({ jobId, sourceKey, destinations }, "Starting legacy S3 sync");

  // Get a presigned URL (2h window — enough for all uploads)
  const presignedUrl = await s3Service.getPresignedDownloadUrl(
    sourceKey!,
    7200,
    sourceBucket
  );
  await progress(5);

  // Vimeo needs a local temp file (TUS upload), others work from URL
  const needsLocalFile = destinations.includes("VIMEO");
  let tmpPath: string | null = null;
  let fileSize = 0;

  if (needsLocalFile) {
    tmpPath = `/tmp/vss-${jobId}-${Date.now()}.mp4`;
    log.info({ tmpPath }, "Downloading source video for Vimeo TUS upload");
    await s3Service.downloadToFile(sourceKey!, tmpPath, sourceBucket);
    fileSize = Bun.file(tmpPath).size;
  }

  await progress(30);

  try {
    // Upload to all platforms in parallel
    const uploadTasks = destinations.map(async (platform) => {
      const result = await uploadToPlatform(platform, {
        presignedUrl,
        tmpPath,
        fileSize,
        title,
        description,
        tags,
        platformOptions,
      });

      // Save to PlatformResult
      await prisma.platformResult.upsert({
        where: { jobId_platform: { jobId, platform: platform as "VIMEO" | "GUMLET" | "CLOUDFLARE" } },
        create: {
          jobId,
          platform: platform as "VIMEO" | "GUMLET" | "CLOUDFLARE",
          status: result.status,
          platformId: result.platformId,
          embedUrl: result.embedUrl,
          playerUrl: result.playerUrl,
          hlsUrl: result.hlsUrl,
          dashUrl: result.dashUrl,
          thumbnailUrl: result.thumbnailUrl,
          platformMeta: (result.platformMeta ?? {}) as object,
        },
        update: {
          status: result.status,
          platformId: result.platformId,
          embedUrl: result.embedUrl,
          playerUrl: result.playerUrl,
          hlsUrl: result.hlsUrl,
          dashUrl: result.dashUrl,
          thumbnailUrl: result.thumbnailUrl,
          platformMeta: (result.platformMeta ?? {}) as object,
        },
      });

      log.info({ jobId, platform, platformId: result.platformId }, "Platform upload complete");
      return result;
    });

    const results = await Promise.allSettled(uploadTasks);

    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length > 0 && failures.length === destinations.length) {
      throw new Error(
        `All platform uploads failed: ${failures.map((f) => (f as PromiseRejectedResult).reason).join("; ")}`
      );
    }

    await progress(95);
    log.info({ jobId, successCount: results.length - failures.length }, "Legacy sync complete");
  } finally {
    if (tmpPath) {
      await unlink(tmpPath).catch(() => {});
    }
  }
}

// ─── Per-platform upload helper ───────────────────────────────

async function uploadToPlatform(
  platform: string,
  opts: {
    presignedUrl: string;
    tmpPath: string | null;
    fileSize: number;
    title?: string;
    description?: string;
    tags?: string[];
    platformOptions: NonNullable<SyncExecuteParams["platformOptions"]>;
  }
): Promise<UploadResult> {
  const { presignedUrl, tmpPath, fileSize, title, description, tags, platformOptions } = opts;

  switch (platform) {
    case "VIMEO": {
      if (!tmpPath) throw new Error("Vimeo requires a local file (tmpPath missing)");
      return vimeoService.upload(tmpPath, fileSize, {
        title,
        description,
        tags,
        vimeoOptions: platformOptions.vimeo as Parameters<typeof vimeoService.upload>[2]["vimeoOptions"],
      });
    }

    case "GUMLET":
      return gumletService.uploadFromUrl(presignedUrl, {
        title,
        tags,
        gumletOptions: platformOptions.gumlet as Parameters<typeof gumletService.uploadFromUrl>[1]["gumletOptions"],
      });

    case "CLOUDFLARE":
      return cloudflareService.uploadFromUrl(presignedUrl, {
        title,
        tags,
        cfOptions: platformOptions.cloudflare as Parameters<typeof cloudflareService.uploadFromUrl>[1]["cfOptions"],
      });

    default:
      throw new Error(`Unknown platform: ${platform}`);
  }
}
