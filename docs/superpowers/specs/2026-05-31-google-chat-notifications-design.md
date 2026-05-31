# Design Spec: Google Chat Notifications for AI Code Review

- **Status:** Draft
- **Author:** Gemini CLI
- **Date:** 2026-05-31

## 1. Overview
The goal is to notify users via Google Chat once an AI code review of a GitLab Merge Request is complete. This provides a proactive notification channel, reducing the need for users to manually check GitLab for the review results.

## 2. Requirements
- Send a notification to a Google Chat Space via a Webhook URL.
- The notification must be visually structured (Card V2).
- The notification must include:
    - MR Title
    - MR Author name
    - Link to the MR
    - AI-generated summary of the review
    - Number of issues/comments found

## 3. Architecture
A new component `GoogleChatNotifier` will be introduced to handle the formatting and delivery of messages.

### Components
- `src/notifier.ts`: Contains the `GoogleChatNotifier` class.
- `src/index.ts`: Updated to trigger the notification after `handleAIReview` successfully completes its tasks.

### Data Flow
1. `index.ts` receives GitLab webhook.
2. `handleAIReview` processes the review.
3. After posting comments/labels to GitLab, `index.ts` calls `notifier.sendReviewNotification(...)`.
4. `GoogleChatNotifier` constructs a Card V2 JSON payload.
5. `GoogleChatNotifier` sends a POST request to the configured `GOOGLE_CHAT_WEBHOOK_URL`.

## 4. Detailed Design

### Google Chat Card Structure
- **Header:**
    - Title: Merge Request Title
    - Subtitle: "AI Review Completed"
    - Icon: GitLab icon (if possible) or a generic document icon.
- **Section 1: Metadata**
    - Key/Value: **Author**: `<Author Name>`
    - Key/Value: **Issues Found**: `<Count>`
- **Section 2: AI Summary**
    - Text: `<Summary from AIClient>`
- **Section 3: Actions**
    - Button: "View on GitLab" (Link to MR URL)

### Environment Variables
- `GOOGLE_CHAT_WEBHOOK_URL`: The full webhook URL provided by Google Chat.

## 5. Implementation Plan (High Level)
1. Add `GOOGLE_CHAT_WEBHOOK_URL` to `.env.example`.
2. Create `src/notifier.ts` with the Card V2 payload logic using `fetch` or `axios` (or native `https`).
3. Update `src/index.ts`:
    - Extract `author` name and `web_url` from the webhook payload.
    - Instantiate `GoogleChatNotifier`.
    - Call the notify method at the end of `handleAIReview`.
4. Add error handling to ensure failing notifications don't crash the service.

## 6. Testing Strategy
- Mock the Google Chat Webhook URL to verify the payload structure.
- Perform a manual test by triggering a webhook event (or using a sample payload).
