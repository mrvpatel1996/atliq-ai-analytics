// ─── Bulk Import Routes ──────────────────────────────────────
// POST /api/import/vimeo              - Start bulk Vimeo import
// GET  /api/import/vimeo/status       - Latest Vimeo import status
// POST /api/import/vimeo/preview      - Dry-run: count videos without importing
// GET  /api/import/:jobId             - Specific import job status
// POST /api/providers/:id/import      - Import all videos from any provider
// GET  /api/providers/:id/import/status - Current import status for provider

import { Hono } from "hono";
import { prisma } from "../db.js";
import { authMiddleware, requireRole } from "../auth/middleware.js";
import { decryptCredentials } from "../utils/crypto.js";
import { enqueueImportJob } from "../jobs/importJob.js";
import { createLogger } from "../utils/logger.js";
import type { VimeoCredentials } from "../types/index.js";
import type { AppEnv } from "../types/app.js";

const log = createLogger("api:import");

export const importRouter = new Hono<AppEnv>();

// All import routes require auth
importRouter.use("*", authMiddleware);

// ─── POST /api/import/vimeo ──────────────────────────────────
// Start a bulk import of all Vimeo videos for the first active Vimeo provider

importRouter.post("/import/vimeo", requireRole("OPERATOR"), async (c) => {
  const provider = await prisma.provider.findFirst({
    where: { type: "VIMEO", isActive: true },
    orderBy: { createdAt: "asc" },
  });

  if (!provider) {
    return c.json({ success: false, error: "No active Vimeo provider configured" }, 404);
  }

  const credentials = decryptCredentials<VimeoCredentials>(provider.credentials);

  const importJob = await prisma.importJob.create({
    data: {
      providerId: provider.id,
      status: "PENDING",
    },
  });

  await enqueueImportJob({
    importJobId: importJob.id,
    providerId: provider.id,
    providerType: "VIMEO",
    credentials: credentials as unknown as Record<string, unknown>,
  });

  log.info({ importJobId: importJob.id, providerId: provider.id }, "Vimeo bulk import started");

  return c.json({ success: true, data: { jobId: importJob.id, status: importJob.status } }, 202);
});

// ─── GET /api/import/vimeo/status ────────────────────────────
// Latest Vimeo import job status

importRouter.get("/import/vimeo/status", requireRole("VIEWER"), async (c) => {
  const provider = await prisma.provider.findFirst({
    where: { type: "VIMEO", isActive: true },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });

  if (!provider) {
    return c.json({ success: false, error: "No active Vimeo provider configured" }, 404);
  }

  const job = await prisma.importJob.findFirst({
    where: { providerId: provider.id },
    orderBy: { startedAt: "desc" },
  });

  if (!job) {
    return c.json({ success: true, data: null });
  }

  return c.json({ success: true, data: job });
});

// ─── POST /api/import/vimeo/preview ──────────────────────────
// Dry-run: count total videos without importing

importRouter.post("/import/vimeo/preview", requireRole("OPERATOR"), async (c) => {
  const provider = await prisma.provider.findFirst({
    where: { type: "VIMEO", isActive: true },
    orderBy: { createdAt: "asc" },
  });

  if (!provider) {
    return c.json({ success: false, error: "No active Vimeo provider configured" }, 404);
  }

  const credentials = decryptCredentials<VimeoCredentials>(provider.credentials);

  // Quick first-page call to get total count
  const accessToken = credentials.accessToken;
  const res = await fetch(
    "https://api.vimeo.com/me/videos?per_page=1&fields=uri",
    {
      headers: {
        Authorization: `bearer ${accessToken}`,
        Accept: "application/vnd.vimeo.*+json;version=3.4",
      },
    }
  );

  if (!res.ok) {
    return c.json({ success: false, error: `Vimeo API error: ${res.status}` }, 502);
  }

  const data = await res.json() as { total: number };

  // Also count already-imported videos
  const alreadyImported = await prisma.providerVideo.count({
    where: { providerId: provider.id },
  });

  return c.json({
    success: true,
    data: {
      providerId: provider.id,
      totalOnVimeo: data.total,
      alreadyImported,
      toImport: data.total - alreadyImported,
    },
  });
});

// ─── GET /api/import/:jobId ───────────────────────────────────

importRouter.get("/import/:jobId", requireRole("VIEWER"), async (c) => {
  const jobId = c.req.param("jobId");
  const job = await prisma.importJob.findUnique({ where: { id: jobId } });
  if (!job) return c.json({ success: false, error: "Import job not found" }, 404);
  return c.json({ success: true, data: job });
});

// ─── POST /api/providers/:id/import ─────────────────────────

importRouter.post("/providers/:id/import", requireRole("OPERATOR"), async (c) => {
  const id = c.req.param("id");

  const provider = await prisma.provider.findUnique({ where: { id } });
  if (!provider) return c.json({ success: false, error: "Provider not found" }, 404);
  if (!provider.isActive) return c.json({ success: false, error: "Provider is inactive" }, 400);

  if (!["VIMEO"].includes(provider.type)) {
    return c.json({ success: false, error: `Bulk import not supported for provider type: ${provider.type}` }, 400);
  }

  const credentials = decryptCredentials(provider.credentials);

  const importJob = await prisma.importJob.create({
    data: {
      providerId: provider.id,
      status: "PENDING",
    },
  });

  await enqueueImportJob({
    importJobId: importJob.id,
    providerId: provider.id,
    providerType: provider.type,
    credentials: credentials as Record<string, unknown>,
  });

  log.info({ importJobId: importJob.id, providerId: provider.id, type: provider.type }, "Provider bulk import started");

  return c.json({
    success: true,
    data: {
      jobId: importJob.id,
      providerId: provider.id,
      providerType: provider.type,
      status: importJob.status,
    },
  }, 202);
});

// ─── GET /api/providers/:id/import/status ────────────────────

importRouter.get("/providers/:id/import/status", requireRole("VIEWER"), async (c) => {
  const id = c.req.param("id");

  const provider = await prisma.provider.findUnique({
    where: { id },
    select: { id: true, name: true, type: true },
  });
  if (!provider) return c.json({ success: false, error: "Provider not found" }, 404);

  const [latestJob, totalImported] = await Promise.all([
    prisma.importJob.findFirst({
      where: { providerId: id },
      orderBy: { startedAt: "desc" },
    }),
    prisma.providerVideo.count({ where: { providerId: id } }),
  ]);

  return c.json({
    success: true,
    data: {
      provider: { id: provider.id, name: provider.name, type: provider.type },
      totalImported,
      latestJob,
    },
  });
});
