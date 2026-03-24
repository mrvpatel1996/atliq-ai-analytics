// ─── Folders API ─────────────────────────────────────────────
// Hierarchical folder management for organising videos

import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../db.js";
import { authMiddleware, requireRole } from "../auth/middleware.js";
import { createLogger } from "../utils/logger.js";
import type { AppEnv } from "../types/app.js";

const log = createLogger("api:folders");

const MAX_DEPTH = 10;

export const foldersRouter = new Hono<AppEnv>();

// ── Auth: all routes require auth ─────────────────────────────
foldersRouter.use("*", authMiddleware);

// ─── Helpers ─────────────────────────────────────────────────

type FolderNode = {
  id: string;
  name: string;
  description: string | null;
  parentId: string | null;
  path: string;
  depth: number;
  color: string | null;
  icon: string | null;
  isPrivate: boolean;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  children: FolderNode[];
  _count?: { videoMappings: number };
};

function buildTree(folders: Omit<FolderNode, "children">[]): FolderNode[] {
  const map = new Map<string, FolderNode>();
  const roots: FolderNode[] = [];

  for (const f of folders) {
    map.set(f.id, { ...f, children: [] });
  }

  for (const node of map.values()) {
    if (node.parentId && map.has(node.parentId)) {
      map.get(node.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

async function computePath(parentId: string | null, name: string): Promise<{ path: string; depth: number }> {
  if (!parentId) {
    return { path: `/${name}`, depth: 0 };
  }
  const parent = await prisma.folder.findUnique({ where: { id: parentId }, select: { path: true, depth: true } });
  if (!parent) throw new Error("Parent folder not found");
  return { path: `${parent.path}/${name}`, depth: parent.depth + 1 };
}

async function updateDescendantPaths(folderId: string, newBasePath: string, newDepth: number): Promise<void> {
  const children = await prisma.folder.findMany({ where: { parentId: folderId } });
  for (const child of children) {
    const childPath = `${newBasePath}/${child.name}`;
    const childDepth = newDepth + 1;
    await prisma.folder.update({ where: { id: child.id }, data: { path: childPath, depth: childDepth } });
    await updateDescendantPaths(child.id, childPath, childDepth);
  }
}

// ─── Schemas ─────────────────────────────────────────────────

const createFolderSchema = z.object({
  name: z.string().min(1).max(200),
  parentId: z.string().optional(),
  description: z.string().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  icon: z.string().max(50).optional(),
  isPrivate: z.boolean().optional(),
});

const updateFolderSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().nullable(),
  icon: z.string().max(50).optional().nullable(),
  isPrivate: z.boolean().optional(),
});

// ─── GET /api/folders/search ──────────────────────────────────
// Must be before /:id to avoid route conflict

foldersRouter.get("/search", async (c) => {
  const q = c.req.query("q") ?? "";
  if (!q) return c.json({ success: false, error: "q query param required" }, 400);

  const folders = await prisma.folder.findMany({
    where: {
      OR: [
        { name: { contains: q, mode: "insensitive" } },
        { path: { contains: q, mode: "insensitive" } },
      ],
    },
    include: { _count: { select: { videoMappings: true } } },
    orderBy: { path: "asc" },
    take: 50,
  });

  return c.json({ success: true, data: folders });
});

// ─── GET /api/folders ─────────────────────────────────────────
// Returns nested tree

foldersRouter.get("/", async (c) => {
  const folders = await prisma.folder.findMany({
    include: { _count: { select: { videoMappings: true } } },
    orderBy: { path: "asc" },
  });

  const tree = buildTree(folders as Omit<FolderNode, "children">[]);
  return c.json({ success: true, data: tree });
});

// ─── POST /api/folders ────────────────────────────────────────

foldersRouter.post("/", requireRole("OPERATOR"), async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = createFolderSchema.safeParse(body);
  if (!parsed.success) return c.json({ success: false, error: parsed.error.flatten() }, 400);

  const { name, parentId, description, color, icon, isPrivate } = parsed.data;

  let pathInfo: { path: string; depth: number };
  try {
    pathInfo = await computePath(parentId ?? null, name);
  } catch (err) {
    return c.json({ success: false, error: err instanceof Error ? err.message : "Invalid parent" }, 400);
  }

  if (pathInfo.depth >= MAX_DEPTH) {
    return c.json({ success: false, error: `Maximum folder depth of ${MAX_DEPTH} exceeded` }, 400);
  }

  // Check for duplicate name within same parent
  const existing = await prisma.folder.findFirst({
    where: { parentId: parentId ?? null, name },
  });
  if (existing) return c.json({ success: false, error: "A folder with this name already exists at this location" }, 409);

  const userId = c.get("userId");
  const folder = await prisma.folder.create({
    data: {
      name,
      description,
      parentId: parentId ?? null,
      path: pathInfo.path,
      depth: pathInfo.depth,
      color: color ?? null,
      icon: icon ?? null,
      isPrivate: isPrivate ?? false,
      createdBy: userId,
    },
  });

  log.info({ folderId: folder.id, path: folder.path }, "Folder created");
  return c.json({ success: true, data: folder }, 201);
});

// ─── GET /api/folders/:id ─────────────────────────────────────

foldersRouter.get("/:id", async (c) => {
  const id = c.req.param("id");

  const folder = await prisma.folder.findUnique({
    where: { id },
    include: {
      children: { include: { _count: { select: { videoMappings: true } } } },
      _count: { select: { videoMappings: true } },
    },
  });

  if (!folder) return c.json({ success: false, error: "Folder not found" }, 404);
  return c.json({ success: true, data: folder });
});

// ─── PUT /api/folders/:id ─────────────────────────────────────

foldersRouter.put("/:id", requireRole("OPERATOR"), async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  const parsed = updateFolderSchema.safeParse(body);
  if (!parsed.success) return c.json({ success: false, error: parsed.error.flatten() }, 400);

  const folder = await prisma.folder.findUnique({ where: { id } });
  if (!folder) return c.json({ success: false, error: "Folder not found" }, 404);

  const updateData: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) {
    updateData.name = parsed.data.name;
    // Recompute path when name changes
    const parentPath = folder.parentId
      ? (await prisma.folder.findUnique({ where: { id: folder.parentId }, select: { path: true } }))?.path ?? ""
      : "";
    const newPath = parentPath ? `${parentPath}/${parsed.data.name}` : `/${parsed.data.name}`;
    updateData.path = newPath;
  }
  if (parsed.data.description !== undefined) updateData.description = parsed.data.description;
  if (parsed.data.color !== undefined) updateData.color = parsed.data.color;
  if (parsed.data.icon !== undefined) updateData.icon = parsed.data.icon;
  if (parsed.data.isPrivate !== undefined) updateData.isPrivate = parsed.data.isPrivate;

  const updated = await prisma.folder.update({ where: { id }, data: updateData });

  // Cascade path updates to descendants if name changed
  if (updateData.path) {
    await updateDescendantPaths(id, updated.path, updated.depth);
  }

  return c.json({ success: true, data: updated });
});

// ─── DELETE /api/folders/:id ──────────────────────────────────

foldersRouter.delete("/:id", requireRole("OPERATOR"), async (c) => {
  const id = c.req.param("id");
  const folder = await prisma.folder.findUnique({ where: { id } });
  if (!folder) return c.json({ success: false, error: "Folder not found" }, 404);

  // Cascade deletes FolderVideo associations (onDelete: Cascade in schema)
  // Children folders will be orphaned unless we handle them
  await prisma.folder.delete({ where: { id } });

  log.info({ folderId: id }, "Folder deleted");
  return c.json({ success: true });
});

// ─── GET /api/folders/:id/videos ─────────────────────────────

foldersRouter.get("/:id/videos", async (c) => {
  const id = c.req.param("id");
  const page = Math.max(1, parseInt(c.req.query("page") ?? "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") ?? "50", 10)));

  const folder = await prisma.folder.findUnique({ where: { id } });
  if (!folder) return c.json({ success: false, error: "Folder not found" }, 404);

  const [mappings, total] = await Promise.all([
    prisma.folderVideo.findMany({
      where: { folderId: id },
      include: {
        providerVideo: {
          include: { provider: { select: { id: true, name: true, type: true } } },
        },
      },
      orderBy: { sortOrder: "asc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.folderVideo.count({ where: { folderId: id } }),
  ]);

  return c.json({
    success: true,
    data: mappings.map((m) => ({ ...m.providerVideo, sortOrder: m.sortOrder, notes: m.notes, addedAt: m.addedAt })),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
});

// ─── POST /api/folders/:id/videos ────────────────────────────

foldersRouter.post("/:id/videos", requireRole("OPERATOR"), async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null);

  const schema = z.object({ providerVideoIds: z.array(z.string()).min(1) });
  const parsed = schema.safeParse(body);
  if (!parsed.success) return c.json({ success: false, error: parsed.error.flatten() }, 400);

  const folder = await prisma.folder.findUnique({ where: { id } });
  if (!folder) return c.json({ success: false, error: "Folder not found" }, 404);

  const userId = c.get("userId");
  const results = await Promise.allSettled(
    parsed.data.providerVideoIds.map((providerVideoId) =>
      prisma.folderVideo.upsert({
        where: { folderId_providerVideoId: { folderId: id, providerVideoId } },
        create: { folderId: id, providerVideoId, addedBy: userId },
        update: {},
      })
    )
  );

  const added = results.filter((r) => r.status === "fulfilled").length;
  return c.json({ success: true, data: { added } });
});

// ─── DELETE /api/folders/:id/videos/:videoId ─────────────────

foldersRouter.delete("/:id/videos/:videoId", requireRole("OPERATOR"), async (c) => {
  const folderId = c.req.param("id");
  const providerVideoId = c.req.param("videoId");

  const mapping = await prisma.folderVideo.findUnique({
    where: { folderId_providerVideoId: { folderId, providerVideoId } },
  });
  if (!mapping) return c.json({ success: false, error: "Video not in folder" }, 404);

  await prisma.folderVideo.delete({ where: { folderId_providerVideoId: { folderId, providerVideoId } } });
  return c.json({ success: true });
});

// ─── PUT /api/folders/:id/move ────────────────────────────────

foldersRouter.put("/:id/move", requireRole("OPERATOR"), async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null);

  const schema = z.object({ newParentId: z.string().nullable() });
  const parsed = schema.safeParse(body);
  if (!parsed.success) return c.json({ success: false, error: parsed.error.flatten() }, 400);

  const folder = await prisma.folder.findUnique({ where: { id } });
  if (!folder) return c.json({ success: false, error: "Folder not found" }, 404);

  const { newParentId } = parsed.data;

  // Prevent moving folder into itself or its descendants
  if (newParentId === id) {
    return c.json({ success: false, error: "Cannot move folder into itself" }, 400);
  }

  let newPath: string;
  let newDepth: number;

  if (newParentId) {
    const newParent = await prisma.folder.findUnique({ where: { id: newParentId } });
    if (!newParent) return c.json({ success: false, error: "New parent folder not found" }, 404);
    if (newParent.path.startsWith(folder.path + "/")) {
      return c.json({ success: false, error: "Cannot move folder into its own descendant" }, 400);
    }
    newPath = `${newParent.path}/${folder.name}`;
    newDepth = newParent.depth + 1;
  } else {
    newPath = `/${folder.name}`;
    newDepth = 0;
  }

  if (newDepth >= MAX_DEPTH) {
    return c.json({ success: false, error: `Maximum folder depth of ${MAX_DEPTH} exceeded` }, 400);
  }

  const updated = await prisma.folder.update({
    where: { id },
    data: { parentId: newParentId, path: newPath, depth: newDepth },
  });

  await updateDescendantPaths(id, newPath, newDepth);

  return c.json({ success: true, data: updated });
});

// ─── POST /api/folders/:id/clone ─────────────────────────────

foldersRouter.post("/:id/clone", requireRole("OPERATOR"), async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  const schema = z.object({ newParentId: z.string().optional(), newName: z.string().min(1).optional() });
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) return c.json({ success: false, error: parsed.error.flatten() }, 400);

  const folder = await prisma.folder.findUnique({ where: { id } });
  if (!folder) return c.json({ success: false, error: "Folder not found" }, 404);

  const userId = c.get("userId");
  const newName = parsed.data.newName ?? `${folder.name} (copy)`;
  const newParentId = parsed.data.newParentId ?? folder.parentId ?? null;

  let pathInfo: { path: string; depth: number };
  try {
    pathInfo = await computePath(newParentId, newName);
  } catch {
    return c.json({ success: false, error: "Invalid parent folder" }, 400);
  }

  if (pathInfo.depth >= MAX_DEPTH) {
    return c.json({ success: false, error: `Maximum folder depth of ${MAX_DEPTH} exceeded` }, 400);
  }

  const cloned = await prisma.folder.create({
    data: {
      name: newName,
      description: folder.description,
      parentId: newParentId,
      path: pathInfo.path,
      depth: pathInfo.depth,
      color: folder.color,
      icon: folder.icon,
      isPrivate: folder.isPrivate,
      createdBy: userId,
    },
  });

  log.info({ sourceFolderId: id, clonedFolderId: cloned.id }, "Folder cloned");
  return c.json({ success: true, data: cloned }, 201);
});

// ─── GET /api/folders/:id/breadcrumb ─────────────────────────

foldersRouter.get("/:id/breadcrumb", async (c) => {
  const id = c.req.param("id");

  const folder = await prisma.folder.findUnique({ where: { id } });
  if (!folder) return c.json({ success: false, error: "Folder not found" }, 404);

  // Walk up the tree using path segments
  const segments = folder.path.split("/").filter(Boolean);
  const breadcrumb: Array<{ name: string; path: string }> = [];

  let currentPath = "";
  for (const segment of segments) {
    currentPath += `/${segment}`;
    const node = await prisma.folder.findFirst({
      where: { path: currentPath },
      select: { id: true, name: true, path: true },
    });
    if (node) breadcrumb.push(node);
  }

  return c.json({ success: true, data: breadcrumb });
});
