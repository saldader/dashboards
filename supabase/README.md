# RunRec HQ — Supabase setup

These files live in the repo so the database migration history is versioned
alongside the dashboard code. GitHub Pages does **not** serve this folder.

> ⚠️ **This repo is public. Never put secrets in it** — no API keys, tokens, or
> client secrets. All secrets belong in the Supabase dashboard
> (Edge Functions → Secrets) or the operator's keychain.

## Project

- **RunRec HQ** Supabase project: `ivdzpptjtwoxdaxsbsqz`
- The **booking system** is a *separate* Supabase project — nothing here touches it.

## Setup steps

### 1. Run the auth migration

In the HQ project's SQL editor, run
`migrations/2026-05-19_runrec_hq_auth.sql`.

This creates:
- `team_members` table (email → owner_key → slack_id mapping)
- Auto-sync trigger from `auth.users` → `team_members`
- Row-level security on `tasks` (only signed-in team can read/write)
- `slack_notification_queue` table + trigger that fires on every "your turn" event

### 2. Turn on Email (magic-link) login

Authentication → Providers → enable **Email** with magic-link on.
Under URL Configuration:
- Site URL: `https://saldader.github.io/dashboards/`
- Redirect URLs: `https://saldader.github.io/dashboards/**`

For reliable delivery, configure SMTP so links send from an `@therunrec.com`
address (Google Workspace).

> We use **email magic-link**, not Slack login — nobody has to connect their
> Slack account to sign in. Slack is used only to *deliver notifications*
> (step 3). This avoids any lock-in to Slack for authentication.

### 3. Deploy the Slack DM Edge Function

Slack is the notification channel. Use a Slack app with a **bot token**
(`xoxb-…`) that has scopes: `chat:write`, `im:write`, `users:read`,
`users:read.email`.

In Supabase:
- Edge Functions → Secrets → add `SLACK_BOT_TOKEN` (the `xoxb-…` token) and
  `DASHBOARD_BASE_URL` = `https://saldader.github.io/dashboards`
- Deploy `functions/slack-turn-notify/index.ts` as a function named `slack-turn-notify`
- Database → Webhooks → on `public.slack_notification_queue` INSERT →
  Supabase Edge Function → `slack-turn-notify`

After this, when a task becomes someone's turn, that person gets a Slack DM.

### 4. Map each teammate to their Slack

The notifier matches people by **email**. Ensure every `team_members` row has
the correct `slack_id`. For anyone whose login email differs from their Slack
email, set `slack_id` manually once.
