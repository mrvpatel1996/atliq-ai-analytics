// ─── Providers API ───────────────────────────────────────────
// CRUD + test connectivity + pull videos from provider

import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../db.js";
import { encryptCredentials } from "../utils/crypto.js";
import { createProviderAdapter } from "../providers/index.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("api:providers");

const providerTypeSchema = z.enum(["S3", "VIMEO", "GUMLET", "CLOUDFLARE"]);

const createProviderSchema = z.object({
  name: z.string().min(1).max(120),
  type: providerTypeSchema,
  credentials: z.record(z.unknown()),
});

const updateProviderSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  credentials: z.record(z.unknown()).optional(),
  isActive: z.boolean().optional(),
});

export const providersRouter = new Hono();

// ── POST /api/providers ───────────────────────────────────────

providersRouter.post("/", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = createProviderSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ success: false, error: parsed.error.flatten() }, 400);
  }

  const { name, type, credentials } = parsed.data;
  const encrypted = encryptCredentials(credentials as Record<string, unknown>);

  const provider = await prisma.provider.create({
    data: { name, type, credentials: encrypted },
    select: { id: true, name: true, type: true, isActive: true, createdAt: true },
  });

  log.info({ providerId: provider.id, type, name }, "Provider created");
  return c.json({ success: true, data: provider }, 201);
});

// ── GET /api/providers ────────────────────────────────────────

providersRouter.get("/", async (c) => {
  const providers = await prisma.provider.findMany({
    select: {
      id: true,
      name: true,
      type: true,
      isActive: true,
      lastSyncedAt: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { videos: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return c.json({ success: true, data: providers });
});

// ── GET /api/providers/:id ────────────────────────────────────

providersRouter.get("/:id", async (c) => {
  const id = c.req.param("id");
  const provider = await prisma.provider.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      type: true,
      isActive: true,
      lastSyncedAt: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { videos: true } },
    },
  });

  if (!provider) return c.json({ success: false, error: "Provider not found" }, 404);
  return c.json({ success: true, data: provider });
});

// ── PUT /api/providers/:id ────────────────────────────────────

providersRouter.put("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  const parsed = updateProviderSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ success: false, error: parsed.error.flatten() }, 400);
  }

  const existing = await prisma.provider.findUnique({ where: { id } });
  if (!existing) return c.json({ success: false, error: "Provider not found" }, 404);

  const updateData: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) updateData.name = parsed.data.name;
  if (parsed.data.isActive !== undefined) updateData.isActive = parsed.data.isActive;
  if (parsed.data.credentials !== undefined) {
    updateData.credentials = encryptCredentials(parsed.data.credentials as Record<string, unknown>);
  }

  const updated = await prisma.provider.update({
    where: { id },
    data: updateData,
    select: { id: true, name: true, type: true, isActive: true, updatedAt: true },
  });

  return c.json({ success: true, data: updated });
});

// ── DELETE /api/providers/:id ─────────────────────────────────

providersRouter.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await prisma.provider.findUnique({ where: { id } });
  if (!existing) return c.json({ success: false, error: "Provider not found" }, 404);

  await prisma.provider.delete({ where: { id } });
  log.info({ providerId: id }, "Provider deleted");
  return c.json({ success: true });
});

// ── POST /api/providers/:id/test ─────────────────────────────

providersRouter.post("/:id/test", async (c) => {
  const id = c.req.param("id");
  const provider = await prisma.provider.findUnique({ where: { id } });
  if (!provider) return c.json({ success: false, error: "Provider not found" }, 404);

  try {
    const adapter = createProviderAdapter(provider);
    const result = await adapter.testConnection();
    return c.json({ success: true, data: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ success: false, data: { success: false, error: message } });
  }
});

// ── POST /api/providers/:id/sync-videos ──────────────────────
// Pull all videos from this provider into the ProviderVideo table

providersRouter.post("/:id/sync-videos", async (c) => {
  const id = c.req.param("id");
  const provider = await prisma.provider.findUnique({ where: { id } });
  if (!provider) return c.json({ success: false, error: "Provider not found" }, 404);

  try {
    const adapter = createProviderAdapter(provider);
    const videos = await adapter.listAllVideos();

    let upserted = 0;
    for (const v of videos) {
      await prisma.providerVideo.upsert({
        where: { providerId_externalId: { providerId: id, externalId: v.externalId } },
        create: {
          providerId: id,
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
      where: { id },
      data: { lastSyncedAt: new Date() },
    });

    log.info({ providerId: id, upserted }, "Provider videos synced");
    return c.json({ success: true, data: { synced: upserted } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ providerId: id, err }, "Failed to sync provider videos");
    return c.json({ success: false, error: message }, 500);
  }
});

// ── GET /api/providers/:id/videos ────────────────────────────

providersRouter.get("/:id/videos", async (c) => {
  const id = c.req.param("id");
  const provider = await prisma.provider.findUnique({ where: { id } });
  if (!provider) return c.json({ success: false, error: "Provider not found" }, 404);

  const videos = await prisma.providerVideo.findMany({
    where: { providerId: id },
    orderBy: { updatedAt: "desc" },
  });

  return c.json({ success: true, data: videos });
});

// ── POST /api/providers/:id/videos/refresh ────────────────────
// Re-fetch video data from the platform API and update DB

providersRouter.post("/:id/videos/refresh", async (c) => {
  const id = c.req.param("id");
  const provider = await prisma.provider.findUnique({ where: { id } });
  if (!provider) return c.json({ success: false, error: "Provider not found" }, 404);

  // Same as sync-videos — fetch and upsert
  try {
    const adapter = createProviderAdapter(provider);
    const videos = await adapter.listAllVideos();

    let updated = 0;
    for (const v of videos) {
      await prisma.providerVideo.upsert({
        where: { providerId_externalId: { providerId: id, externalId: v.externalId } },
        create: {
          providerId: id,
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
      updated++;
    }

    await prisma.provider.update({
      where: { id },
      data: { lastSyncedAt: new Date() },
    });

    return c.json({ success: true, data: { updated } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ success: false, error: message }, 500);
  }
});
