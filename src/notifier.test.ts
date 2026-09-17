import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { GoogleChatNotifier, NotificationPayload } from "./notifier";

describe("GoogleChatNotifier", () => {
  let originalFetch: any;

  before(() => {
    originalFetch = global.fetch;
  });

  after(() => {
    global.fetch = originalFetch;
  });

  it("should not throw if webhook URL is missing in constructor", () => {
    const oldUrl = process.env.GOOGLE_CHAT_WEBHOOK_URL;
    delete process.env.GOOGLE_CHAT_WEBHOOK_URL;
    const notifier = new GoogleChatNotifier();
    assert.strictEqual((notifier as any).webhookUrl, undefined);
    process.env.GOOGLE_CHAT_WEBHOOK_URL = oldUrl;
  });

  it("should log a warning if webhook URL is missing when sending notification", async () => {
    const oldUrl = process.env.GOOGLE_CHAT_WEBHOOK_URL;
    delete process.env.GOOGLE_CHAT_WEBHOOK_URL;
    const notifier = new GoogleChatNotifier();

    // Mock console.warn
    const originalWarn = console.warn;
    let warned = false;
    console.warn = () => {
      warned = true;
    };

    await notifier.sendReviewNotification({
      title: "Test",
      author: "Tester",
      url: "http://example.com",
      repoName: "test-repo",
      mrId: 1,
      targetBranch: "main",
      summary: "Test summary",
      comments: [],
    });

    console.warn = originalWarn;
    assert.strictEqual(warned, true);
    process.env.GOOGLE_CHAT_WEBHOOK_URL = oldUrl;
  });

  it("should send notification via fetch when webhook URL is present", async () => {
    process.env.GOOGLE_CHAT_WEBHOOK_URL = "http://webhook.url";
    const notifier = new GoogleChatNotifier();

    let fetchCalled = false;
    let fetchUrl = "";
    let fetchOptions: any = {};

    global.fetch = (async (url: string, options: any) => {
      fetchCalled = true;
      fetchUrl = url;
      fetchOptions = options;
      return { ok: true } as Response;
    }) as any;

    const payload: NotificationPayload = {
      title: "Merge Request Review",
      author: "John Doe",
      url: "http://gitlab.com/mr/1",
      repoName: "backend-service",
      mrId: 42,
      targetBranch: "develop",
      summary: "Fixed some bugs",
      verdict: "REQUEST_CHANGES",
      riskLevel: "HIGH",
      comments: [
        {
          path: "src/auth.ts",
          line: 10,
          severity: "CRITICAL",
          category: "SECURITY",
          text: "Hardcoded JWT secret",
          suggestion: "const secret = process.env.JWT_SECRET;",
        },
      ],
    };

    await notifier.sendReviewNotification(payload);

    assert.strictEqual(fetchCalled, true);
    assert.strictEqual(fetchUrl, "http://webhook.url");
    assert.strictEqual(fetchOptions.method, "POST");

    const body = JSON.parse(fetchOptions.body);
    assert.ok(body.cardsV2);
    assert.strictEqual(body.cardsV2[0].card.header.title, payload.title);
    assert.strictEqual(
      body.cardsV2[0].card.sections[0].widgets[0].decoratedText.text,
      "<b>backend-service</b>",
    );
    assert.strictEqual(
      body.cardsV2[0].card.sections[0].widgets[2].decoratedText.text,
      payload.author,
    );
    assert.ok(
      body.cardsV2[0].card.sections[1].widgets[0].decoratedText.text.includes(
        "REQUEST CHANGES",
      ),
    );
    assert.strictEqual(
      body.cardsV2[0].card.sections[2].header,
      "🔍 Chi tiết vấn đề & Gợi ý sửa (1)",
    );
  });

  it("should escape HTML characters and format markdown-like syntax", async () => {
    process.env.GOOGLE_CHAT_WEBHOOK_URL = "http://webhook.url";
    const notifier = new GoogleChatNotifier();

    let fetchOptions: any = {};
    global.fetch = (async (url: string, options: any) => {
      fetchOptions = options;
      return { ok: true } as Response;
    }) as any;

    const payload: NotificationPayload = {
      title: "Review: <script>alert(1)</script>",
      author: "User <user@example.com>",
      url: "http://gitlab.com/mr/1",
      repoName: "my<app>",
      mrId: 99,
      targetBranch: "feature/<login>",
      summary: "Found **2** issues in `<file>`.",
      comments: [
        {
          path: "test.ts",
          line: 5,
          severity: "WARNING",
          category: "BUG",
          text: "Fix *this* part.",
          suggestion: "const x = <tag>safe</tag>;",
        },
      ],
    };

    await notifier.sendReviewNotification(payload);

    const body = JSON.parse(fetchOptions.body);
    const card = body.cardsV2[0].card;

    assert.strictEqual(
      card.header.title,
      "Review: &lt;script&gt;alert(1)&lt;/script&gt;",
    );
    assert.strictEqual(
      card.sections[0].widgets[0].decoratedText.text,
      "<b>my&lt;app&gt;</b>",
    );
    assert.strictEqual(
      card.sections[0].widgets[2].decoratedText.text,
      "User &lt;user@example.com&gt;",
    );
    assert.strictEqual(
      card.sections[1].widgets[2].textParagraph.text,
      "Found <b>2</b> issues in <code>&lt;file&gt;</code>.",
    );
    assert.strictEqual(
      card.sections[2].widgets[1].textParagraph.text,
      "Fix <i>this</i> part.",
    );
    assert.strictEqual(
      card.sections[2].widgets[2].decoratedText.text,
      "<pre>const x = &lt;tag&gt;safe&lt;/tag&gt;;</pre>",
    );
  });

  it("should render commits and impact analysis section when provided", async () => {
    process.env.GOOGLE_CHAT_WEBHOOK_URL = "http://webhook.url";
    const notifier = new GoogleChatNotifier();

    let fetchOptions: any = {};
    global.fetch = (async (url: string, options: any) => {
      fetchOptions = options;
      return { ok: true } as Response;
    }) as any;

    const payload: NotificationPayload = {
      title: "Feature Refactor",
      author: "Alice",
      url: "http://gitlab.com/mr/10",
      repoName: "my-service",
      mrId: 10,
      targetBranch: "main",
      summary: "Refactored auth module",
      verdict: "APPROVE",
      riskLevel: "LOW",
      commits: [
        {
          hash: "1a2b3c4",
          message: "refactor auth token helper",
          author: "Alice",
        },
      ],
      impactReport: {
        modifiedSymbols: ["verifyToken"],
        impactedFiles: ["src/middleware/auth.ts", "src/routes/user.ts"],
        references: [],
        summary: "2 external files use verifyToken.",
      },
      comments: [],
    };

    await notifier.sendReviewNotification(payload);

    const body = JSON.parse(fetchOptions.body);
    const sections = body.cardsV2[0].card.sections;

    // Check MR info widgets contains commits widget
    const mrInfoWidgets = sections[0].widgets;
    assert.strictEqual(mrInfoWidgets.length, 4);
    assert.ok(mrInfoWidgets[3].decoratedText.text.includes("1a2b3c4"));

    // Check Impact section exists
    const impactSection = sections.find((s: any) =>
      s.header?.includes("Phạm vi ảnh hưởng"),
    );
    assert.ok(impactSection);
    assert.ok(
      impactSection.widgets[0].textParagraph.text.includes("2 external files"),
    );
    assert.ok(
      impactSection.widgets[1].decoratedText.text.includes(
        "src/middleware/auth.ts",
      ),
    );
  });
});
