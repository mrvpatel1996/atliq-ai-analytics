// ─── Bulk Import Job Processor ───────────────────────────────
// BullMQ worker for paginating & importing all provider videos into DB

import { Queue, Worker, type Job } from "bullmq";
import { prisma } from "../db.js";
import { createRedisConnection } from "./queue.js";
import { VimeoProviderAdapter } from "../providers/vimeo.js";
import { createLogger } from "../utils/logger.js";
import type { VimeoCredentials } from "../types/index.js";

const log = createLogger("importJob");

export const IMPORT_QUEUE_NAME = "video-import" as const;

// ─── Job data shape ──────────────────────────────────────────

export interface ImportJobData {
  importJobId: string;   // ImportJob DB record id
  providerId: string;
  providerType: string;  // "VIMEO" | "GUMLET" | "CLOUDFLARE" | "S3"
  credentials: Record<string, unknown>;
}

// ─── Import Queue ────────────────────────────────────────────

let _importQueue: Queue | null = null;

export function getImportQueue(): Queue {
  if (!_importQueue) {
    _importQueue = new Queue(IMPORT_QUEUE_NAME, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      connection: createRedisConnection() as any,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: "fixed", delay: 5000 },
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 500 },
      },
    });
    log.info({ queue: IMPORT_QUEUE_NAME }, "Import queue initialized");
  }
  return _importQueue;
}

export async function enqueueImportJob(data: ImportJobData): Promise<Job<ImportJobData>> {
  const queue = getImportQueue();
  return queue.add(IMPORT_QUEUE_NAME, data) as Promise<Job<ImportJobData>>;
}

// ─── Job Processor ───────────────────────────────────────────

async function processImportJob(job: Job<ImportJobData>): Promise<void> {
  const { importJobId, providerId, providerType, credentials } = job.data;

  log.info({ importJobId, providerId, providerType }, "Starting bulk import job");

  // Update job status to PROCESSING
  await prisma.importJob.update({
    where: { id: importJobId },
    data: { status: "PROCESSING" },
  });

  let imported = 0;
  let failed = 0;
  let skipped = 0;
  let totalVideos = 0;

  try {
    if (providerType === "VIMEO") {
      const adapter = new VimeoProviderAdapter(credentials as unknown as VimeoCredentials);

      const videos = await adapter.listAllVideos(async ({ fetched, total }) => {
        totalVideos = total;
        await job.updateProgress(Math.floor((fetched / Math.max(total, 1)) * 80));
      });

      totalVideos = videos.length;

      // Update total count
      await prisma.importJob.update({
        where: { id: importJobId },
        data: { totalVideos },
      });

      // Upsert each video in batches
      const BATCH_SIZE = 50;
      for (let i = 0; i < videos.length; i += BATCH_SIZE) {
        const batch = videos.slice(i, i + BATCH_SIZE);

        await Promise.allSettled(
          batch.map(async (v) => {
            try {
              const existing = await prisma.providerVideo.findUnique({
                where: { providerId_externalId: { providerId, externalId: v.externalId } },
                select: { id: true, updatedAt: true },
              });

              if (existing) {
                // Already imported — update metadata
                await prisma.providerVideo.update({
                  where: { id: existing.id },
                  data: {
                    title: v.title,
                    description: v.description,
                    duration: v.duration,
                    status: v.status,
                    thumbnailUrl: v.thumbnailUrl,
                    streamUrl: v.streamUrl,
                    embedUrl: v.embedUrl,
                    metadata: v.metadata as any,
                  },
                });
                skipped++;
              } else {
                await prisma.providerVideo.create({
                  data: {
                    providerId,
                    externalId: v.externalId,
                    title: v.title,
                    description: v.description,
                    duration: v.duration,
                    status: v.status,
                    thumbnailUrl: v.thumbnailUrl,
                    streamUrl: v.streamUrl,
                    embedUrl: v.embedUrl,
                    metadata: v.metadata as any,
                  },
                });
                imported++;
              }
            } catch (err) {
              log.warn({ externalId: v.externalId, err }, "Failed to upsert video");
              failed++;
            }
          })
        );

        // Update progress counters in DB periodically
        await prisma.importJob.update({
          where: { id: importJobId },
          data: { imported, failed, skipped },
        });

        await job.updateProgress(80 + Math.floor(((i + batch.length) / videos.length) * 20));
      }
    } else {
      throw new Error(`Unsupported provider type for bulk import: ${providerType}`);
    }

    // Mark complete
    await prisma.importJob.update({
      where: { id: importJobId },
      data: {
        status: "READY",
        imported,
        failed,
        skipped,
        totalVideos,
        completedAt: new Date(),
      },
    });

    // Update provider's lastSyncedAt
    await prisma.provider.update({
      where: { id: providerId },
      data: { lastSyncedAt: new Date() },
    });

    await job.updateProgress(100);
    log.info({ importJobId, imported, failed, skipped, totalVideos }, "Import job completed");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ importJobId, err }, "Import job failed");

    await prisma.importJob.update({
      where: { id: importJobId },
      data: {
        status: "FAILED",
        error: message,
        imported,
        failed,
        skipped,
        completedAt: new Date(),
      },
    });

    throw err;
  }
}

// ─── Worker factory ──────────────────────────────────────────

let _importWorker: Worker | null = null;

export function startImportWorker(): Worker {
  if (_importWorker) return _importWorker;

  _importWorker = new Worker<ImportJobData>(
    IMPORT_QUEUE_NAME,
    processImportJob,
    {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      connection: createRedisConnection() as any,
      concurrency: 2,
    }
  );

  _importWorker.on("completed", (job) => {
    log.info({ importJobId: job.data.importJobId, bullJobId: job.id }, "Import worker: job completed");
  });

  _importWorker.on("failed", (job, err) => {
    log.error({ importJobId: job?.data?.importJobId, err }, "Import worker: job failed");
  });

  _importWorker.on("error", (err) => log.error({ err }, "Import worker error"));

  log.info({ queue: IMPORT_QUEUE_NAME }, "Import worker started");
  return _importWorker;
}

export async function stopImportWorker(): Promise<void> {
  if (_importWorker) {
    await _importWorker.close();
    _importWorker = null;
    log.info("Import worker stopped");
  }
}
