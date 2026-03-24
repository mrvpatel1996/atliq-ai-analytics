import {
  S3Client,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "../utils/config.js";
import { createLogger } from "../utils/logger.js";
import type { S3VideoInfo } from "../types/index.js";

const log = createLogger("s3");

// ─── Client ──────────────────────────────────────────────────

function buildClient(): S3Client {
  return new S3Client({
    region: config.AWS_REGION,
    credentials: {
      accessKeyId: config.AWS_ACCESS_KEY_ID,
      secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
    },
    ...(config.S3_ENDPOINT ? { endpoint: config.S3_ENDPOINT, forcePathStyle: true } : {}),
  });
}

let _client: S3Client | null = null;

function getClient(): S3Client {
  if (!_client) _client = buildClient();
  return _client;
}

// ─── S3 Service ───────────────────────────────────────────────

export const s3Service = {
  // ── Metadata ──────────────────────────────────────────────

  async getVideoInfo(key: string, bucket?: string): Promise<S3VideoInfo> {
    const Bucket = bucket ?? config.S3_BUCKET;
    const cmd = new HeadObjectCommand({ Bucket, Key: key });
    const res = await getClient().send(cmd);

    return {
      key,
      bucket: Bucket,
      etag: (res.ETag ?? "").replace(/"/g, ""),
      size: res.ContentLength ?? 0,
      contentType: res.ContentType ?? "application/octet-stream",
      lastModified: res.LastModified ?? new Date(),
    };
  },

  // ── Download / Stream ─────────────────────────────────────

  async getReadableStream(key: string, bucket?: string): Promise<ReadableStream<Uint8Array>> {
    const Bucket = bucket ?? config.S3_BUCKET;
    const cmd = new GetObjectCommand({ Bucket, Key: key });
    const res = await getClient().send(cmd);

    if (!res.Body) {
      throw new Error(`No body returned for s3://${Bucket}/${key}`);
    }

    // AWS SDK returns a web-compatible ReadableStream in Node/Bun >= 18
    return res.Body.transformToWebStream() as ReadableStream<Uint8Array>;
  },

  async downloadToBuffer(key: string, bucket?: string): Promise<Buffer> {
    const Bucket = bucket ?? config.S3_BUCKET;
    const cmd = new GetObjectCommand({ Bucket, Key: key });
    const res = await getClient().send(cmd);

    if (!res.Body) {
      throw new Error(`No body for s3://${Bucket}/${key}`);
    }

    const bytes = await res.Body.transformToByteArray();
    return Buffer.from(bytes);
  },

  async downloadToFile(key: string, localPath: string, bucket?: string): Promise<void> {
    const stream = await this.getReadableStream(key, bucket);
    await Bun.write(localPath, stream);
    log.debug({ key, localPath }, "Downloaded S3 object to file");
  },

  // ── Upload ────────────────────────────────────────────────

  async uploadFromFile(
    localPath: string,
    key: string,
    options: { bucket?: string; contentType?: string; metadata?: Record<string, string> } = {}
  ): Promise<void> {
    const Bucket = options.bucket ?? config.S3_BUCKET;
    const file = Bun.file(localPath);
    const size = file.size;

    log.info({ key, size, Bucket }, "Starting S3 upload");

    if (size > config.S3_MULTIPART_THRESHOLD) {
      // Use managed multipart upload
      const upload = new Upload({
        client: getClient(),
        params: {
          Bucket,
          Key: key,
          Body: file.stream(),
          ContentType: options.contentType ?? file.type,
          Metadata: options.metadata,
        },
        queueSize: 4,
        partSize: 20 * 1024 * 1024, // 20MB parts
        leavePartsOnError: false,
      });

      upload.on("httpUploadProgress", (progress) => {
        log.debug({ key, progress }, "Multipart upload progress");
      });

      await upload.done();
    } else {
      await getClient().send(
        new PutObjectCommand({
          Bucket,
          Key: key,
          Body: new Uint8Array(await file.arrayBuffer()),
          ContentType: options.contentType ?? file.type,
          Metadata: options.metadata,
        })
      );
    }

    log.info({ key, Bucket }, "S3 upload complete");
  },

  // ── Presigned URLs ────────────────────────────────────────

  async getPresignedDownloadUrl(
    key: string,
    expiresInSeconds = 3600,
    bucket?: string
  ): Promise<string> {
    const Bucket = bucket ?? config.S3_BUCKET;
    const cmd = new GetObjectCommand({ Bucket, Key: key });
    return getSignedUrl(getClient(), cmd, { expiresIn: expiresInSeconds });
  },

  async getPresignedUploadUrl(
    key: string,
    contentType: string,
    expiresInSeconds = 3600,
    bucket?: string
  ): Promise<string> {
    const Bucket = bucket ?? config.S3_BUCKET;
    const cmd = new PutObjectCommand({ Bucket, Key: key, ContentType: contentType });
    return getSignedUrl(getClient(), cmd, { expiresIn: expiresInSeconds });
  },

  // ── List objects ──────────────────────────────────────────

  async listVideos(
    prefix = "",
    bucket?: string
  ): Promise<{ key: string; size: number; lastModified: Date; etag: string }[]> {
    const Bucket = bucket ?? config.S3_BUCKET;
    const results: { key: string; size: number; lastModified: Date; etag: string }[] = [];

    let continuationToken: string | undefined;

    do {
      const res = await getClient().send(
        new ListObjectsV2Command({
          Bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        })
      );

      for (const obj of res.Contents ?? []) {
        if (obj.Key && isVideoKey(obj.Key)) {
          results.push({
            key: obj.Key,
            size: obj.Size ?? 0,
            lastModified: obj.LastModified ?? new Date(),
            etag: (obj.ETag ?? "").replace(/"/g, ""),
          });
        }
      }

      continuationToken = res.NextContinuationToken;
    } while (continuationToken);

    return results;
  },

  // ── Health check ──────────────────────────────────────────

  async healthCheck(): Promise<{ status: "ok" | "error"; latencyMs: number; error?: string }> {
    const start = Date.now();
    try {
      await getClient().send(
        new HeadObjectCommand({ Bucket: config.S3_BUCKET, Key: "__health_check__" })
      );
      return { status: "ok", latencyMs: Date.now() - start };
    } catch (err: unknown) {
      // 404 means bucket is reachable but key doesn't exist — that's fine
      if (err instanceof Error && "name" in err && (err as { name: string }).name === "NotFound") {
        return { status: "ok", latencyMs: Date.now() - start };
      }
      const message = err instanceof Error ? err.message : String(err);
      return { status: "error", latencyMs: Date.now() - start, error: message };
    }
  },
};

// ─── Helpers ─────────────────────────────────────────────────

const VIDEO_EXTENSIONS = new Set([
  ".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v",
  ".wmv", ".flv", ".ts", ".mts", ".3gp",
]);

function isVideoKey(key: string): boolean {
  const ext = key.slice(key.lastIndexOf(".")).toLowerCase();
  return VIDEO_EXTENSIONS.has(ext);
}
