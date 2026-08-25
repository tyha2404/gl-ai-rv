# GitLab AI Reviewer

Automated code reviews for GitLab Merge Requests powered by AI (Requesty AI / Gemma).

## Project Overview

This project provides a webhook service that listens for GitLab Merge Request events. When a new Merge Request is opened (or updated), it fetches the code diffs, sends them to an AI model for analysis, and posts the results as comments and a summary back to the GitLab Merge Request. It also sends a summary notification to Google Chat.

### Main Technologies

- **Language:** TypeScript
- **Server:** Express
- **GitLab Integration:** `@gitbeaker/rest`
- **AI Integration:** `openai` SDK (connecting to Requesty AI / Gemma model)
- **Notifications:** Google Chat (Cards V2)
- **Runtime:** Node.js

### Architecture

- `src/index.ts`: The entry point. Sets up the Express server and handles the `/webhook` endpoint. It orchestrates the review process by coordinating between the GitLab and AI clients.
- `src/gitlab.ts`: `GitLabClient` class for interacting with the GitLab API (fetching MR data, diffs, posting notes/comments, and managing labels).
- `src/ai.ts`: `AIClient` class for interacting with the AI model. It prepares prompts, sends diffs to Requesty AI, and parses the JSON response.
- `src/notifier.ts`: `GoogleChatNotifier` class for sending review summaries and issue counts to Google Chat via webhooks using the Cards V2 format.

## Building and Running

### Prerequisites

- Node.js (version supported by TypeScript/Express)
- A GitLab account and Personal Access Token
- A Requesty AI API Key
- A Google Chat Webhook URL (for notifications)

### Configuration

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

| Variable                   | Description                                         | Default                         |
| :------------------------- | :-------------------------------------------------- | :------------------------------ |
| `GITLAB_URL`               | The base URL of your GitLab instance                | `https://gitlab.com`            |
| `GITLAB_TOKEN`             | Your GitLab Personal Access Token                   |                                 |
| `REQUESTY_API_KEY`         | Your Requesty AI API Key                            |                                 |
| `REQUESTY_BASE_URL`        | Base URL of Requesty AI Router                      | `https://router.requesty.ai/v1/`|
| `REQUESTY_MODEL`           | Model to use for review                             | `google/gemma-4-31b-it`         |
| `REQUESTY_EMBEDDING_MODEL` | Embedding model                                     | `embedding-3`                   |
| `PORT`                     | The port the server will listen on                  | `3000`                          |
| `GOOGLE_CHAT_WEBHOOK_URL`  | The webhook URL for Google Chat notifications       |                                 |

### Commands

- **Start Production:** `npm start`
- **Start Development:** `npm run dev` (auto-reloads on file changes)
- **Test:** `npm test` (Note: Basic tests for notifier are implemented)

## Development Conventions

- **Language:** TypeScript is used for all source files in `src/`.
- **Typing:** Strict type-checking is enabled in `tsconfig.json`.
- **Response Format:** The AI is instructed to return a JSON object containing a `summary` and an array of `comments`.
- **Filtering:** Certain files (e.g., lockfiles, `.env`, `node_modules`) are excluded from the AI review via `IGNORED_FILES` in `src/index.ts`.
- **Fallback Mechanism:** If a line-specific comment fails to post (usually due to diff context changes), it falls back to a general MR comment.
- **Labels:** Successfully reviewed MRs are tagged with an `AI-Reviewed` label.
