// ─── Auth Middleware ──────────────────────────────────────────
// JWT Bearer token + API key authentication for Hono

import type { MiddlewareHandler } from "hono";
import { jwtVerify } from "jose";
import { prisma } from "../db.js";
import { config } from "../utils/config.js";
import { getRedisClient } from "../jobs/queue.js";
import type { UserRole, Permission } from "./permissions.js";
import { hasMinRole, hasPermission } from "./permissions.js";
import type { AppEnv } from "../types/app.js";

// ─── JWT helpers ─────────────────────────────────────────────

function getJwtSecret(): Uint8Array {
  return new TextEncoder().encode(config.JWT_SECRET);
}

export interface JwtPayload {
  sub: string;   // userId
  jti: string;   // JWT ID (for blacklisting)
  role: UserRole;
  iat: number;
  exp: number;
}

export async function verifyToken(token: string): Promise<JwtPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret());

    // Check blacklist (logout)
    const redis = getRedisClient();
    const blacklisted = await redis.get(`jwt:blacklist:${payload.jti}`);
    if (blacklisted) return null;

    return payload as unknown as JwtPayload;
  } catch {
    return null;
  }
}

// ─── Auth middleware ──────────────────────────────────────────

export const authMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  let userId: string | null = null;
  let role: UserRole | null = null;

  // 1. Try x-api-key header
  const apiKey = c.req.header("x-api-key");
  if (apiKey) {
    const user = await prisma.user.findUnique({
      where: { apiKey, isActive: true },
      select: { id: true, role: true },
    });
    if (user) {
      userId = user.id;
      role = user.role as UserRole;
    }
  }

  // 2. Try Authorization: Bearer <token>
  if (!userId) {
    const authHeader = c.req.header("authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      const payload = await verifyToken(token);
      if (payload) {
        userId = payload.sub;
        role = payload.role;
      }
    }
  }

  if (!userId || !role) {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }

  c.set("userId", userId);
  c.set("userRole", role);

  await next();
};

// ─── Optional auth (attaches user if present, doesn't block) ─

export const optionalAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const apiKey = c.req.header("x-api-key");
  if (apiKey) {
    const user = await prisma.user.findUnique({
      where: { apiKey, isActive: true },
      select: { id: true, role: true },
    });
    if (user) {
      c.set("userId", user.id);
      c.set("userRole", user.role as UserRole);
    }
  } else {
    const authHeader = c.req.header("authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      const payload = await verifyToken(token);
      if (payload) {
        c.set("userId", payload.sub);
        c.set("userRole", payload.role);
      }
    }
  }
  await next();
};

// ─── Role-check middleware factory ───────────────────────────

export function requireRole(minRole: UserRole): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const role = c.get("userRole") as UserRole | undefined;
    if (!role || !hasMinRole(role, minRole)) {
      return c.json({ success: false, error: "Forbidden" }, 403);
    }
    await next();
  };
}

// ─── Permission-check middleware factory ─────────────────────

export function requirePermission(permission: Permission): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const role = c.get("userRole") as UserRole | undefined;
    if (!role || !hasPermission(role, permission)) {
      return c.json({ success: false, error: "Forbidden" }, 403);
    }
    await next();
  };
}

// ─── Blacklist token (for logout) ────────────────────────────

export async function blacklistToken(jti: string, expiresAt: number): Promise<void> {
  const ttl = Math.max(0, expiresAt - Math.floor(Date.now() / 1000));
  if (ttl > 0) {
    const redis = getRedisClient();
    await redis.setex(`jwt:blacklist:${jti}`, ttl, "1");
  }
}
