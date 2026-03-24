// ─── Auth + User Management Routes ──────────────────────────
// POST /api/auth/login, register, me, refresh, logout
// GET/POST/PUT/DELETE /api/users

import { Hono } from "hono";
import { SignJWT } from "jose";
import * as bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { prisma } from "../db.js";
import { config } from "../utils/config.js";
import { authMiddleware, blacklistToken, requireRole, verifyToken } from "../auth/middleware.js";
import { createLogger } from "../utils/logger.js";
import type { AppEnv } from "../types/app.js";

const log = createLogger("api:auth");

export const authRouter = new Hono<AppEnv>();
export const usersRouter = new Hono<AppEnv>();

// ─── JWT helpers ─────────────────────────────────────────────

function getJwtSecret(): Uint8Array {
  return new TextEncoder().encode(config.JWT_SECRET);
}

async function signToken(userId: string, role: string): Promise<{ token: string; jti: string }> {
  const jti = randomUUID();
  const token = await new SignJWT({ role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(config.JWT_EXPIRES_IN as `${number}${"d" | "h" | "m" | "s"}`)
    .sign(getJwtSecret());
  return { token, jti };
}

// ─── Auth Routes ─────────────────────────────────────────────

// POST /api/auth/login
authRouter.post("/login", async (c) => {
  const body = await c.req.json().catch(() => null) as { email?: string; password?: string } | null;
  if (!body?.email || !body?.password) {
    return c.json({ success: false, error: "email and password are required" }, 400);
  }

  const user = await prisma.user.findUnique({ where: { email: body.email } });
  if (!user || !user.isActive) {
    return c.json({ success: false, error: "Invalid credentials" }, 401);
  }

  const valid = await bcrypt.compare(body.password, user.passwordHash);
  if (!valid) {
    return c.json({ success: false, error: "Invalid credentials" }, 401);
  }

  const { token } = await signToken(user.id, user.role);

  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });

  log.info({ userId: user.id, role: user.role }, "User logged in");

  return c.json({
    success: true,
    data: {
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    },
  });
});

// POST /api/auth/register
authRouter.post("/register", async (c) => {
  const body = await c.req.json().catch(() => null) as {
    email?: string;
    password?: string;
    name?: string;
    role?: string;
  } | null;

  if (!body?.email || !body?.password || !body?.name) {
    return c.json({ success: false, error: "email, password, and name are required" }, 400);
  }

  // First user auto-gets SUPER_ADMIN; subsequent registrations require SUPER_ADMIN auth
  const userCount = await prisma.user.count();
  const isFirstUser = userCount === 0;

  if (!isFirstUser) {
    // Require SUPER_ADMIN auth for registrations after the first user
    const authHeader = c.req.header("authorization");
    const apiKey = c.req.header("x-api-key");
    let callerRole: string | null = null;

    if (apiKey) {
      const caller = await prisma.user.findUnique({
        where: { apiKey, isActive: true },
        select: { role: true },
      });
      callerRole = caller?.role ?? null;
    } else if (authHeader?.startsWith("Bearer ")) {
      const payload = await verifyToken(authHeader.slice(7));
      callerRole = payload?.role ?? null;
    }

    if (callerRole !== "SUPER_ADMIN") {
      return c.json({ success: false, error: "Forbidden: SUPER_ADMIN required to register users" }, 403);
    }
  }

  const existing = await prisma.user.findUnique({ where: { email: body.email } });
  if (existing) {
    return c.json({ success: false, error: "Email already registered" }, 409);
  }

  const passwordHash = await bcrypt.hash(body.password, 12);
  const role = isFirstUser ? "SUPER_ADMIN" : (body.role ?? "VIEWER");

  const user = await prisma.user.create({
    data: {
      email: body.email,
      name: body.name,
      passwordHash,
      role: role as any,
    },
    select: { id: true, email: true, name: true, role: true, createdAt: true },
  });

  log.info({ userId: user.id, role: user.role, isFirstUser }, "User registered");

  const { token } = await signToken(user.id, user.role);
  return c.json({ success: true, data: { token, user } }, 201);
});

// GET /api/auth/me — requires auth
authRouter.get("/me", authMiddleware, async (c) => {
  const userId = c.get("userId") as string;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, role: true, isActive: true, lastLoginAt: true, createdAt: true },
  });
  if (!user) return c.json({ success: false, error: "User not found" }, 404);
  return c.json({ success: true, data: user });
});

// POST /api/auth/refresh — requires auth
authRouter.post("/refresh", authMiddleware, async (c) => {
  const userId = c.get("userId") as string;
  const role = c.get("userRole") as string;

  // Blacklist old token if JWT (not API key)
  const authHeader = c.req.header("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const oldPayload = await verifyToken(authHeader.slice(7));
    if (oldPayload) {
      await blacklistToken(oldPayload.jti, oldPayload.exp);
    }
  }

  const { token } = await signToken(userId, role);
  return c.json({ success: true, data: { token } });
});

// POST /api/auth/logout — requires auth
authRouter.post("/logout", authMiddleware, async (c) => {
  const authHeader = c.req.header("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const payload = await verifyToken(authHeader.slice(7));
    if (payload) {
      await blacklistToken(payload.jti, payload.exp);
    }
  }
  return c.json({ success: true, data: { message: "Logged out" } });
});

// ─── User Management Routes ──────────────────────────────────

// All user routes require auth + ADMIN+
usersRouter.use("*", authMiddleware);
usersRouter.use("*", requireRole("ADMIN"));

// GET /api/users
usersRouter.get("/", async (c) => {
  const users = await prisma.user.findMany({
    select: {
      id: true, email: true, name: true, role: true,
      isActive: true, lastLoginAt: true, createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });
  return c.json({ success: true, data: users });
});

// POST /api/users
usersRouter.post("/", async (c) => {
  const body = await c.req.json().catch(() => null) as {
    email?: string; password?: string; name?: string; role?: string;
  } | null;

  if (!body?.email || !body?.password || !body?.name) {
    return c.json({ success: false, error: "email, password, and name are required" }, 400);
  }

  const existing = await prisma.user.findUnique({ where: { email: body.email } });
  if (existing) return c.json({ success: false, error: "Email already exists" }, 409);

  // Only SUPER_ADMIN can create SUPER_ADMIN users
  const callerRole = c.get("userRole") as string;
  if (body.role === "SUPER_ADMIN" && callerRole !== "SUPER_ADMIN") {
    return c.json({ success: false, error: "Only SUPER_ADMIN can create SUPER_ADMIN users" }, 403);
  }

  const passwordHash = await bcrypt.hash(body.password, 12);
  const user = await prisma.user.create({
    data: {
      email: body.email,
      name: body.name,
      passwordHash,
      role: (body.role ?? "VIEWER") as any,
    },
    select: { id: true, email: true, name: true, role: true, createdAt: true },
  });

  log.info({ userId: user.id, role: user.role }, "User created by admin");
  return c.json({ success: true, data: user }, 201);
});

// PUT /api/users/:id
usersRouter.put("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null) as {
    name?: string; role?: string; isActive?: boolean;
  } | null;

  if (!body) return c.json({ success: false, error: "Invalid body" }, 400);

  const callerRole = c.get("userRole") as string;

  // Only SUPER_ADMIN can promote/demote to SUPER_ADMIN
  if (body.role === "SUPER_ADMIN" && callerRole !== "SUPER_ADMIN") {
    return c.json({ success: false, error: "Only SUPER_ADMIN can assign SUPER_ADMIN role" }, 403);
  }

  const user = await prisma.user.update({
    where: { id },
    data: {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.role !== undefined && { role: body.role as any }),
      ...(body.isActive !== undefined && { isActive: body.isActive }),
    },
    select: { id: true, email: true, name: true, role: true, isActive: true, updatedAt: true },
  }).catch(() => null);

  if (!user) return c.json({ success: false, error: "User not found" }, 404);
  return c.json({ success: true, data: user });
});

// DELETE /api/users/:id — SUPER_ADMIN only
usersRouter.delete("/:id", requireRole("SUPER_ADMIN"), async (c) => {
  const id = c.req.param("id");
  const callerId = c.get("userId") as string;
  if (id === callerId) {
    return c.json({ success: false, error: "Cannot deactivate yourself" }, 400);
  }

  const user = await prisma.user.update({
    where: { id },
    data: { isActive: false },
    select: { id: true, email: true, isActive: true },
  }).catch(() => null);

  if (!user) return c.json({ success: false, error: "User not found" }, 404);
  log.info({ userId: id }, "User deactivated");
  return c.json({ success: true, data: user });
});

// POST /api/users/:id/api-key
usersRouter.post("/:id/api-key", async (c) => {
  const id = c.req.param("id");
  const apiKey = `vss_${randomUUID().replace(/-/g, "")}`;

  const user = await prisma.user.update({
    where: { id },
    data: { apiKey },
    select: { id: true, email: true, apiKey: true },
  }).catch(() => null);

  if (!user) return c.json({ success: false, error: "User not found" }, 404);
  log.info({ userId: id }, "API key generated");
  return c.json({ success: true, data: { id: user.id, email: user.email, apiKey: user.apiKey } });
});
