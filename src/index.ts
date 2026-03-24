// ─── Video Sync Service — Entry Point ─────────────────────────
// Starts the Hono HTTP server + BullMQ workers + scheduled refresh

import { createApp } from "./api/routes.js";
import { startSyncWorker, stopSyncWorker } from "./jobs/syncJob.js";
import { startRefreshWorker, stopRefreshWorker, enqueueAllProvidersRefresh } from "./jobs/refreshJob.js";
import { startImportWorker, stopImportWorker } from "./jobs/importJob.js";
import { closeQueues } from "./jobs/queue.js";
import { prisma } from "./db.js";
import { config } from "./utils/config.js";
import { createLogger } from "./utils/logger.js";

const log = createLogger("server");

// ─── Boot ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  log.info({ env: config.NODE_ENV }, "Starting Video Sync Service");

  // Verify DB connection
  await prisma.$connect();
  log.info("Database connected");

  // Start HTTP server
  const app = createApp();
  const server = Bun.serve({
    port: config.PORT,
    fetch: app.fetch,
  });

  log.info({ port: config.PORT }, "HTTP server listening");

  // Start BullMQ workers
  startSyncWorker();
  startRefreshWorker();
  startImportWorker();
  log.info("Workers started");

  // Schedule periodic provider refresh (every 6 hours)
  const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;

  if (config.NODE_ENV !== "test") {
    // Initial refresh on startup (non-blocking)
    enqueueAllProvidersRefresh().catch((err) =>
      log.warn({ err }, "Initial provider refresh failed to enqueue")
    );

    refreshTimer = setInterval(async () => {
      log.info("Scheduling periodic provider refresh");
      await enqueueAllProvidersRefresh().catch((err) =>
        log.error({ err }, "Periodic provider refresh enqueue failed")
      );
    }, REFRESH_INTERVAL_MS);
  }

  log.info("Video Sync Service ready");

  // ── Graceful shutdown ──────────────────────────────────────
  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, "Shutting down...");

    if (refreshTimer) clearInterval(refreshTimer);
    server.stop();

    await Promise.allSettled([stopSyncWorker(), stopRefreshWorker(), stopImportWorker()]);
    await closeQueues();
    await prisma.$disconnect();

    log.info("Shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", () => { shutdown("SIGINT").catch(() => process.exit(1)); });
  process.on("SIGTERM", () => { shutdown("SIGTERM").catch(() => process.exit(1)); });

  process.on("uncaughtException", (err) => {
    log.fatal({ err }, "Uncaught exception");
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    log.fatal({ reason }, "Unhandled promise rejection");
    process.exit(1);
  });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
