import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { GoogleChatNotifier, NotificationPayload } from './notifier';

describe('GoogleChatNotifier', () => {
  let originalFetch: any;

  before(() => {
    originalFetch = global.fetch;
  });

  after(() => {
    global.fetch = originalFetch;
  });

  it('should not throw if webhook URL is missing in constructor', () => {
    const oldUrl = process.env.GOOGLE_CHAT_WEBHOOK_URL;
    delete process.env.GOOGLE_CHAT_WEBHOOK_URL;
    const notifier = new GoogleChatNotifier();
    assert.strictEqual((notifier as any).webhookUrl, undefined);
    process.env.GOOGLE_CHAT_WEBHOOK_URL = oldUrl;
  });

  it('should log a warning if webhook URL is missing when sending notification', async () => {
    const oldUrl = process.env.GOOGLE_CHAT_WEBHOOK_URL;
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
    process.env.GOOGLE_CHAT_WEBHOOK_URL = oldUrl;
  });

  it('should send notification via fetch when webhook URL is present', async () => {
    process.env.GOOGLE_CHAT_WEBHOOK_URL = 'http://webhook.url';
    const notifier = new GoogleChatNotifier();
    
    let fetchCalled = false;
    let fetchUrl = '';
    let fetchOptions: any = {};

    global.fetch = (async (url: string, options: any) => {
      fetchCalled = true;
      fetchUrl = url;
      fetchOptions = options;
      return { ok: true } as Response;
    }) as any;

    const payload: NotificationPayload = {
      title: 'Merge Request Review',
      author: 'John Doe',
      url: 'https://gitlab.com/mr/1',
      summary: 'Fixed some bugs',
      issueCount: 3
    };

    await notifier.sendReviewNotification(payload);

    assert.strictEqual(fetchCalled, true);
    assert.strictEqual(fetchUrl, 'http://webhook.url');
    assert.strictEqual(fetchOptions.method, 'POST');
    
    const body = JSON.parse(fetchOptions.body);
    assert.ok(body.cardsV2);
    assert.strictEqual(body.cardsV2[0].card.header.title, payload.title);
    assert.strictEqual(body.cardsV2[0].card.sections[0].widgets[0].decoratedText.text, payload.author);
    assert.strictEqual(body.cardsV2[0].card.sections[0].widgets[1].decoratedText.text, '3');
  });

  it('should escape HTML characters in title, author and summary', async () => {
    process.env.GOOGLE_CHAT_WEBHOOK_URL = 'http://webhook.url';
    const notifier = new GoogleChatNotifier();
    
    let fetchOptions: any = {};
    global.fetch = (async (url: string, options: any) => {
      fetchOptions = options;
      return { ok: true } as Response;
    }) as any;

    const payload: NotificationPayload = {
      title: 'Review: <script>alert(1)</script>',
      author: 'User <user@example.com>',
      url: 'https://gitlab.com/mr/1',
      summary: 'Found **2** issues & 1 *warning* in <file>.',
      issueCount: 2
    };

    await notifier.sendReviewNotification(payload);

    const body = JSON.parse(fetchOptions.body);
    const card = body.cardsV2[0].card;
    
    assert.strictEqual(card.header.title, 'Review: &lt;script&gt;alert(1)&lt;/script&gt;');
    assert.strictEqual(card.sections[0].widgets[0].decoratedText.text, 'User &lt;user@example.com&gt;');
    assert.strictEqual(card.sections[1].widgets[0].textParagraph.text, 'Found <b>2</b> issues &amp; 1 <i>warning</i> in &lt;file&gt;.');
  });
});
