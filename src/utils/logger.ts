import pino from "pino";
import { config } from "./config.js";

// ─── Pino Logger ─────────────────────────────────────────────

const transport =
  config.LOG_PRETTY
    ? pino.transport({
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:yyyy-mm-dd HH:MM:ss",
          ignore: "pid,hostname",
          messageFormat: "{msg}",
        },
      })
    : undefined;

export const logger = pino(
  {
    level: config.LOG_LEVEL,
    base: { service: "video-sync" },
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: {
      err: pino.stdSerializers.err,
      error: pino.stdSerializers.err,
    },
  },
  transport
);

// Child logger factory for per-module context
export function createLogger(module: string, extra?: Record<string, unknown>) {
  return logger.child({ module, ...extra });
}
