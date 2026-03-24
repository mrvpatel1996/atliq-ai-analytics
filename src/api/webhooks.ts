// ─── Webhooks API ────────────────────────────────────────────
// Receive status update callbacks from Vimeo, Gumlet, and Cloudflare

import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "crypto";
import { prisma } from "../db.js";
import { config } from "../utils/config.js";
import { createLogger } from "../utils/logger.js";
import type { VimeoWebhookPayload, GumletWebhookPayload, CloudflareWebhookPayload } from "../types/index.js";

const log = createLogger("api:webhooks");

export const webhooksRouter = new Hono();

// ─── Signature verification helpers ──────────────────────────

function verifyHmacSha256(
  secret: string,
  payload: string,
  signature: string
): boolean {
  if (!secret) return true; // No secret configured — skip verification
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ─── Platform status → SyncStatus mapping ────────────────────

function mapVimeoStatus(status?: string): "READY" | "FAILED" | "PROCESSING" | null {
  if (!status) return null;
  if (status === "complete") return "READY";
  if (status === "error") return "FAILED";
  return "PROCESSING";
}

function mapGumletStatus(status?: string): "READY" | "FAILED" | "PROCESSING" | null {
  if (!status) return null;
  if (status === "ready") return "READY";
  if (status === "error" || status === "failed") return "FAILED";
  return "PROCESSING";
}

function mapCloudflareStatus(state?: string): "READY" | "FAILED" | "PROCESSING" | null {
  if (!state) return null;
  if (state === "ready") return "READY";
  if (state === "error") return "FAILED";
  return "PROCESSING";
}

// ─── Vimeo ────────────────────────────────────────────────────

webhooksRouter.post("/vimeo", async (c) => {
  const rawBody = await c.req.text();
  const sig = c.req.header("x-vimeo-webhook-signature") ?? "";

  if (config.WEBHOOK_SECRET_VIMEO && !verifyHmacSha256(config.WEBHOOK_SECRET_VIMEO, rawBody, sig)) {
    log.warn("Vimeo webhook signature verification failed");
    return c.json({ error: "Invalid signature" }, 401);
  }

  let payload: VimeoWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as VimeoWebhookPayload;
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const platformId = String(payload.data?.id ?? "").split("/").pop()!;
  const eventType = payload.type;

  // Store event
  const webhookEvent = await prisma.webhookEvent.create({
    data: {
      platform: "VIMEO",
      eventType,
      payload: payload as object,
      platformId,
    },
  });

  // Try to match to a PlatformResult
  const platformResult = await prisma.platformResult.findFirst({
    where: { platform: "VIMEO", platformId },
  });

  if (platformResult) {
    const newStatus = mapVimeoStatus(payload.data?.transcode?.status ?? payload.data?.status ?? undefined);
    if (newStatus) {
      await prisma.platformResult.update({
        where: { id: platformResult.id },
        data: { status: newStatus },
      });
      await prisma.webhookEvent.update({
        where: { id: webhookEvent.id },
        data: { jobId: platformResult.jobId, status: "PROCESSED", processedAt: new Date() },
      });
      log.info({ platformId, newStatus, jobId: platformResult.jobId }, "Vimeo webhook processed");
    }
  } else {
    log.debug({ platformId, eventType }, "Vimeo webhook: no matching job found");
  }

  return c.json({ received: true });
});

// ─── Gumlet ───────────────────────────────────────────────────

webhooksRouter.post("/gumlet", async (c) => {
  const rawBody = await c.req.text();
  const sig = c.req.header("x-gumlet-signature") ?? "";

  if (config.WEBHOOK_SECRET_GUMLET && !verifyHmacSha256(config.WEBHOOK_SECRET_GUMLET, rawBody, sig)) {
    log.warn("Gumlet webhook signature verification failed");
    return c.json({ error: "Invalid signature" }, 401);
  }

  let payload: GumletWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as GumletWebhookPayload;
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const platformId = payload.asset_id;
  const eventType = payload.type;

  const webhookEvent = await prisma.webhookEvent.create({
    data: {
      platform: "GUMLET",
      eventType,
      payload: payload as object,
      platformId,
    },
  });

  const platformResult = await prisma.platformResult.findFirst({
    where: { platform: "GUMLET", platformId },
  });

  if (platformResult) {
    const newStatus = mapGumletStatus(payload.status);
    if (newStatus) {
      const updateData: Record<string, unknown> = { status: newStatus };
      if (payload.output_url) updateData.hlsUrl = payload.output_url;
      if (payload.thumbnail) updateData.thumbnailUrl = payload.thumbnail;

      await prisma.platformResult.update({
        where: { id: platformResult.id },
        data: updateData,
      });
      await prisma.webhookEvent.update({
        where: { id: webhookEvent.id },
        data: { jobId: platformResult.jobId, status: "PROCESSED", processedAt: new Date() },
      });
      log.info({ platformId, newStatus, jobId: platformResult.jobId }, "Gumlet webhook processed");
    }
  }

  return c.json({ received: true });
});

// ─── Cloudflare ───────────────────────────────────────────────

webhooksRouter.post("/cloudflare", async (c) => {
  const rawBody = await c.req.text();
  // Cloudflare uses a webhook secret in the Authorization header
  const authHeader = c.req.header("authorization") ?? "";
  const secret = config.WEBHOOK_SECRET_CLOUDFLARE;
  if (secret && authHeader !== `Bearer ${secret}`) {
    log.warn("Cloudflare webhook auth failed");
    return c.json({ error: "Unauthorized" }, 401);
  }

  let payload: CloudflareWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as CloudflareWebhookPayload;
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const platformId = payload.uid;
  const state = payload.status?.state;

  const webhookEvent = await prisma.webhookEvent.create({
    data: {
      platform: "CLOUDFLARE",
      eventType: `stream.${state ?? "unknown"}`,
      payload: payload as object,
      platformId,
    },
  });

  const platformResult = await prisma.platformResult.findFirst({
    where: { platform: "CLOUDFLARE", platformId },
  });

  if (platformResult) {
    const newStatus = mapCloudflareStatus(state);
    if (newStatus) {
      const updateData: Record<string, unknown> = { status: newStatus };
      if (payload.playback?.hls) updateData.hlsUrl = payload.playback.hls;
      if (payload.playback?.dash) updateData.dashUrl = payload.playback.dash;
      if (payload.thumbnail) updateData.thumbnailUrl = payload.thumbnail;

      await prisma.platformResult.update({
        where: { id: platformResult.id },
        data: updateData,
      });
      await prisma.webhookEvent.update({
        where: { id: webhookEvent.id },
        data: { jobId: platformResult.jobId, status: "PROCESSED", processedAt: new Date() },
      });
      log.info({ platformId, newStatus, jobId: platformResult.jobId }, "Cloudflare webhook processed");
    }
  }

  return c.json({ received: true });
});
