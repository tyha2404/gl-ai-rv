import { describe, it } from 'node:test';
import assert from 'node:assert';
import { callWithRetry, RateLimitQueue } from './rateLimiter';

describe('RateLimiter & Retry Utilities', () => {
  it('should successfully return result without retry on first try', async () => {
    let callCount = 0;
    const result = await callWithRetry(async () => {
      callCount++;
      return 'success';
    });

    assert.strictEqual(result, 'success');
    assert.strictEqual(callCount, 1);
  });

  it('should retry when encountering a 429 error and succeed', async () => {
    let callCount = 0;
    let retryLogged = 0;

    const result = await callWithRetry(
      async () => {
        callCount++;
        if (callCount < 3) {
          const err: any = new Error('Rate limit exceeded');
          err.status = 429;
          throw err;
        }
        return 'recovered';
      },
      {
        initialDelayMs: 10,
        maxRetries: 3,
        onRetry: () => {
          retryLogged++;
        },
      }
    );

    assert.strictEqual(result, 'recovered');
    assert.strictEqual(callCount, 3);
    assert.strictEqual(retryLogged, 2);
  });

  it('should throw error after exceeding maxRetries on 429', async () => {
    let callCount = 0;
    await assert.rejects(
      async () => {
        await callWithRetry(
          async () => {
            callCount++;
            const err: any = new Error('Too many requests');
            err.status = 429;
            throw err;
          },
          {
            initialDelayMs: 10,
            maxRetries: 2,
            onRetry: () => {},
          }
        );
      },
      {
        message: 'Too many requests',
      }
    );

    assert.strictEqual(callCount, 3); // initial + 2 retries
  });

  it('should throttle requests in RateLimitQueue with min interval', async () => {
    const queue = new RateLimitQueue(50);
    const timestamps: number[] = [];

    const task = () =>
      queue.enqueue(async () => {
        timestamps.push(Date.now());
        return true;
      });

    await Promise.all([task(), task(), task()]);

    assert.strictEqual(timestamps.length, 3);
    if (timestamps[1] && timestamps[0] && timestamps[2]) {
      assert.ok(timestamps[1] - timestamps[0] >= 40);
      assert.ok(timestamps[2] - timestamps[1] >= 40);
    }
  });
});
