export interface NotificationPayload {
  title: string;
  author: string;
  url: string;
  summary: string;
  issueCount: number;
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

    const card = {
      cardsV2: [
        {
          cardId: "review-notification",
          card: {
            header: {
              title: this.escapeHtml(data.title),
              subtitle: "AI Review Completed",
            },
            sections: [
              {
                widgets: [
                  {
                    decoratedText: {
                      topLabel: "Author",
                      text: this.escapeHtml(data.author),
                      startIcon: { knownIcon: "PERSON" },
                    },
                  },
                  {
                    decoratedText: {
                      topLabel: "Issues Found",
                      text: `${data.issueCount}`,
                      startIcon: { knownIcon: "DESCRIPTION" },
                    },
                  },
                ],
              },
              {
                header: "AI Summary",
                widgets: [
                  {
                    textParagraph: {
                      text: this.formatSummary(data.summary),
                    },
                  },
                ],
              },
              {
                widgets: [
                  {
                    buttonList: {
                      buttons: [
                        {
                          text: "View on GitLab",
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
      console.error("Failed to send Google Chat notification:", error);
    }
  }
}
