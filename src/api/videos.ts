// ─── Videos API ──────────────────────────────────────────────
// List and query videos across all providers

import { Hono } from "hono";
import { prisma } from "../db.js";

export const videosRouter = new Hono();

// ── GET /api/videos ───────────────────────────────────────────
// List all videos, optionally filtered

videosRouter.get("/", async (c) => {
  const providerId = c.req.query("providerId");
  const status = c.req.query("status");
  const search = c.req.query("search");
  const page = Math.max(1, parseInt(c.req.query("page") ?? "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") ?? "50", 10)));

  const where: Record<string, unknown> = {};
  if (providerId) where.providerId = providerId;
  if (status) where.status = status;
  if (search) {
    where.OR = [
      { title: { contains: search, mode: "insensitive" } },
      { description: { contains: search, mode: "insensitive" } },
    ];
  }

  const [videos, total] = await Promise.all([
    prisma.providerVideo.findMany({
      where,
      include: { provider: { select: { id: true, name: true, type: true } } },
      orderBy: { updatedAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.providerVideo.count({ where }),
  ]);

  return c.json({
    success: true,
    data: videos,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
});

// ── GET /api/videos/:id ───────────────────────────────────────

videosRouter.get("/:id", async (c) => {
  const id = c.req.param("id");

  const video = await prisma.providerVideo.findUnique({
    where: { id },
    include: { provider: { select: { id: true, name: true, type: true } } },
  });

  if (!video) return c.json({ success: false, error: "Video not found" }, 404);

  // Find all copies of this video (same title, across providers) — best effort match
  const copies = await prisma.providerVideo.findMany({
    where: { title: video.title ?? undefined, NOT: { id } },
    include: { provider: { select: { id: true, name: true, type: true } } },
  });

  return c.json({ success: true, data: { ...video, copies } });
});
