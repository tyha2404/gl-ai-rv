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
    const card = body.cardsV2[0].card;
    assert.ok(card.header.subtitle.includes("backend-service"));
    assert.ok(card.header.subtitle.includes("!42"));
    assert.ok(card.header.subtitle.includes("John Doe"));
    assert.ok(
      card.sections[0].widgets[0].decoratedText.text.includes(
        "REQUEST CHANGES",
      ),
    );
    // dòng tổng kết số lượng theo mức độ
    assert.ok(
      card.sections[0].widgets[2].textParagraph.text.includes("nghiêm trọng"),
    );
    assert.strictEqual(card.sections[1].header, "🔴 Nghiêm trọng (1)");
  });

  it("should escape HTML characters and format markdown-like syntax", async () => {
    process.env.GOOGLE_CHAT_WEBHOOK_URL = "http://webhook.url";
    const notifier = new GoogleChatNotifier();

    let fetchOptions: any = {};
    global.fetch = (async (_url: string, options: any) => {
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
      card.sections[0].widgets[1].textParagraph.text,
      "Found <b>2</b> issues in <code>&lt;file&gt;</code>.",
    );
    // WARNING nằm ở section thứ 2; widget đầu là nội dung đã escape/format
    assert.strictEqual(card.sections[1].header, "🟡 Cảnh báo (1)");
    assert.strictEqual(
      card.sections[1].widgets[0].decoratedText.text,
      "Fix <i>this</i> part.",
    );
    assert.strictEqual(
      card.sections[1].widgets[1].decoratedText.text,
      "<pre>const x = &lt;tag&gt;safe&lt;/tag&gt;;</pre>",
    );
  });

  it("should collapse suggestions and commits, order by severity, and cap detailed issues", () => {
    const notifier = new GoogleChatNotifier();
    const mk = (n: number, severity: any, category: any = "CLEAN_CODE") => ({
      path: `src/f${n}.ts`,
      line: n,
      severity,
      category,
      text: `vấn đề ${n}`,
    });
    const comments = [
      mk(1, "SUGGESTION"),
      ...Array.from({ length: 20 }, (_, i) => mk(i + 2, "WARNING")),
      mk(99, "CRITICAL", "BUG"),
    ];
    const card = notifier.buildReviewCard({
      title: "T",
      author: "A",
      url: "http://gitlab.com/mr/10",
      repoName: "svc",
      mrId: 10,
      targetBranch: "main",
      summary: "ok",
      verdict: "REQUEST_CHANGES",
      riskLevel: "HIGH",
      verificationNote: "Claude phát hiện 5",
      commits: [{ hash: "1a2b3c4", message: "refactor", author: "A" }],
      comments,
    }).cardsV2[0].card;

    const headers = card.sections.map((s: any) => s.header);
    assert.deepStrictEqual(headers, [
      undefined,
      "🔴 Nghiêm trọng (1)",
      "🟡 Cảnh báo (20)",
      "🔵 Gợi ý (1)",
      "📜 Commits (1)",
    ]);
    // 1 critical + 11 warning được hiển thị chi tiết, phần còn lại có dòng tóm tắt
    const warnSection = card.sections[2];
    const last = warnSection.widgets[warnSection.widgets.length - 1];
    assert.ok(last.textParagraph.text.includes("và 9 vấn đề khác"));
    assert.strictEqual(card.sections[3].collapsible, true);
    assert.strictEqual(card.sections[4].collapsible, true);
    assert.ok(
      card.sections[0].widgets.some((w: any) =>
        w.textParagraph?.text.includes("Claude phát hiện 5"),
      ),
    );
    assert.ok(JSON.stringify(card).length < 30000);
  });

  it("should show an all-clear message when there are no issues", () => {
    const notifier = new GoogleChatNotifier();
    const card = notifier.buildReviewCard({
      title: "T",
      author: "A",
      url: "u",
      repoName: "r",
      mrId: 1,
      targetBranch: "main",
      summary: "tốt",
      verdict: "APPROVE",
      riskLevel: "LOW",
      comments: [],
    }).cardsV2[0].card;
    assert.strictEqual(card.sections.length, 1);
    assert.ok(
      card.sections[0].widgets[2].textParagraph.text.includes(
        "Không phát hiện",
      ),
    );
  });
});
