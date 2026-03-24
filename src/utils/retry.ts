import { createLogger } from "./logger.js";

const log = createLogger("retry");

export interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
  retryOn?: (err: unknown) => boolean;
  onRetry?: (attempt: number, err: unknown, delayMs: number) => void;
}

// ─── Exponential backoff with jitter ─────────────────────────

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    initialDelayMs = 1000,
    maxDelayMs = 30_000,
    backoffFactor = 2,
    retryOn = () => true,
    onRetry,
  } = options;

  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;

      if (attempt === maxAttempts || !retryOn(err)) {
        throw err;
      }

      // Exponential backoff with ±10% jitter
      const base = Math.min(initialDelayMs * Math.pow(backoffFactor, attempt - 1), maxDelayMs);
      const jitter = base * 0.1 * (Math.random() * 2 - 1);
      const delayMs = Math.round(base + jitter);

      if (onRetry) {
        onRetry(attempt, err, delayMs);
      } else {
        log.warn(
          { attempt, maxAttempts, delayMs, err },
          `Retry attempt ${attempt}/${maxAttempts} after ${delayMs}ms`
        );
      }

      await Bun.sleep(delayMs);
    }
  }

  throw lastErr;
}

// ─── Poll until condition is met ─────────────────────────────

export async function pollUntil<T>(
  fn: () => Promise<T>,
  condition: (result: T) => boolean,
  options: {
    intervalMs?: number;
    timeoutMs?: number;
    onPoll?: (result: T, elapsed: number) => void;
  } = {}
): Promise<T> {
  const { intervalMs = 5000, timeoutMs = 10 * 60 * 1000, onPoll } = options;
  const start = Date.now();

  while (true) {
    const result = await fn();
    const elapsed = Date.now() - start;

    if (onPoll) onPoll(result, elapsed);

    if (condition(result)) {
      return result;
    }

    if (elapsed + intervalMs >= timeoutMs) {
      throw new Error(`Polling timed out after ${elapsed}ms`);
    }

    await Bun.sleep(intervalMs);
  }
}

// ─── Non-retriable error marker ──────────────────────────────

export class NonRetriableError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "NonRetriableError";
  }
}
