import { Queue, Worker, QueueEvents, type Job } from "bullmq";
import { Redis } from "ioredis";
import { config } from "../utils/config.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("queue");

// ─── Queue names ─────────────────────────────────────────────

export const QUEUE_NAMES = {
  SYNC: "video-sync",
  REFRESH: "provider-refresh",
} as const;

// ─── Redis connection ─────────────────────────────────────────

let _redisClient: Redis | null = null;

export function getRedisClient(): Redis {
  if (!_redisClient) {
    _redisClient = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: null, // Required by BullMQ
      enableReadyCheck: false,
      lazyConnect: false,
    });

    _redisClient.on("connect", () => log.info("Redis connected"));
    _redisClient.on("error", (err) => log.error({ err }, "Redis error"));
    _redisClient.on("close", () => log.warn("Redis connection closed"));
  }
  return _redisClient;
}

// Separate connection for BullMQ (it manages its own lifecycle)
export function createRedisConnection() {
  return new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

// ─── Sync Queue ───────────────────────────────────────────────

let _syncQueue: Queue | null = null;

export function getSyncQueue(): Queue {
  if (!_syncQueue) {
    _syncQueue = new Queue(QUEUE_NAMES.SYNC, {
      connection: createRedisConnection(),
      defaultJobOptions: {
        attempts: config.SYNC_MAX_RETRIES,
        backoff: {
          type: "exponential",
          delay: config.SYNC_RETRY_DELAY_MS,
        },
        removeOnComplete: { count: 500, age: 7 * 24 * 3600 }, // keep 500 jobs, max 7 days
        removeOnFail: { count: 1000, age: 30 * 24 * 3600 },   // keep failures 30 days
      },
    });

    log.info({ queue: QUEUE_NAMES.SYNC }, "Sync queue initialized");
  }
  return _syncQueue;
}

// ─── Queue Events ─────────────────────────────────────────────

let _queueEvents: QueueEvents | null = null;

export function getQueueEvents(): QueueEvents {
  if (!_queueEvents) {
    _queueEvents = new QueueEvents(QUEUE_NAMES.SYNC, {
      connection: createRedisConnection(),
    });

    _queueEvents.on("completed", ({ jobId }) =>
      log.info({ jobId }, "Job completed")
    );
    _queueEvents.on("failed", ({ jobId, failedReason }) =>
      log.error({ jobId, failedReason }, "Job failed")
    );
    _queueEvents.on("stalled", ({ jobId }) =>
      log.warn({ jobId }, "Job stalled")
    );
    _queueEvents.on("progress", ({ jobId, data }) =>
      log.debug({ jobId, data }, "Job progress")
    );
  }
  return _queueEvents;
}

// ─── Add job helper ───────────────────────────────────────────

export async function enqueueSyncJob<T extends Record<string, unknown>>(
  data: T,
  options: { jobId?: string; priority?: number; delay?: number } = {}
): Promise<Job<T>> {
  const queue = getSyncQueue();
  return queue.add(QUEUE_NAMES.SYNC, data, {
    jobId: options.jobId,
    priority: options.priority,
    delay: options.delay,
  }) as Promise<Job<T>>;
}

// ─── Health check ─────────────────────────────────────────────

export async function redisHealthCheck(): Promise<{
  status: "ok" | "error";
  latencyMs: number;
  error?: string;
}> {
  const start = Date.now();
  try {
    await getRedisClient().ping();
    return { status: "ok", latencyMs: Date.now() - start };
  } catch (err) {
    return {
      status: "error",
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── Graceful shutdown ────────────────────────────────────────

export async function closeQueues(): Promise<void> {
  const promises: Promise<void>[] = [];

  if (_syncQueue) {
    promises.push(_syncQueue.close());
  }
  if (_queueEvents) {
    promises.push(_queueEvents.close());
  }
  if (_redisClient) {
    promises.push(_redisClient.quit().then(() => {}));
  }

  await Promise.allSettled(promises);
  _syncQueue = null;
  _queueEvents = null;
  _redisClient = null;

  log.info("Queues closed");
}
