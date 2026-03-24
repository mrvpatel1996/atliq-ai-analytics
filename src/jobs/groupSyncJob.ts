// ─── Group Sync Job ───────────────────────────────────────────
// BullMQ processor for syncing metadata across VideoGroup members

import { Worker, type Job } from "bullmq";
import { prisma } from "../db.js";
import { createRedisConnection, QUEUE_NAMES } from "./queue.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("groupSyncJob");

// ─── Job data type ────────────────────────────────────────────

export interface GroupSyncJobData {
  groupId: string;
  syncId: string;
  action: "sync_metadata" | "sync_thumbnail" | "full_sync";
  triggeredBy?: string;
}

// ─── Processor ───────────────────────────────────────────────

async function processGroupSync(job: Job<GroupSyncJobData>): Promise<void> {
  const { groupId, syncId, action } = job.data;

  log.info({ groupId, syncId, action }, "Processing group sync job");

  // Mark sync record as in-progress
  await prisma.videoGroupSync.update({
    where: { id: syncId },
    data: { status: "PROCESSING" },
  });

  await job.updateProgress(5);

  try {
    const group = await prisma.videoGroup.findUnique({
      where: { id: groupId },
      include: {
        videos: {
          include: {
            providerVideo: {
              include: { provider: true },
            },
          },
        },
      },
    });

    if (!group) throw new Error(`VideoGroup ${groupId} not found`);
    if (!group.primaryVideoId) throw new Error("Group has no primary video set");

    const primaryMember = group.videos.find((m) => m.providerVideoId === group.primaryVideoId);
    if (!primaryMember) throw new Error("Primary video not found among group members");

    const primary = primaryMember.providerVideo;
    const others = group.videos.filter((m) => m.providerVideoId !== group.primaryVideoId);

    if (others.length === 0) {
      log.info({ groupId }, "No other members to sync — marking complete");
      await prisma.videoGroupSync.update({
        where: { id: syncId },
        data: { status: "READY", completedAt: new Date(), details: { synced: 0 } },
      });
      return;
    }

    await job.updateProgress(20);

    const results: Array<{ videoId: string; status: "ok" | "failed"; error?: string }> = [];
    const total = others.length;

    for (let i = 0; i < others.length; i++) {
      const member = others[i];
      const video = member.providerVideo;

      try {
        if (action === "sync_metadata" || action === "full_sync") {
          // Sync title and description from primary into the local DB record
          const updateData: Record<string, unknown> = {};
          if (primary.title !== null) updateData.title = primary.title;
          if (primary.description !== null) updateData.description = primary.description;

          if (Object.keys(updateData).length > 0) {
            await prisma.providerVideo.update({
              where: { id: video.id },
              data: updateData,
            });
          }
        }

        if (action === "sync_thumbnail" || action === "full_sync") {
          if (primary.thumbnailUrl) {
            await prisma.providerVideo.update({
              where: { id: video.id },
              data: { thumbnailUrl: primary.thumbnailUrl },
            });
          }
        }

        results.push({ videoId: video.id, status: "ok" });
        log.info({ groupId, videoId: video.id, action }, "Member synced");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ groupId, videoId: video.id, err }, "Failed to sync member");
        results.push({ videoId: video.id, status: "failed", error: message });
      }

      await job.updateProgress(20 + Math.round(((i + 1) / total) * 75));
    }

    const failed = results.filter((r) => r.status === "failed").length;
    const synced = results.filter((r) => r.status === "ok").length;

    const finalStatus = failed === 0 ? "READY" : synced === 0 ? "FAILED" : "READY";

    await prisma.videoGroupSync.update({
      where: { id: syncId },
      data: {
        status: finalStatus,
        completedAt: new Date(),
        details: { synced, failed, results },
      },
    });

    // Update group status
    await prisma.videoGroup.update({
      where: { id: groupId },
      data: { status: failed > 0 ? "SYNC_FAILED" : "ACTIVE" },
    });

    await job.updateProgress(100);
    log.info({ groupId, syncId, synced, failed }, "Group sync completed");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ groupId, syncId, err }, "Group sync job failed");

    await prisma.videoGroupSync.update({
      where: { id: syncId },
      data: { status: "FAILED", completedAt: new Date(), error: message },
    }).catch(() => {});

    await prisma.videoGroup.update({
      where: { id: groupId },
      data: { status: "SYNC_FAILED" },
    }).catch(() => {});

    throw err; // Re-throw so BullMQ can handle retries
  }
}

// ─── Worker factory ───────────────────────────────────────────

let _worker: Worker | null = null;

export function startGroupSyncWorker(): Worker {
  if (_worker) return _worker;

  _worker = new Worker<GroupSyncJobData>(
    QUEUE_NAMES.SYNC,
    async (job) => {
      // Only handle group-sync jobs; pass others through
      if (job.name !== "group-sync") return;
      return processGroupSync(job);
    },
    {
      connection: createRedisConnection(),
      concurrency: 5,
    }
  );

  _worker.on("completed", (job) => {
    log.info({ syncId: job.data.syncId, groupId: job.data.groupId }, "Worker: group sync completed");
  });

  _worker.on("failed", (job, err) => {
    log.error({ syncId: job?.data?.syncId, groupId: job?.data?.groupId, err }, "Worker: group sync failed");
  });

  _worker.on("error", (err) => {
    log.error({ err }, "Group sync worker error");
  });

  log.info("Group sync worker started");
  return _worker;
}

export async function stopGroupSyncWorker(): Promise<void> {
  if (_worker) {
    await _worker.close();
    _worker = null;
    log.info("Group sync worker stopped");
  }
}
