import {
  S3Client,
  HeadObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createLogger } from "../utils/logger.js";
import type { ProviderAdapter, ProviderVideoInfo, VideoUploadResult, StreamUrls } from "./types.js";
import type { S3Credentials } from "../types/index.js";

const log = createLogger("provider:s3");

const VIDEO_EXTENSIONS = new Set([
  ".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v",
  ".wmv", ".flv", ".ts", ".mts", ".3gp",
]);

function isVideoKey(key: string): boolean {
  const ext = key.slice(key.lastIndexOf(".")).toLowerCase();
  return VIDEO_EXTENSIONS.has(ext);
}

export class S3ProviderAdapter implements ProviderAdapter {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(private readonly creds: S3Credentials) {
    this.client = new S3Client({
      region: creds.region,
      credentials: {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
      },
      ...(creds.endpoint ? { endpoint: creds.endpoint, forcePathStyle: true } : {}),
    });
    this.bucket = creds.bucket;
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, MaxKeys: 1 })
      );
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async listAllVideos(): Promise<ProviderVideoInfo[]> {
    const results: ProviderVideoInfo[] = [];
    let continuationToken: string | undefined;

    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          ContinuationToken: continuationToken,
        })
      );

      for (const obj of res.Contents ?? []) {
        if (!obj.Key || !isVideoKey(obj.Key)) continue;
        results.push({
          externalId: obj.Key,
          title: obj.Key.split("/").pop(),
          size: obj.Size,
          status: "ready",
          metadata: {
            key: obj.Key,
            bucket: this.bucket,
            size: obj.Size,
            lastModified: obj.LastModified?.toISOString(),
            etag: (obj.ETag ?? "").replace(/"/g, ""),
          },
        });
      }

      continuationToken = res.NextContinuationToken;
    } while (continuationToken);

    log.info({ bucket: this.bucket, count: results.length }, "S3 video list fetched");
    return results;
  }

  async getVideoDetails(externalId: string): Promise<ProviderVideoInfo> {
    const res = await this.client.send(
      new HeadObjectCommand({ Bucket: this.bucket, Key: externalId })
    );
    return {
      externalId,
      title: externalId.split("/").pop(),
      size: res.ContentLength,
      status: "ready",
      metadata: {
        key: externalId,
        bucket: this.bucket,
        contentType: res.ContentType,
        lastModified: res.LastModified?.toISOString(),
        etag: (res.ETag ?? "").replace(/"/g, ""),
      },
    };
  }

  async getSourceUrl(externalId: string): Promise<string> {
    const cmd = new GetObjectCommand({ Bucket: this.bucket, Key: externalId });
    return getSignedUrl(this.client, cmd, { expiresIn: 7200 });
  }

  async uploadVideo(
    sourceUrl: string,
    metadata: { title?: string; description?: string; tags?: string[] }
  ): Promise<VideoUploadResult> {
    const safeName = (metadata.title ?? "video").replace(/[^a-zA-Z0-9.-]/g, "_");
    const key = `uploads/${Date.now()}-${safeName}.mp4`;

    log.info({ key, sourceUrl: sourceUrl.slice(0, 80) }, "S3: uploading from URL");

    const res = await fetch(sourceUrl);
    if (!res.ok) throw new Error(`Failed to fetch source URL: ${res.status}`);
    if (!res.body) throw new Error("No response body from source URL");

    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: key,
        Body: res.body as unknown as NodeJS.ReadableStream,
        ContentType: res.headers.get("content-type") ?? "video/mp4",
      },
      queueSize: 4,
      partSize: 20 * 1024 * 1024,
      leavePartsOnError: false,
    });

    await upload.done();

    const playerUrl = await this.getSourceUrl(key);
    return { externalId: key, playerUrl };
  }

  async deleteVideo(externalId: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: externalId })
    );
  }

  async getStreamUrls(externalId: string): Promise<StreamUrls> {
    const url = await this.getSourceUrl(externalId);
    return { playerUrl: url };
  }
}
