/**
 * Helper sleep theo mili-giây
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
  onRetry?: (error: any, attempt: number, delayMs: number) => void;
}

/**
 * Thực thi một hàm bất đồng bộ với cơ chế tự động Retry theo Exponential Backoff khi dính 429 hoặc 503
 */
export async function callWithRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxRetries =
    options.maxRetries ??
    (parseInt(process.env.AI_MAX_RETRIES || "3", 10) || 3);
  const initialDelayMs =
    options.initialDelayMs ??
    (parseInt(process.env.AI_RETRY_INITIAL_DELAY_MS || "3000", 10) || 3000);
  const maxDelayMs = options.maxDelayMs ?? 60000;
  const backoffFactor = options.backoffFactor ?? 2;

  let attempt = 0;
  let currentDelay = initialDelayMs;

  while (true) {
    try {
      return await fn();
    } catch (error: any) {
      attempt++;

      // Kiểm tra xem lỗi có phải là Rate Limit (429) hoặc Tạm thời quá tải (503/500/502) không
      const status =
        error?.status || error?.statusCode || error?.response?.status;
      const isRateLimit =
        status === 429 ||
        String(error?.message || "").includes("429") ||
        String(error?.message || "")
          .toLowerCase()
          .includes("rate limit") ||
        String(error?.message || "")
          .toLowerCase()
          .includes("too many requests");

      const isServerError =
        status === 500 || status === 502 || status === 503 || status === 504;

      if ((isRateLimit || isServerError) && attempt <= maxRetries) {
        // Kiểm tra xem server có trả về header retry-after không
        let retryAfterMs = currentDelay;
        const retryAfterHeader =
          error?.headers?.["retry-after"] ||
          error?.response?.headers?.["retry-after"];
        if (retryAfterHeader) {
          const parsedSec = parseInt(retryAfterHeader, 10);
          if (!isNaN(parsedSec)) {
            retryAfterMs = parsedSec * 1000;
          }
        }

        const delayToWait = Math.min(retryAfterMs, maxDelayMs);
        if (options.onRetry) {
          options.onRetry(error, attempt, delayToWait);
        } else {
          console.warn(
            `[RateLimiter] Gặp lỗi ${isRateLimit ? "429 Rate Limit" : "Server Error (" + status + ")"}. Đang chờ ${delayToWait / 1000}s trước khi thử lại lần ${attempt}/${maxRetries}...`,
          );
        }

        await sleep(delayToWait);
        currentDelay = Math.min(currentDelay * backoffFactor, maxDelayMs);
        continue;
      }

      // Nếu không thể retry hoặc đã hết số lần retry
      throw error;
    }
  }
}

/**
 * Hàng đợi kiểm soát khoảng cách thời gian giữa các requests (Rate Limit Queue)
 */
export class RateLimitQueue {
  private minIntervalMs: number;
  private lastCallTime: number = 0;
  private queue: Promise<any> = Promise.resolve();

  constructor(minIntervalMs?: number) {
    this.minIntervalMs =
      minIntervalMs ??
      (parseInt(process.env.AI_REQUEST_DELAY_MS || "1000", 10) || 1000);
  }

  /**
   * Thêm một tác vụ vào hàng đợi để thực thi với khoảng cách an toàn
   */
  public enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const task = async (): Promise<T> => {
      const now = Date.now();
      const timeSinceLast = now - this.lastCallTime;
      if (timeSinceLast < this.minIntervalMs) {
        const waitMs = this.minIntervalMs - timeSinceLast;
        await sleep(waitMs);
      }
      try {
        const result = await fn();
        return result;
      } finally {
        this.lastCallTime = Date.now();
      }
    };

    const nextPromise = this.queue.then(task, task);
    this.queue = nextPromise.catch(() => {});
    return nextPromise;
  }
}
