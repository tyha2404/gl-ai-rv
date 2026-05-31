import { describe, it } from 'node:test';
import assert from 'node:assert';
import { GoogleChatNotifier } from './notifier';

describe('GoogleChatNotifier', () => {
  it('should not throw if webhook URL is missing in constructor', () => {
    delete process.env.GOOGLE_CHAT_WEBHOOK_URL;
    const notifier = new GoogleChatNotifier();
    assert.strictEqual((notifier as any).webhookUrl, undefined);
  });

  it('should log a warning if webhook URL is missing when sending notification', async () => {
    delete process.env.GOOGLE_CHAT_WEBHOOK_URL;
    const notifier = new GoogleChatNotifier();
    
    // Mock console.warn
    const originalWarn = console.warn;
    let warned = false;
    console.warn = () => { warned = true; };
    
    await notifier.sendReviewNotification({
      title: 'Test',
      author: 'Tester',
      url: 'http://example.com',
      summary: 'Test summary',
      issueCount: 0
    });
    
    console.warn = originalWarn;
    assert.strictEqual(warned, true);
  });
});
