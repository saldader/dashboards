# RunRec HQ — Supabase setup

These files are not auto-deployed by GitHub Pages. They live in the repo
so the migration history is versioned with the dashboard code.

## When you're ready (10 minutes total)

### 1. Run the auth migration

Open https://supabase.com/dashboard/project/ivdzpptjtwoxdaxsbsqz/sql/new
Paste `migrations/2026-05-19_runrec_hq_auth.sql` and click Run.

This creates:
- `team_members` table (Slack ID to owner_key mapping)
- Auto-sync trigger from `auth.users` to `team_members`
- Row-level security on `tasks` so only signed-in users can read or write
- `slack_notification_queue` table and trigger that captures every "your turn" event

### 2. Turn on Slack OIDC

Open https://supabase.com/dashboard/project/ivdzpptjtwoxdaxsbsqz/auth/providers
Find **Slack (OIDC)** in the list, enable it, paste:
- Client ID: `11166778209426.11151395559799`
- Client Secret: `6b36fa798b6864d62db2fb77d164ca5d`
Click Save.

Then in **URL Configuration**:
- Site URL: `https://saldader.github.io/dashboards/`
- Redirect URLs: add `https://saldader.github.io/dashboards/**`
Save.

After this step the login gate works end to end.

### 3. Deploy the Slack DM Edge Function

In the Slack app's **OAuth & Permissions** page, copy the **Bot User OAuth Token** (`xoxb-...`).

Then in Supabase:
- Edge Functions → Secrets → add `SLACK_BOT_TOKEN` with the value above
- Add `DASHBOARD_BASE_URL` = `https://saldader.github.io/dashboards`
- Deploy `functions/slack-turn-notify/index.ts` as a function named `slack-turn-notify`
- Database → Webhooks → Create webhook on `public.slack_notification_queue`
  - Event: INSERT
  - Type: Supabase Edge Function → `slack-turn-notify`

After this step, checking someone's name on a task DMs them in Slack instantly.
