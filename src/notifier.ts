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
              title: data.title,
              subtitle: "AI Review Completed",
              imageUrl: "https://fonts.gstatic.com/s/i/googlematerialicons/description/v11/24px.svg",
              imageType: "CIRCLE",
            },
            sections: [
              {
                widgets: [
                  {
                    decoratedText: {
                      topLabel: "Author",
                      text: data.author,
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
                      text: data.summary,
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
