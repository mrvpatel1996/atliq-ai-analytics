// ─── Main Router ─────────────────────────────────────────────
// Wires all sub-routers together and adds health + legacy sync endpoints

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger as honoLogger } from "hono/logger";
import { prisma } from "../db.js";
import { s3Service } from "../services/s3.js";
import { vimeoService } from "../services/vimeo.js";
import { gumletService } from "../services/gumlet.js";
import { cloudflareService } from "../services/cloudflare.js";
import { redisHealthCheck, getSyncQueue } from "../jobs/queue.js";
import { enqueueSyncJob } from "../jobs/queue.js";
import { createLogger } from "../utils/logger.js";

import { providersRouter } from "./providers.js";
import { videosRouter } from "./videos.js";
import { syncRouter } from "./sync.js";
import { webhooksRouter } from "./webhooks.js";
import { authRouter, usersRouter } from "./auth.js";
import { importRouter } from "./import.js";

const log = createLogger("api:routes");

export function createApp(): Hono {
  const app = new Hono();

  // ── Middleware ─────────────────────────────────────────────
  app.use("*", cors());
  app.use("*", honoLogger());

  // ── Health ─────────────────────────────────────────────────
  app.get("/health", async (c) => {
    const [db, redis, s3, vimeo, gumlet, cloudflare] = await Promise.allSettled([
      prisma.$queryRaw`SELECT 1`.then(() => ({ status: "ok" as const, latencyMs: 0 })),
      redisHealthCheck(),
      s3Service.healthCheck(),
      vimeoService.healthCheck(),
      gumletService.healthCheck(),
      cloudflareService.healthCheck(),
    ]);

    const resolve = <T extends { status: string }>(
      r: PromiseSettledResult<T>
    ) =>
      r.status === "fulfilled"
        ? r.value
        : { status: "error" as const, error: String((r as PromiseRejectedResult).reason) };

    const dbResult = resolve(db) as { status: "ok" | "error"; latencyMs?: number; error?: string };
    const redisResult = resolve(redis) as { status: "ok" | "error"; latencyMs?: number; error?: string };

    const allOk =
      dbResult.status === "ok" && redisResult.status === "ok";

    return c.json(
      {
        status: allOk ? "ok" : "degraded",
        uptime: process.uptime(),
        database: dbResult,
        redis: redisResult,
        platforms: {
          s3: resolve(s3),
          vimeo: resolve(vimeo),
          gumlet: resolve(gumlet),
          cloudflare: resolve(cloudflare),
        },
      },
      allOk ? 200 : 503
    );
  });

  // ── Legacy sync endpoint (backward compatible) ─────────────
  app.post("/api/sync", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body?.sourceKey) {
      return c.json({ success: false, error: "sourceKey is required" }, 400);
    }

    const dbJob = await prisma.syncJob.create({
      data: {
        status: "PENDING",
        sourceKey: body.sourceKey,
        sourceBucket: body.sourceBucket,
        title: body.title,
        description: body.description,
        tags: body.tags ?? [],
        destinations: body.destinations ?? ["VIMEO", "GUMLET", "CLOUDFLARE"],
      },
    });

    const bullJob = await enqueueSyncJob({
      jobId: dbJob.id,
      sourceKey: body.sourceKey,
      sourceBucket: body.sourceBucket,
      title: body.title,
      description: body.description,
      tags: body.tags,
      destinations: body.destinations,
      platformOptions: body.platformOptions,
    });

    await prisma.syncJob.update({
      where: { id: dbJob.id },
      data: { bullJobId: bullJob.id ?? undefined },
    });

    log.info({ jobId: dbJob.id }, "Legacy sync job enqueued");
    return c.json({ success: true, data: { jobId: dbJob.id } }, 202);
  });

  // ── Queue stats ────────────────────────────────────────────
  app.get("/api/queue/stats", async (c) => {
    const queue = getSyncQueue();
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getCompletedCount(),
      queue.getFailedCount(),
      queue.getDelayedCount(),
    ]);
    return c.json({ success: true, data: { waiting, active, completed, failed, delayed } });
  });

  // ── Sub-routers ────────────────────────────────────────────
  // Auth (no global auth middleware — individual routes handle it)
  app.route("/api/auth", authRouter);
  app.route("/api/users", usersRouter);

  // Import (auth applied inside importRouter)
  app.route("/api", importRouter);

  // Protected resource routes
  app.route("/api/providers", providersRouter);
  app.route("/api/videos", videosRouter);
  app.route("/api/sync", syncRouter);
  app.route("/api/webhooks", webhooksRouter);

  // ── 404 ────────────────────────────────────────────────────
  app.notFound((c) => c.json({ success: false, error: "Not found" }, 404));

  // ── Global error handler ───────────────────────────────────
  app.onError((err, c) => {
    log.error({ err, url: c.req.url }, "Unhandled error");
    return c.json({ success: false, error: err.message }, 500);
  });

  return app;
}
