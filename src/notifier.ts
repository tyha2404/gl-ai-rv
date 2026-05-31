import dotenv from "dotenv";

dotenv.config();

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
    // Implementation in next task
  }
}
