import { AIReviewComment } from "./ai";
import { GitCommitInfo } from "./workspace";

export interface NotificationPayload {
  title: string;
  author: string;
  url: string;
  summary: string;
  repoName: string;
  mrId: number;
  targetBranch: string;
  verdict?: ("APPROVE" | "REQUEST_CHANGES" | "COMMENT") | undefined;
  riskLevel?: ("LOW" | "MEDIUM" | "HIGH") | undefined;
  comments: AIReviewComment[];
  commits?: GitCommitInfo[] | undefined;
  verificationNote?: string | undefined;
}

export class GoogleChatNotifier {
  private webhookUrl: string | undefined;

  constructor() {
    this.webhookUrl = process.env.GOOGLE_CHAT_WEBHOOK_URL;
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  private formatSummary(text: string): string {
    let escaped = this.escapeHtml(text);
    // Convert **bold** to <b>bold</b>
    escaped = escaped.replace(/\*\*(.*?)\*\*/g, "<b>$1</b>");
    // Convert *italic* to <i>italic</i>
    escaped = escaped.replace(/\*(.*?)\*/g, "<i>$1</i>");
    // Convert `code` to <code>code</code>
    escaped = escaped.replace(/`([^`]+)`/g, "<code>$1</code>");
    return escaped;
  }

  private getVerdictBadge(verdict?: string): string {
    switch (verdict) {
      case "APPROVE":
        return "✅ <b>APPROVE</b> (Code đạt chuẩn)";
      case "REQUEST_CHANGES":
        return "❌ <b>REQUEST CHANGES</b> (Cần sửa lỗi trước khi merge)";
      case "COMMENT":
      default:
        return "💬 <b>COMMENT</b> (Có một số góp ý)";
    }
  }

  private getRiskBadge(risk?: string): string {
    switch (risk) {
      case "HIGH":
        return "🚨 <b>HIGH RISK</b>";
      case "MEDIUM":
        return "⚠️ <b>MEDIUM RISK</b>";
      case "LOW":
      default:
        return "🟢 <b>LOW RISK</b>";
    }
  }

  private truncate(text: string, max: number): string {
    const t = text.trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
  }

  private issueWidgets(c: AIReviewComment): any[] {
    const widgets: any[] = [
      {
        decoratedText: {
          topLabel: `${this.escapeHtml(c.category)} · ${this.escapeHtml(c.path)}:${c.line}`,
          text: this.formatSummary(this.truncate(c.text, 900)),
          wrapText: true,
        },
      },
    ];
    if (c.suggestion && c.suggestion.trim()) {
      widgets.push({
        decoratedText: {
          topLabel: "💡 Gợi ý sửa",
          text: `<pre>${this.escapeHtml(this.truncate(c.suggestion, 500))}</pre>`,
          wrapText: true,
        },
      });
    }
    return widgets;
  }

  /** Dựng thẻ Cards V2 gọn: kết luận trên cùng, lỗi nặng trước, gợi ý/commits thu gọn. */
  public buildReviewCard(data: NotificationPayload): any {
    const bySeverity = (sev: string) =>
      data.comments.filter((c) => (c.severity || "SUGGESTION") === sev);
    const critical = bySeverity("CRITICAL");
    const warnings = bySeverity("WARNING");
    const suggestions = data.comments.filter(
      (c) => c.severity !== "CRITICAL" && c.severity !== "WARNING",
    );

    const counts =
      data.comments.length === 0
        ? "✅ Không phát hiện vấn đề nào"
        : [
            critical.length ? `🔴 <b>${critical.length}</b> nghiêm trọng` : "",
            warnings.length ? `🟡 <b>${warnings.length}</b> cảnh báo` : "",
            suggestions.length ? `🔵 <b>${suggestions.length}</b> gợi ý` : "",
          ]
            .filter(Boolean)
            .join("  ·  ");

    const overview: any[] = [
      {
        decoratedText: {
          topLabel: "Kết luận",
          text: `${this.getVerdictBadge(data.verdict)}<br>${this.getRiskBadge(data.riskLevel)}`,
          wrapText: true,
        },
      },
      { textParagraph: { text: this.formatSummary(data.summary) } },
      { textParagraph: { text: counts } },
    ];
    if (data.verificationNote) {
      overview.push({
        textParagraph: {
          text: `<i>🔎 ${this.escapeHtml(data.verificationNote)}</i>`,
        },
      });
    }
    overview.push({
      buttonList: {
        buttons: [
          {
            text: "Xem Merge Request",
            onClick: { openLink: { url: data.url } },
          },
        ],
      },
    });

    const sections: any[] = [{ widgets: overview }];

    // Chi tiết đầy đủ cho lỗi nặng và cảnh báo (giới hạn để thẻ không vượt cỡ cho phép của Chat)
    const MAX_DETAILED = 12;
    let budget = MAX_DETAILED;
    const addDetailed = (header: string, items: AIReviewComment[]) => {
      if (items.length === 0 || budget <= 0) return;
      const shown = items.slice(0, budget);
      budget -= shown.length;
      const widgets: any[] = [];
      shown.forEach((c, i) => {
        if (i > 0) widgets.push({ divider: {} });
        widgets.push(...this.issueWidgets(c));
      });
      if (shown.length < items.length) {
        widgets.push({
          textParagraph: {
            text: `<i>… và ${items.length - shown.length} vấn đề khác (xem log của reviewer)</i>`,
          },
        });
      }
      sections.push({ header: `${header} (${items.length})`, widgets });
    };
    addDetailed("🔴 Nghiêm trọng", critical);
    addDetailed("🟡 Cảnh báo", warnings);

    if (suggestions.length > 0) {
      sections.push({
        header: `🔵 Gợi ý (${suggestions.length})`,
        collapsible: true,
        uncollapsibleWidgetsCount: 0,
        widgets: suggestions.slice(0, 15).map((c) => ({
          textParagraph: {
            text: `<code>${this.escapeHtml(c.path)}:${c.line}</code> ${this.formatSummary(this.truncate(c.text, 200))}`,
          },
        })),
      });
    }

    if (data.commits && data.commits.length > 0) {
      sections.push({
        header: `📜 Commits (${data.commits.length})`,
        collapsible: true,
        uncollapsibleWidgetsCount: 0,
        widgets: [
          {
            textParagraph: {
              text: data.commits
                .slice(0, 8)
                .map(
                  (c) =>
                    `• <code>${this.escapeHtml(c.hash)}</code> ${this.escapeHtml(this.truncate(c.message, 100))}`,
                )
                .join("<br>"),
            },
          },
        ],
      });
    }

    return {
      cardsV2: [
        {
          cardId: "review-notification",
          card: {
            header: {
              title: this.escapeHtml(data.title),
              subtitle: `${data.repoName} · !${data.mrId} → ${data.targetBranch} · ${data.author}`,
            },
            sections,
          },
        },
      ],
    };
  }

  async sendReviewNotification(data: NotificationPayload): Promise<void> {
    if (!this.webhookUrl) {
      console.warn(
        "GOOGLE_CHAT_WEBHOOK_URL is not defined. Skipping notification.",
      );
      return;
    }

    const card = this.buildReviewCard(data);
    try {
      const response = await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify(card),
      });

      if (!response.ok) {
        throw new Error(`Google Chat API error: ${response.statusText}`);
      }
    } catch (error) {
      console.error("Failed to send Google Chat notification:", error);
    }
  }

  /** Báo khi review KHÔNG chạy được, để không nhầm với "code tốt". */
  async sendFailureNotification(data: {
    title: string;
    url: string;
    repoName: string;
    mrId: number;
    error: string;
  }): Promise<void> {
    if (!this.webhookUrl) {
      console.warn(
        "GOOGLE_CHAT_WEBHOOK_URL is not defined. Skipping failure notification.",
      );
      return;
    }

    const card = {
      cardsV2: [
        {
          cardId: "review-failure",
          card: {
            header: {
              title: this.escapeHtml(data.title),
              subtitle: "⚠️ AI Review KHÔNG chạy được - cần review thủ công",
            },
            sections: [
              {
                widgets: [
                  {
                    textParagraph: {
                      text: `<b>${this.escapeHtml(data.repoName)}</b> MR #${data.mrId}<br>Lỗi: <code>${this.escapeHtml(data.error.slice(0, 500))}</code>`,
                    },
                  },
                  {
                    buttonList: {
                      buttons: [
                        {
                          text: "Xem trên GitLab",
                          onClick: { openLink: { url: data.url } },
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        },
      ],
    };

    try {
      const response = await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify(card),
      });
      if (!response.ok) {
        throw new Error(`Google Chat API error: ${response.statusText}`);
      }
    } catch (error) {
      console.error("Failed to send Google Chat failure notification:", error);
    }
  }
}
