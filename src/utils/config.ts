import { z } from "zod";

// ─── Env Schema ──────────────────────────────────────────────

const envSchema = z.object({
  // Server
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  // Database
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  // Redis
  REDIS_URL: z.string().min(1, "REDIS_URL is required").default("redis://localhost:6379"),

  // AWS / S3
  AWS_ACCESS_KEY_ID: z.string().min(1, "AWS_ACCESS_KEY_ID is required"),
  AWS_SECRET_ACCESS_KEY: z.string().min(1, "AWS_SECRET_ACCESS_KEY is required"),
  AWS_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string().min(1, "S3_BUCKET is required"),
  S3_ENDPOINT: z.string().optional(),
  S3_MULTIPART_THRESHOLD: z.coerce.number().default(100 * 1024 * 1024), // 100MB

  // Vimeo
  VIMEO_CLIENT_ID: z.string().min(1, "VIMEO_CLIENT_ID is required"),
  VIMEO_CLIENT_SECRET: z.string().min(1, "VIMEO_CLIENT_SECRET is required"),
  VIMEO_ACCESS_TOKEN: z.string().min(1, "VIMEO_ACCESS_TOKEN is required"),
  VIMEO_DEFAULT_PRIVACY: z
    .enum(["anybody", "nobody", "contacts", "password", "unlisted", "users"])
    .default("unlisted"),

  // Gumlet
  GUMLET_API_KEY: z.string().min(1, "GUMLET_API_KEY is required"),
  GUMLET_COLLECTION_ID: z.string().min(1, "GUMLET_COLLECTION_ID is required"),

  // Cloudflare Stream
  CLOUDFLARE_ACCOUNT_ID: z.string().min(1, "CLOUDFLARE_ACCOUNT_ID is required"),
  CLOUDFLARE_API_TOKEN: z.string().min(1, "CLOUDFLARE_API_TOKEN is required"),
  CLOUDFLARE_STREAM_SIGNING_KEY: z.string().optional(),

  // Webhook secrets
  WEBHOOK_SECRET_VIMEO: z.string().default(""),
  WEBHOOK_SECRET_GUMLET: z.string().default(""),
  WEBHOOK_SECRET_CLOUDFLARE: z.string().default(""),
  PUBLIC_BASE_URL: z.string().default("http://localhost:3000"),

  // Sync engine
  SYNC_DEFAULT_DESTINATIONS: z
    .string()
    .default("vimeo,gumlet,cloudflare")
    .transform((s) =>
      s
        .split(",")
        .map((d) => d.trim().toUpperCase())
        .filter(Boolean)
    ),
  SYNC_MAX_CONCURRENCY: z.coerce.number().default(5),
  SYNC_MAX_RETRIES: z.coerce.number().default(3),
  SYNC_RETRY_DELAY_MS: z.coerce.number().default(5000),

  // Encryption key for provider credentials (32 bytes = 64 hex chars)
  ENCRYPTION_KEY: z
    .string()
    .min(64, "ENCRYPTION_KEY must be at least 64 hex characters")
    .default("deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"),

  // JWT auth
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters").default("change-me-in-production-must-be-32-chars-minimum"),
  JWT_EXPIRES_IN: z.string().default("7d"),

  // Logging
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .default("info"),
  LOG_PRETTY: z
    .string()
    .transform((v) => v === "true" || v === "1")
    .default("true"),
});

// ─── Parse & export ──────────────────────────────────────────

function loadConfig() {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  • ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment variables:\n${issues}`);
  }
  return result.data;
}

export type Config = z.infer<typeof envSchema>;
export const config: Config = loadConfig();
