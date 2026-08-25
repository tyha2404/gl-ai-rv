# Google Chat Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Notify users via a Google Chat Space Card V2 when an AI code review is completed.

**Architecture:** Introduce `GoogleChatNotifier` in `src/notifier.ts` to handle Card V2 payload construction and HTTP delivery. Integrate it into `handleAIReview` in `src/index.ts`.

**Tech Stack:** TypeScript, Node.js (native `fetch` or `https`), Express.

---

### Task 1: Setup Environment and Configuration

**Files:**
- Modify: `.env.example`
- Modify: `src/notifier.ts` (Create new)

- [ ] **Step 1: Update .env.example with the new webhook variable**

```bash
# Add to .env.example
GOOGLE_CHAT_WEBHOOK_URL=your_google_chat_webhook_url
```

- [ ] **Step 2: Create src/notifier.ts with basic structure and config**

```typescript
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
```

- [ ] **Step 3: Commit configuration changes**

```bash
git add .env.example src/notifier.ts
git commit -m "feat: setup notifier configuration and class structure"
```

---

### Task 2: Implement Google Chat Card V2 Payload

**Files:**
- Modify: `src/notifier.ts`

- [ ] **Step 1: Implement Card V2 payload construction and POST request**

```typescript
// Inside GoogleChatNotifier class in src/notifier.ts

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
```

- [ ] **Step 2: Commit payload implementation**

```bash
git add src/notifier.ts
git commit -m "feat: implement Google Chat Card V2 payload and delivery"
```

---

### Task 3: Integrate Notifier into Webhook Flow

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Update src/index.ts to use GoogleChatNotifier**

```typescript
// Add import at the top
import { GoogleChatNotifier } from "./notifier";

// Instantiate notifier
const notifier = new GoogleChatNotifier();

// Update handleAIReview signature to accept more MR info
async function handleAIReview(
  projectId: number,
  iid: number,
  diffs: any[],
  diffRefs: any,
  mrInfo: { title: string; author: string; url: string } // Added
) {
  // ... existing logic ...
  try {
    // ... after posting comments and labels ...
    
    // Add notification at the end of successful review
    await notifier.sendReviewNotification({
      title: mrInfo.title,
      author: mrInfo.author,
      url: mrInfo.url,
      summary: reviewResult.summary,
      issueCount: reviewResult.comments.length,
    });

    console.log(`AI Review for MR #${iid} completed.`);
  } catch (error) {
    console.error("Error in handleAIReview:", error);
  }
}

// Update webhook handler to pass MR info
app.post("/webhook", async (req, res) => {
  // ...
  if (state === "opened") {
    try {
      const mr = await gitlab.getMergeRequest(projectId, iid);
      const diffs = await gitlab.getMergeRequestDiff(projectId, iid);

      res.status(200).send("Processing");
      
      handleAIReview(projectId, iid, diffs, mr.diff_refs, {
        title: mr.title,
        author: mr.author.name,
        url: mr.web_url,
      });
    } catch (error) {
      // ...
    }
  }
  // ...
});
```

- [ ] **Step 2: Commit integration**

```bash
git add src/index.ts
git commit -m "feat: integrate Google Chat notification into review flow"
```

---

### Task 4: Verification and Documentation

**Files:**
- Modify: `GEMINI.md`

- [ ] **Step 1: Update GEMINI.md with notification details**

```markdown
### Main Technologies
- ...
- **Notification:** Google Chat (Card V2 via Webhooks)

### Configuration
| Variable | Description | Default |
| :--- | :--- | :--- |
| ... | ... | ... |
| `GOOGLE_CHAT_WEBHOOK_URL` | The full webhook URL provided by Google Chat | |
```

- [ ] **Step 2: Final Commit**

```bash
git add GEMINI.md
git commit -m "docs: update GEMINI.md with notification details"
```
