# TikTok Mental Health Chatbot 🤖💚

A TikTok direct messaging chatbot built with Node.js and deployed on Vercel. The bot provides mental health support to users via TikTok DMs, with AI-powered responses, automatic fallback handling, risk classification, and daily reporting.


## What it does

- Responds to TikTok DMs using an AI chatbot as the primary responder
- Automatically falls back to a secondary AI (Dify) if the primary AI is unavailable
- Classifies each user message as `high risk`, `moderate risk`, or `low risk` in the background
- Logs all conversations to Google Sheets including the risk tag and timestamp
- Sends a daily email report of all high risk messages
- Automatically refreshes TikTok API tokens daily via a cron job

---

## Tech Stack

- **Runtime:** Node.js
- **Hosting:** Vercel (serverless)
- **Primary AI:** AIBot (via Directus flow triggers)
- **Fallback AI + Tagging:** Dify
- **Session Storage:** Redis (Redis Cloud)
- **Logging:** Google Sheets API
- **Token Management:** TikTok OAuth2
- **Email:** Nodemailer (Gmail SMTP)
- **Cron Jobs:** Vercel cron

---

## How it works

1. User sends a TikTok DM to the bot account
2. TikTok sends a webhook event to the Vercel endpoint
3. The bot checks for duplicates, static triggers, and routes to the AI
4. Primary AI (AIBot) responds via two Directus flow triggers
5. If AIBot fails, Dify takes over as fallback
6. Reply is sent back to the user via TikTok message API
7. In the background, Dify classifies the message risk level
8. Everything is logged to Google Sheets
9. Every night at 11:59pm, a daily email report is sent for all high risk messages

---

## Environment Variables

Create a `.env` file with the following:

```
# TikTok
TIKTOK_CLIENT_ID=
TIKTOK_CLIENT_SECRET=

# Directus / AIBot
CREATE_CHAT_URL=
SEND_MESSAGE_URL=

# Dify
DIFY_API_URL=
DIFY_API_KEY=
DIFY_TAGGING_API_KEY=

# Redis
REDIS_URL=

# Google Sheets
GOOGLE_CLIENT_EMAIL=
GOOGLE_PRIVATE_KEY=
SPREADSHEET_ID=

# Gmail (for daily report)
GMAIL_EMAIL=
GMAIL_PASSWORD=
ALERT_EMAIL=
```

---

## Setup Guide

### 1. TikTok API
- Create a TikTok Business API app at https://business-api.tiktok.com/portal
- Set the webhook URL to `https://your-vercel-url/api/webhook`
- Generate the initial access token using `index.html` (OAuth callback page)
- Save `tiktok_access_token` and `tiktok_refresh_token` to Redis manually

### 2. Redis
- Create a free Redis Cloud instance at https://app.redislabs.com
- Copy the connection URL to `REDIS_URL`

### 3. AIBot & Directus (Primary AI)
AIBot:
AIBot is a government platform for creating AI chatbots, access requires a government account. You can create a new bot on AIBot with your desired system prompt and knowledge base.

Directus:
Directus is used as a bridge to access AIBot outside the government network.
You need someone with access to a Directus instance to create two flow triggers:

Flow 1 — Create Chat

Method: POST
- Trigger: Webhook
- Action: calls AIBot's create chat API
- Returns: { "id": "<chat_id>" }

Flow 2 — Send Message

Method: POST
- Trigger: Webhook
- Action: calls AIBot's send message API with chat_id and content
- Returns: { "response": { "content": "<ai_reply>" } }
- Once created, copy both flow trigger URLs into webhook.js as CREATE_CHAT_URL and SEND_MESSAGE_URL

Note: AIBot is only accessible if you are from a government agency and connected to a government-approved network. If you are not on the government network or do not have a government account, you will not be able to access AIBot. In that case, you can use Dify as both the primary and fallback bot, simply point all AI calls to Dify and remove the AIBot/Directus setup entirely.

### 4. Dify
- Create two bots at https://cloud.dify.ai
  - **Main fallback bot** — same system prompt as your primary AI
  - **Tagging bot** — use this system prompt:
    ```
    You are a risk classifier. Given a user message, classify it as one of three risk levels:
    - high risk: user is in danger, suicidal, or in crisis
    - moderate risk: user is distressed, anxious, or struggling
    - low risk: user is generally okay, asking questions, or casual
    
    Reply with ONLY one of these exact three options: "high risk", "moderate risk", "low risk". No other words.
    ```
- Copy the API keys to `DIFY_API_KEY` and `DIFY_TAGGING_API_KEY`

### 5. Google Sheets
- Create a Google Sheet with a tab called `Raw_data`
- Add these headers in row 1: `Chat ID | User ID | User Message | AI Response | Timestamp | Tag`
- Create a Google Service Account at https://console.cloud.google.com
- Enable the Google Sheets API
- Download the JSON key and copy `client_email` and `private_key` to env vars
- Share the sheet with the service account email (Editor access)
- Copy the sheet ID from the URL to `SPREADSHEET_ID`

### 6. Gmail (for daily report)
- Enable 2FA on your Gmail account
- Go to myaccount.google.com → Security → App passwords
- Generate an app password and copy it to `GMAIL_PASSWORD` (remove spaces)
- Set `GMAIL_EMAIL` to your Gmail address
- Set `ALERT_EMAIL` to the recipient email

### 7. Deploy to Vercel
- Connect your GitHub repo to Vercel
- Add all environment variables in Vercel dashboard → Settings → Environment Variables
- Deploy — Vercel will auto-deploy on every push to `main`

---

## Cron Jobs

Configured in `vercel.json`:

| Job | Schedule | Time (SGT) | Purpose |
|---|---|---|---|
| `/api/refresh-token` | `0 19 * * *` | 3:00am | Refresh TikTok access token |
| `/api/daily-risk-report` | `59 15 * * *` | 11:59pm | Send high risk email report |

---

## Testing

**Test the bot:** Send a DM to your TikTok account

**Test the daily report manually:**
```
https://your-vercel-url/api/daily-risk-report
```

**Test token refresh manually:**
```
https://your-vercel-url/api/refresh-token
```

---

## Key Features

- **Deduplication** — Redis locks prevent the same message being processed twice
- **Fallback handling** — seamless switch to Dify if primary AI goes down
- **Context recovery** — when primary AI comes back up, missed messages are replayed
- **Async processing** — risk tagging and logging happen in background, never slowing user response
- **Session management** — conversation history stored in Redis, expires after 6 hours

---

## Notes

- TikTok access tokens expire every 24 hours — handled automatically by the cron job
- TikTok refresh tokens expire after 1 year — requires manual reauthorization
- Conversation history expires after 6 hours of inactivity
- Vercel free (Hobby) plan supports up to 100 cron jobs but each can only run once per day

---

Does this look good? Now shall we compile the full Care Corner README into the Word document?
