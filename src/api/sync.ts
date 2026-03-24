// ─── Sync API ────────────────────────────────────────────────
// Start, list, cancel, and check status of sync jobs

import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../db.js";
import { getSyncQueue } from "../jobs/queue.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("api:sync");

const startSyncSchema = z.object({
  sourceProviderId: z.string().cuid(),
  destinationProviderIds: z.array(z.string().cuid()).min(1),
  videoId: z.string().optional(), // ProviderVideo.id — if omitted, sync ALL
  title: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export const syncRouter = new Hono();

// ── POST /api/sync/start ──────────────────────────────────────

syncRouter.post("/start", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = startSyncSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ success: false, error: parsed.error.flatten() }, 400);
  }

  const { sourceProviderId, destinationProviderIds, videoId, title, description, tags } =
    parsed.data;

  // Verify source provider exists
  const sourceProvider = await prisma.provider.findUnique({
    where: { id: sourceProviderId },
  });
  if (!sourceProvider) {
    return c.json({ success: false, error: "Source provider not found" }, 404);
  }

  // Verify destination providers exist
  const destProviders = await prisma.provider.findMany({
    where: { id: { in: destinationProviderIds }, isActive: true },
  });
  if (destProviders.length === 0) {
    return c.json({ success: false, error: "No active destination providers found" }, 400);
  }

  // Create SyncJob in DB
  const job = await prisma.syncJob.create({
    data: {
      status: "PENDING",
      sourceProviderId,
      destinationProviderIds,
      sourceVideoId: videoId,
      title,
      description,
      tags: tags ?? [],
    },
  });

  // Enqueue BullMQ job
  const queue = getSyncQueue();
  const bullJob = await queue.add(
    "provider-sync",
    {
      jobId: job.id,
      sourceProviderId,
      destinationProviderIds,
      sourceVideoId: videoId,
      title,
      description,
      tags,
    },
    { jobId: `sync-${job.id}` }
  );

  await prisma.syncJob.update({
    where: { id: job.id },
    data: { bullJobId: bullJob.id ?? undefined },
  });

  log.info({ jobId: job.id, sourceProviderId, destinations: destinationProviderIds.length }, "Sync job queued");
  return c.json({ success: true, data: { jobId: job.id, bullJobId: bullJob.id } }, 202);
});

// ── GET /api/sync ─────────────────────────────────────────────

syncRouter.get("/", async (c) => {
  const page = Math.max(1, parseInt(c.req.query("page") ?? "1", 10));
  const limit = Math.min(100, parseInt(c.req.query("limit") ?? "20", 10));
  const status = c.req.query("status");

  const where: Record<string, unknown> = {};
  if (status) where.status = status;

  const [jobs, total] = await Promise.all([
    prisma.syncJob.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        status: true,
        sourceProviderId: true,
        destinationProviderIds: true,
        sourceVideoId: true,
        title: true,
        attempts: true,
        createdAt: true,
        updatedAt: true,
        startedAt: true,
        completedAt: true,
        lastError: true,
        _count: { select: { syncResults: true } },
      },
    }),
    prisma.syncJob.count({ where }),
  ]);

  return c.json({
    success: true,
    data: jobs,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
});

// ── GET /api/sync/stats ───────────────────────────────────────

syncRouter.get("/stats", async (c) => {
  const [statusCounts, providerStats] = await Promise.all([
    prisma.syncJob.groupBy({
      by: ["status"],
      _count: { id: true },
    }),
    prisma.syncJobResult.groupBy({
      by: ["status"],
      _count: { id: true },
    }),
  ]);

  const totalJobs = statusCounts.reduce((acc, s) => acc + s._count.id, 0);
  const totalSynced = providerStats
    .filter((s) => s.status === "READY")
    .reduce((acc, s) => acc + s._count.id, 0);
  const totalFailed = providerStats
    .filter((s) => s.status === "FAILED")
    .reduce((acc, s) => acc + s._count.id, 0);

  return c.json({
    success: true,
    data: {
      totalJobs,
      totalSynced,
      totalFailed,
      jobsByStatus: Object.fromEntries(
        statusCounts.map((s) => [s.status, s._count.id])
      ),
      resultsByStatus: Object.fromEntries(
        providerStats.map((s) => [s.status, s._count.id])
      ),
    },
  });
});

// ── GET /api/sync/:jobId ──────────────────────────────────────

syncRouter.get("/:jobId", async (c) => {
  const jobId = c.req.param("jobId");

  const job = await prisma.syncJob.findUnique({
    where: { id: jobId },
    include: {
      syncResults: {
        include: { provider: { select: { id: true, name: true, type: true } } },
        orderBy: { createdAt: "asc" },
      },
      results: true,
      sourceProvider: { select: { id: true, name: true, type: true } },
    },
  });

  if (!job) return c.json({ success: false, error: "Job not found" }, 404);
  return c.json({ success: true, data: job });
});

// ── DELETE /api/sync/:jobId ───────────────────────────────────

syncRouter.delete("/:jobId", async (c) => {
  const jobId = c.req.param("jobId");

  const job = await prisma.syncJob.findUnique({
    where: { id: jobId },
    select: { id: true, status: true, bullJobId: true },
  });

  if (!job) return c.json({ success: false, error: "Job not found" }, 404);
  if (job.status === "READY" || job.status === "FAILED") {
    return c.json({ success: false, error: "Cannot cancel a completed job" }, 400);
  }

  // Attempt to remove from BullMQ queue
  if (job.bullJobId) {
    const queue = getSyncQueue();
    const bullJob = await queue.getJob(job.bullJobId);
    await bullJob?.remove().catch(() => {});
  }

  await prisma.syncJob.update({
    where: { id: jobId },
    data: { status: "CANCELLED" },
  });

  log.info({ jobId }, "Sync job cancelled");
  return c.json({ success: true });
});
