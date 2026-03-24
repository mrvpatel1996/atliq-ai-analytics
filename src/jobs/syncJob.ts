import { Worker, type Job } from "bullmq";
import { prisma } from "../db.js";
import { createRedisConnection, QUEUE_NAMES } from "./queue.js";
import { syncEngine } from "../sync/engine.js";
import { createLogger } from "../utils/logger.js";
import { config } from "../utils/config.js";
import type { SyncJobData } from "../types/index.js";

const log = createLogger("syncJob");

// ─── Job Processor ────────────────────────────────────────────

async function processSyncJob(job: Job<SyncJobData>): Promise<void> {
  const { jobId, sourceKey, sourceBucket, destinations, platformOptions, title, description, tags } =
    job.data;

  log.info({ jobId, sourceKey, destinations }, "Processing sync job");

  // Update job status to DOWNLOADING
  await prisma.syncJob.update({
    where: { id: jobId },
    data: {
      status: "DOWNLOADING",
      startedAt: new Date(),
      attempts: job.attemptsMade + 1,
      bullJobId: job.id,
    },
  });

  await job.updateProgress(5);

  try {
    await syncEngine.execute({
      jobId,
      sourceKey,
      sourceBucket,
      destinations,
      platformOptions,
      title,
      description,
      tags,
      onProgress: async (pct: number) => {
        await job.updateProgress(pct);
      },
    });

    // Mark job complete
    await prisma.syncJob.update({
      where: { id: jobId },
      data: {
        status: "READY",
        completedAt: new Date(),
      },
    });

    await job.updateProgress(100);
    log.info({ jobId }, "Sync job completed successfully");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ jobId, err }, "Sync job failed");

    await prisma.syncJob.update({
      where: { id: jobId },
      data: {
        status: "FAILED",
        lastError: message,
        completedAt: new Date(),
      },
    });

    throw err; // Re-throw so BullMQ can handle retries
  }
}

// ─── Worker factory ───────────────────────────────────────────

let _worker: Worker | null = null;

export function startSyncWorker(): Worker {
  if (_worker) return _worker;

  _worker = new Worker<SyncJobData>(
    QUEUE_NAMES.SYNC,
    processSyncJob,
    {
      connection: createRedisConnection(),
      concurrency: config.SYNC_MAX_CONCURRENCY,
      limiter: {
        max: config.SYNC_MAX_CONCURRENCY,
        duration: 1000,
      },
    }
  );

  _worker.on("completed", (job) => {
    log.info({ jobId: job.data.jobId, bullJobId: job.id }, "Worker: job completed");
  });

  _worker.on("failed", (job, err) => {
    log.error(
      { jobId: job?.data?.jobId, bullJobId: job?.id, err },
      "Worker: job failed"
    );
  });

  _worker.on("error", (err) => {
    log.error({ err }, "Worker error");
  });

  _worker.on("stalled", (jobId) => {
    log.warn({ bullJobId: jobId }, "Worker: job stalled");
  });

  log.info(
    { queue: QUEUE_NAMES.SYNC, concurrency: config.SYNC_MAX_CONCURRENCY },
    "Sync worker started"
  );

  return _worker;
}

export async function stopSyncWorker(): Promise<void> {
  if (_worker) {
    await _worker.close();
    _worker = null;
    log.info("Sync worker stopped");
  }
}
