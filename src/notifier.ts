export interface NotificationPayload {
  title: string;
  author: string;
  url: string;
  summary: string;
  repoName: string;
  mrId: number;
  targetBranch: string;
  comments: {
    path: string;
    line: number;
    text: string;
    suggestion?: string;
  }[];
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
    // Escape first
    let escaped = this.escapeHtml(text);
    // Convert **bold** to <b>bold</b>
    escaped = escaped.replace(/\*\*(.*?)\*\*/g, "<b>$1</b>");
    // Convert *italic* to <i>italic</i>
    escaped = escaped.replace(/\*(.*?)\*/g, "<i>$1</i>");
    return escaped;
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
        header: "🤖 AI Summary",
        widgets: [
          {
            textParagraph: {
              text: this.formatSummary(data.summary),
            },
          },
          {
            decoratedText: {
              topLabel: "Issues Found",
              text: `<b>${data.comments.length}</b> issues detected`,
              startIcon: { knownIcon: "TICKET" },
            },
          },
        ],
      },
    ];

    // Add sections for each comment (limit to top 10 to avoid payload limits)
    const displayComments = data.comments.slice(0, 10);
    if (displayComments.length > 0) {
      const commentWidgets: any[] = [];
      
      displayComments.forEach((c, index) => {
        // Path and Line on its own line for readability
        commentWidgets.push({
          decoratedText: {
            topLabel: `Issue #${index + 1}`,
            text: `📍 <code>${this.escapeHtml(c.path)}</code>\nLine: <b>${c.line}</b>`,
            wrapText: true,
          }
        });

        // The actual comment text
        commentWidgets.push({
          textParagraph: {
            text: this.formatSummary(c.text)
          }
        });

        // Suggestion if available, in a code block style
        if (c.suggestion) {
          commentWidgets.push({
            decoratedText: {
              topLabel: "Gợi ý sửa đổi:",
              text: `<code>${this.escapeHtml(c.suggestion)}</code>`,
              wrapText: true,
            }
          });
        }

        // Add a small divider text if not the last item
        if (index < displayComments.length - 1) {
          commentWidgets.push({
            textParagraph: {
              text: "<br>---"
            }
          });
        }
      });

      sections.push({
        header: "🔍 Chi tiết các vấn đề",
        widgets: commentWidgets,
      });
    }

    if (data.comments.length > 10) {
      sections.push({
        widgets: [
          {
            textParagraph: {
              text: `<i>... và ${data.comments.length - 10} vấn đề khác. Vui lòng kiểm tra trên GitLab.</i>`,
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
              subtitle: "AI Review Completed",
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
