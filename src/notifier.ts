import { AIReviewComment } from "./ai";

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

  private getSeverityBadge(severity: string): string {
    switch (severity) {
      case "CRITICAL":
        return "🔴 <b>CRITICAL</b>";
      case "WARNING":
        return "🟡 <b>WARNING</b>";
      case "SUGGESTION":
      default:
        return "🔵 <b>SUGGESTION</b>";
    }
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

  async sendReviewNotification(data: NotificationPayload): Promise<void> {
    if (!this.webhookUrl) {
      console.warn("GOOGLE_CHAT_WEBHOOK_URL is not defined. Skipping notification.");
      return;
    }

    const sections: any[] = [
      {
        header: "📋 Thông tin Merge Request",
        widgets: [
          {
            decoratedText: {
              topLabel: "Repository",
              text: `<b>${this.escapeHtml(data.repoName)}</b>`,
              startIcon: { knownIcon: "STAR" },
            },
          },
          {
            decoratedText: {
              topLabel: "Merge Request",
              text: `#${data.mrId} → <code>${this.escapeHtml(data.targetBranch)}</code>`,
              startIcon: { knownIcon: "DESCRIPTION" },
            },
          },
          {
            decoratedText: {
              topLabel: "Author",
              text: this.escapeHtml(data.author),
              startIcon: { knownIcon: "PERSON" },
            },
          },
        ],
      },
      {
        header: "🤖 AI Review Assessment",
        widgets: [
          {
            decoratedText: {
              topLabel: "Kết luận (Verdict)",
              text: this.getVerdictBadge(data.verdict),
              startIcon: { knownIcon: "CONFIRMATION_NUMBER_ICON" },
            },
          },
          {
            decoratedText: {
              topLabel: "Mức độ rủi ro (Risk Level)",
              text: this.getRiskBadge(data.riskLevel),
              startIcon: { knownIcon: "FLIGHT_DEPARTURE" },
            },
          },
          {
            textParagraph: {
              text: this.formatSummary(data.summary),
            },
          },
          {
            decoratedText: {
              topLabel: "Tổng số vấn đề phát hiện",
              text: `<b>${data.comments.length}</b> vấn đề`,
              startIcon: { knownIcon: "TICKET" },
            },
          },
        ],
      },
    ];

    // Add sections for each comment (limit to top 10)
    const displayComments = data.comments.slice(0, 10);
    if (displayComments.length > 0) {
      const commentWidgets: any[] = [];

      displayComments.forEach((c, index) => {
        const severityBadge = this.getSeverityBadge(c.severity || "SUGGESTION");
        const category = c.category ? `[${this.escapeHtml(c.category)}] ` : "";

        commentWidgets.push({
          decoratedText: {
            topLabel: `Issue #${index + 1} - ${category}${severityBadge}`,
            text: `📍 <code>${this.escapeHtml(c.path)}</code> (Line <b>${c.line}</b>)`,
            wrapText: true,
          },
        });

        commentWidgets.push({
          textParagraph: {
            text: this.formatSummary(c.text),
          },
        });

        if (c.suggestion && c.suggestion.trim()) {
          commentWidgets.push({
            decoratedText: {
              topLabel: "💡 Đề xuất code sửa đổi:",
              text: `<pre>${this.escapeHtml(c.suggestion.trim())}</pre>`,
              wrapText: true,
            },
          });
        }

        if (index < displayComments.length - 1) {
          commentWidgets.push({
            textParagraph: {
              text: "<br>---",
            },
          });
        }
      });

      sections.push({
        header: "🔍 Chi tiết vấn đề & Gợi ý sửa",
        widgets: commentWidgets,
      });
    }

    if (data.comments.length > 10) {
      sections.push({
        widgets: [
          {
            textParagraph: {
              text: `<i>... và còn ${data.comments.length - 10} vấn đề khác.</i>`,
            },
          },
        ],
      });
    }

    sections.push({
      widgets: [
        {
          buttonList: {
            buttons: [
              {
                text: "Xem trên GitLab",
                onClick: {
                  openLink: {
                    url: data.url,
                  },
                },
              },
            ],
          },
        },
      ],
    });

    const card = {
      cardsV2: [
        {
          cardId: "review-notification",
          card: {
            header: {
              title: this.escapeHtml(data.title),
              subtitle: "GitLab AI Code Review",
            },
            sections: sections,
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
      console.error("Failed to send Google Chat notification:", error);
    }
  }
}
