// ─── Video Groups API ─────────────────────────────────────────
// Cross-provider video mapping — link the same video across multiple platforms

import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../db.js";
import { authMiddleware, requireRole } from "../auth/middleware.js";
import { createLogger } from "../utils/logger.js";
import { getSyncQueue } from "../jobs/queue.js";
import type { AppEnv } from "../types/app.js";

const log = createLogger("api:video-groups");

export const videoGroupsRouter = new Hono<AppEnv>();

// ── Auth: all routes require auth ─────────────────────────────
videoGroupsRouter.use("*", authMiddleware);

// ─── Schemas ─────────────────────────────────────────────────

const createGroupSchema = z.object({
  name: z.string().min(1).max(300),
  description: z.string().optional(),
  providerVideoIds: z.array(z.string()).optional(),
  primaryVideoId: z.string().optional(),
  tags: z.array(z.string()).optional(),
  thumbnailUrl: z.string().url().optional(),
});

const updateGroupSchema = z.object({
  name: z.string().min(1).max(300).optional(),
  description: z.string().optional().nullable(),
  tags: z.array(z.string()).optional(),
  thumbnailUrl: z.string().url().optional().nullable(),
  status: z.enum(["ACTIVE", "PENDING_SYNC", "SYNC_FAILED", "ARCHIVED"]).optional(),
  metadata: z.record(z.unknown()).optional().nullable(),
});

// ─── GET /api/video-groups/suggestions ───────────────────────
// Must be before /:id routes

videoGroupsRouter.get("/suggestions", async (c) => {
  // Find videos with the same title across different providers
  const videos = await prisma.providerVideo.findMany({
    where: { title: { not: null } },
    include: { provider: { select: { id: true, name: true, type: true } } },
    orderBy: { title: "asc" },
  });

  // Group by normalised title
  const byTitle = new Map<string, typeof videos>();
  for (const v of videos) {
    const key = (v.title ?? "").trim().toLowerCase();
    if (!key) continue;
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key)!.push(v);
  }

  // Only suggest groups where multiple providers have the same title
  const suggestions: Array<{ title: string; videos: typeof videos }> = [];
  for (const [title, group] of byTitle) {
    const providerIds = new Set(group.map((v) => v.providerId));
    if (providerIds.size > 1) {
      suggestions.push({ title, videos: group });
    }
  }

  return c.json({ success: true, data: suggestions });
});

// ─── POST /api/video-groups/auto-group ───────────────────────

videoGroupsRouter.post("/auto-group", requireRole("OPERATOR"), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const threshold = parseFloat(body?.threshold ?? "0.8");

  const videos = await prisma.providerVideo.findMany({
    where: { title: { not: null } },
    include: { provider: { select: { id: true, name: true, type: true } } },
  });

  // Group by normalised title (exact match at threshold=1.0; simple prefix for lower values)
  const byTitle = new Map<string, typeof videos>();
  for (const v of videos) {
    const key = (v.title ?? "").trim().toLowerCase();
    if (!key) continue;
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key)!.push(v);
  }

  const userId = c.get("userId");
  let created = 0;
  let skipped = 0;

  for (const [title, group] of byTitle) {
    const providerIds = new Set(group.map((v) => v.providerId));
    if (providerIds.size <= 1) { skipped++; continue; }

    // Skip if a group with this name already exists
    const existing = await prisma.videoGroup.findFirst({ where: { name: { equals: title, mode: "insensitive" } } });
    if (existing) { skipped++; continue; }

    const videoGroup = await prisma.videoGroup.create({
      data: {
        name: group[0].title!,
        duration: group[0].duration ? Math.round(group[0].duration) : null,
        thumbnailUrl: group[0].thumbnailUrl ?? null,
        createdBy: userId,
        videos: {
          create: group.map((v, i) => ({ providerVideoId: v.id, isPrimary: i === 0 })),
        },
      },
    });

    await prisma.videoGroup.update({
      where: { id: videoGroup.id },
      data: { primaryVideoId: group[0].id },
    });

    created++;
  }

  log.info({ created, skipped }, "Auto-group completed");
  return c.json({ success: true, data: { created, skipped } });
});

// ─── GET /api/video-groups ────────────────────────────────────

videoGroupsRouter.get("/", async (c) => {
  const page = Math.max(1, parseInt(c.req.query("page") ?? "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") ?? "50", 10)));
  const status = c.req.query("status");

  const where: Record<string, unknown> = {};
  if (status) where.status = status;

  const [groups, total] = await Promise.all([
    prisma.videoGroup.findMany({
      where,
      include: { _count: { select: { videos: true } } },
      orderBy: { updatedAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.videoGroup.count({ where }),
  ]);

  return c.json({
    success: true,
    data: groups,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
});

// ─── POST /api/video-groups ───────────────────────────────────

videoGroupsRouter.post("/", requireRole("OPERATOR"), async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = createGroupSchema.safeParse(body);
  if (!parsed.success) return c.json({ success: false, error: parsed.error.flatten() }, 400);

  const { name, description, providerVideoIds, primaryVideoId, tags, thumbnailUrl } = parsed.data;
  const userId = c.get("userId");

  const group = await prisma.videoGroup.create({
    data: {
      name,
      description: description ?? null,
      tags: tags ?? [],
      thumbnailUrl: thumbnailUrl ?? null,
      primaryVideoId: primaryVideoId ?? null,
      createdBy: userId,
      videos: providerVideoIds?.length
        ? {
            create: providerVideoIds.map((pvId) => ({
              providerVideoId: pvId,
              isPrimary: pvId === primaryVideoId,
            })),
          }
        : undefined,
    },
    include: { videos: true },
  });

  log.info({ groupId: group.id }, "VideoGroup created");
  return c.json({ success: true, data: group }, 201);
});

// ─── GET /api/video-groups/:id ────────────────────────────────

videoGroupsRouter.get("/:id", async (c) => {
  const id = c.req.param("id");

  const group = await prisma.videoGroup.findUnique({
    where: { id },
    include: {
      videos: {
        include: {
          providerVideo: {
            include: { provider: { select: { id: true, name: true, type: true } } },
          },
        },
      },
      _count: { select: { videos: true, syncHistory: true } },
    },
  });

  if (!group) return c.json({ success: false, error: "Video group not found" }, 404);
  return c.json({ success: true, data: group });
});

// ─── PUT /api/video-groups/:id ────────────────────────────────

videoGroupsRouter.put("/:id", requireRole("OPERATOR"), async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  const parsed = updateGroupSchema.safeParse(body);
  if (!parsed.success) return c.json({ success: false, error: parsed.error.flatten() }, 400);

  const group = await prisma.videoGroup.findUnique({ where: { id } });
  if (!group) return c.json({ success: false, error: "Video group not found" }, 404);

  const updateData: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) updateData.name = parsed.data.name;
  if (parsed.data.description !== undefined) updateData.description = parsed.data.description;
  if (parsed.data.tags !== undefined) updateData.tags = parsed.data.tags;
  if (parsed.data.thumbnailUrl !== undefined) updateData.thumbnailUrl = parsed.data.thumbnailUrl;
  if (parsed.data.status !== undefined) updateData.status = parsed.data.status;
  if (parsed.data.metadata !== undefined) updateData.metadata = parsed.data.metadata;

  const updated = await prisma.videoGroup.update({ where: { id }, data: updateData });
  return c.json({ success: true, data: updated });
});

// ─── DELETE /api/video-groups/:id ────────────────────────────

videoGroupsRouter.delete("/:id", requireRole("OPERATOR"), async (c) => {
  const id = c.req.param("id");
  const group = await prisma.videoGroup.findUnique({ where: { id } });
  if (!group) return c.json({ success: false, error: "Video group not found" }, 404);

  // Members (VideoGroupMember) are cascade-deleted; actual videos are untouched
  await prisma.videoGroup.delete({ where: { id } });
  log.info({ groupId: id }, "VideoGroup deleted");
  return c.json({ success: true });
});

// ─── POST /api/video-groups/:id/members ──────────────────────

videoGroupsRouter.post("/:id/members", requireRole("OPERATOR"), async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null);

  const schema = z.object({
    providerVideoIds: z.array(z.string()).min(1),
    isPrimary: z.boolean().optional(),
  });
  const parsed = schema.safeParse(body);
  if (!parsed.success) return c.json({ success: false, error: parsed.error.flatten() }, 400);

  const group = await prisma.videoGroup.findUnique({ where: { id } });
  if (!group) return c.json({ success: false, error: "Video group not found" }, 404);

  const results = await Promise.allSettled(
    parsed.data.providerVideoIds.map((pvId) =>
      prisma.videoGroupMember.upsert({
        where: { groupId_providerVideoId: { groupId: id, providerVideoId: pvId } },
        create: { groupId: id, providerVideoId: pvId, isPrimary: parsed.data.isPrimary ?? false },
        update: {},
      })
    )
  );

  const added = results.filter((r) => r.status === "fulfilled").length;
  return c.json({ success: true, data: { added } });
});

// ─── DELETE /api/video-groups/:id/members/:memberId ──────────

videoGroupsRouter.delete("/:id/members/:memberId", requireRole("OPERATOR"), async (c) => {
  const groupId = c.req.param("id");
  const memberId = c.req.param("memberId");

  const member = await prisma.videoGroupMember.findUnique({
    where: { id: memberId },
  });
  if (!member || member.groupId !== groupId) {
    return c.json({ success: false, error: "Member not found in group" }, 404);
  }

  await prisma.videoGroupMember.delete({ where: { id: memberId } });
  return c.json({ success: true });
});

// ─── PUT /api/video-groups/:id/primary ───────────────────────

videoGroupsRouter.put("/:id/primary", requireRole("OPERATOR"), async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null);

  const schema = z.object({ providerVideoId: z.string() });
  const parsed = schema.safeParse(body);
  if (!parsed.success) return c.json({ success: false, error: parsed.error.flatten() }, 400);

  const group = await prisma.videoGroup.findUnique({ where: { id } });
  if (!group) return c.json({ success: false, error: "Video group not found" }, 404);

  const member = await prisma.videoGroupMember.findUnique({
    where: { groupId_providerVideoId: { groupId: id, providerVideoId: parsed.data.providerVideoId } },
  });
  if (!member) return c.json({ success: false, error: "Video is not a member of this group" }, 404);

  // Clear existing primary, set new one
  await prisma.$transaction([
    prisma.videoGroupMember.updateMany({ where: { groupId: id }, data: { isPrimary: false } }),
    prisma.videoGroupMember.update({ where: { id: member.id }, data: { isPrimary: true } }),
    prisma.videoGroup.update({ where: { id }, data: { primaryVideoId: parsed.data.providerVideoId } }),
  ]);

  return c.json({ success: true });
});

// ─── POST /api/video-groups/:id/sync-metadata ────────────────

videoGroupsRouter.post("/:id/sync-metadata", requireRole("OPERATOR"), async (c) => {
  const id = c.req.param("id");

  const group = await prisma.videoGroup.findUnique({
    where: { id },
    include: { videos: true },
  });
  if (!group) return c.json({ success: false, error: "Video group not found" }, 404);
  if (!group.primaryVideoId) return c.json({ success: false, error: "Group has no primary video set" }, 400);
  if (group.videos.length < 2) return c.json({ success: false, error: "Group needs at least 2 members to sync" }, 400);

  const userId = c.get("userId");

  // Create sync record
  const syncRecord = await prisma.videoGroupSync.create({
    data: {
      groupId: id,
      action: "sync_metadata",
      status: "PENDING",
      triggeredBy: userId,
    },
  });

  // Enqueue the job
  const queue = getSyncQueue();
  await queue.add("group-sync", {
    groupId: id,
    syncId: syncRecord.id,
    action: "sync_metadata",
    triggeredBy: userId,
  });

  log.info({ groupId: id, syncId: syncRecord.id }, "Group metadata sync enqueued");
  return c.json({ success: true, data: { syncId: syncRecord.id } }, 202);
});

// ─── GET /api/video-groups/:id/sync-history ──────────────────

videoGroupsRouter.get("/:id/sync-history", async (c) => {
  const id = c.req.param("id");
  const page = Math.max(1, parseInt(c.req.query("page") ?? "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") ?? "20", 10)));

  const group = await prisma.videoGroup.findUnique({ where: { id } });
  if (!group) return c.json({ success: false, error: "Video group not found" }, 404);

  const [history, total] = await Promise.all([
    prisma.videoGroupSync.findMany({
      where: { groupId: id },
      orderBy: { startedAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.videoGroupSync.count({ where: { groupId: id } }),
  ]);

  return c.json({
    success: true,
    data: history,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
});
