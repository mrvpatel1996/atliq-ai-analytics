// ─── Provider Video Refresh Job ───────────────────────────────
// Scheduled job (every 6h) that pulls the latest video list from
// all active providers and upserts into ProviderVideo table.
// Also spawned on-demand from the /api/providers/:id/videos/refresh endpoint.

import { Worker, Queue, type Job } from "bullmq";
import { prisma } from "../db.js";
import { createProviderAdapter } from "../providers/index.js";
import { createRedisConnection, QUEUE_NAMES } from "./queue.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("refreshJob");

// ─── Queue ────────────────────────────────────────────────────

let _refreshQueue: Queue | null = null;

export function getRefreshQueue(): Queue {
  if (!_refreshQueue) {
    _refreshQueue = new Queue(QUEUE_NAMES.REFRESH, {
      connection: createRedisConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 10_000 },
        removeOnComplete: { count: 100, age: 3 * 24 * 3600 },
        removeOnFail: { count: 200, age: 7 * 24 * 3600 },
      },
    });
  }
  return _refreshQueue;
}

// ─── Enqueue helpers ──────────────────────────────────────────

/** Enqueue a refresh job for a single provider */
export async function enqueueProviderRefresh(providerId: string): Promise<void> {
  const queue = getRefreshQueue();
  await queue.add("refresh-provider", { providerId }, {
    jobId: `refresh-${providerId}-${Date.now()}`,
  });
  log.info({ providerId }, "Provider refresh enqueued");
}

/** Enqueue refresh for ALL active providers */
export async function enqueueAllProvidersRefresh(): Promise<void> {
  const providers = await prisma.provider.findMany({
    where: { isActive: true },
    select: { id: true, name: true },
  });

  const queue = getRefreshQueue();
  for (const p of providers) {
    await queue.add("refresh-provider", { providerId: p.id }, {
      jobId: `refresh-${p.id}-${Date.now()}`,
    });
  }

  log.info({ count: providers.length }, "All provider refreshes enqueued");
}

// ─── Job processor ────────────────────────────────────────────

async function processRefreshJob(job: Job<{ providerId: string }>): Promise<void> {
  const { providerId } = job.data;
  log.info({ providerId, jobId: job.id }, "Starting provider refresh");

  const provider = await prisma.provider.findUnique({ where: { id: providerId } });
  if (!provider) {
    log.warn({ providerId }, "Provider not found, skipping refresh");
    return;
  }

  if (!provider.isActive) {
    log.info({ providerId }, "Provider inactive, skipping refresh");
    return;
  }

  const adapter = createProviderAdapter(provider);
  const videos = await adapter.listAllVideos();

  let upserted = 0;
  for (const v of videos) {
    await prisma.providerVideo.upsert({
      where: { providerId_externalId: { providerId, externalId: v.externalId } },
      create: {
        providerId,
        externalId: v.externalId,
        title: v.title,
        description: v.description,
        duration: v.duration,
        size: v.size ? BigInt(v.size) : undefined,
        status: v.status,
        thumbnailUrl: v.thumbnailUrl,
        streamUrl: v.streamUrl,
        embedUrl: v.embedUrl,
        metadata: v.metadata,
      },
      update: {
        title: v.title,
        description: v.description,
        duration: v.duration,
        size: v.size ? BigInt(v.size) : undefined,
        status: v.status,
        thumbnailUrl: v.thumbnailUrl,
        streamUrl: v.streamUrl,
        embedUrl: v.embedUrl,
        metadata: v.metadata,
      },
    });
    upserted++;
  }

  await prisma.provider.update({
    where: { id: providerId },
    data: { lastSyncedAt: new Date() },
  });

  log.info({ providerId, upserted }, "Provider refresh complete");
}

// ─── Worker factory ───────────────────────────────────────────

let _refreshWorker: Worker | null = null;

export function startRefreshWorker(concurrency = 3): Worker {
  if (_refreshWorker) return _refreshWorker;

  _refreshWorker = new Worker<{ providerId: string }>(
    QUEUE_NAMES.REFRESH,
    processRefreshJob,
    {
      connection: createRedisConnection(),
      concurrency,
    }
  );

  _refreshWorker.on("completed", (job) => {
    log.info({ jobId: job.id, providerId: job.data.providerId }, "Refresh job completed");
  });

  _refreshWorker.on("failed", (job, err) => {
    log.error({ jobId: job?.id, providerId: job?.data?.providerId, err }, "Refresh job failed");
  });

  _refreshWorker.on("error", (err) => {
    log.error({ err }, "Refresh worker error");
  });

  log.info({ queue: QUEUE_NAMES.REFRESH, concurrency }, "Refresh worker started");
  return _refreshWorker;
}

export async function stopRefreshWorker(): Promise<void> {
  if (_refreshWorker) {
    await _refreshWorker.close();
    _refreshWorker = null;
    log.info("Refresh worker stopped");
  }
}
