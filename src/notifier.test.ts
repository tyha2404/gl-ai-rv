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
      repoName: 'test-group/test-repo',
      mrId: 1,
      targetBranch: 'main',
      comments: []
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
      url: 'http://gitlab.com/mr/1',
      summary: 'Fixed some bugs',
      repoName: 'test-group/test-repo',
      mrId: 1,
      targetBranch: 'main',
      comments: [
        { path: 'file.ts', line: 10, text: 'Typo here' }
      ]
    };

    await notifier.sendReviewNotification(payload);

    assert.strictEqual(fetchCalled, true);
    assert.strictEqual(fetchUrl, 'http://webhook.url');
    assert.strictEqual(fetchOptions.method, 'POST');
    
    const body = JSON.parse(fetchOptions.body);
    assert.ok(body.cardsV2);
    assert.strictEqual(body.cardsV2[0].card.header.title, payload.title);
    assert.strictEqual(body.cardsV2[0].card.sections[0].widgets[0].decoratedText.text, `<b>${payload.repoName}</b>`);
    assert.strictEqual(body.cardsV2[0].card.sections[0].widgets[2].decoratedText.text, payload.author);
    assert.strictEqual(body.cardsV2[0].card.sections[1].widgets[1].decoratedText.text, '<b>1</b> issues detected');
    assert.strictEqual(body.cardsV2[0].card.sections[2].header, '🔍 Chi tiết các vấn đề');
    assert.strictEqual(body.cardsV2[0].card.sections[2].widgets[0].decoratedText.text, '📍 <code>file.ts</code>\nLine: <b>10</b>');
    assert.strictEqual(body.cardsV2[0].card.sections[2].widgets[1].textParagraph.text, 'Typo here');
  });

  it('should escape HTML characters and format markdown-like syntax', async () => {
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
      url: 'http://gitlab.com/mr/1',
      summary: 'Found **2** issues in <file>.',
      repoName: 'test-group/test-repo',
      mrId: 1,
      targetBranch: 'main',
      comments: [
        { path: 'test.ts', line: 5, text: 'Fix *this* part.' }
      ]
    };

    await notifier.sendReviewNotification(payload);

    const body = JSON.parse(fetchOptions.body);
    const card = body.cardsV2[0].card;
    
    assert.strictEqual(card.header.title, 'Review: &lt;script&gt;alert(1)&lt;/script&gt;');
    assert.strictEqual(card.sections[0].widgets[2].decoratedText.text, 'User &lt;user@example.com&gt;');
    assert.strictEqual(card.sections[1].widgets[0].textParagraph.text, 'Found <b>2</b> issues in &lt;file&gt;.');
    assert.strictEqual(card.sections[2].widgets[1].textParagraph.text, 'Fix <i>this</i> part.');
  });
});
