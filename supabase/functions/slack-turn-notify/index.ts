// RunRec HQ — Slack turn-notification Edge Function
//
// Reads pending rows from public.slack_notification_queue, looks up the
// active owner's Slack ID via public.team_members, opens a DM, and posts:
//   "Hey {first name} — it's your turn on {task title}. {link}"
//
// Triggered by a Supabase Database Webhook on INSERT into the queue table,
// OR by cron every minute. Either works.
//
// Required env vars (set in Supabase Dashboard → Edge Functions → Secrets):
//   SLACK_BOT_TOKEN     — xoxb-... from the Slack app's OAuth & Permissions page
//   DASHBOARD_BASE_URL  — e.g. https://saldader.github.io/dashboards
//   SUPABASE_URL        — auto-injected by Supabase
//   SUPABASE_SERVICE_ROLE_KEY — auto-injected by Supabase

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// IMPORTANT: use the BOT token (xoxb). Confirmed empirically that bot DMs
// reliably trigger iPhone push notifications, while user-token (xoxp) DMs do
// NOT push (a Slack quirk). Bot DMs appear under "Apps > RunRec HQ" rather
// than the normal DM list — an acceptable trade for a reliable ping.
const SLACK_TOKEN = Deno.env.get("SLACK_BOT_TOKEN")!;
const DASHBOARD_BASE_URL = Deno.env.get("DASHBOARD_BASE_URL") ?? "https://saldader.github.io/dashboards";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const sb = createClient(SUPABASE_URL, SERVICE_KEY);

async function slack<T = any>(method: string, body: Record<string, unknown>): Promise<T> {
  const r = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${SLACK_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  const json = await r.json();
  if (!json.ok) throw new Error(`slack ${method} failed: ${json.error ?? r.status}`);
  return json as T;
}

// ─────────────────────────────────────────────────────────────────────────
// One-tap auto-login link.
//
// Mints a fresh, single-use magic-link for THIS recipient via the GoTrue admin
// API (generate_link). Tapping it logs them in AND lands them on the task —
// zero typing, regardless of browser or session. This is the whole point: a
// teammate tapping "Open task" from a Slack mobile push opens Slack's in-app
// browser (an isolated webview with no prior session), so without this they'd
// hit the email-code wall every single time.
//
// CRITICAL: redirect_to MUST be a TOP-LEVEL field in the request body. If it is
// nested under `options` (the supabase-js client shape), the GoTrue admin
// endpoint ignores it and silently falls back to site_url — verified 2026-05-23.
// The redirect target must also match the project's URI allow-list (currently
// https://saldader.github.io/dashboards/**).
//
// Security: the link lands only in the user's private Slack DM, is single-use,
// and expires in ~1h (mailer_otp_exp=3600). Pings are timely, so a 1h TTL is
// ample. If minting fails for any reason, we fall back to the plain task URL
// (which still works — it just shows the login screen). Never blocks the send.
// ─────────────────────────────────────────────────────────────────────────
async function mintAutoLoginUrl(email: string, taskUrl: string): Promise<string | null> {
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
      },
      body: JSON.stringify({
        type: "magiclink",
        email,
        redirect_to: taskUrl, // TOP-LEVEL — see note above.
      }),
    });
    if (!r.ok) {
      console.error(`generate_link http ${r.status}: ${await r.text().catch(() => "")}`);
      return null;
    }
    const json = await r.json();
    const link = json?.action_link as string | undefined;
    if (!link) {
      console.error("generate_link: no action_link in response");
      return null;
    }
    return link;
  } catch (e) {
    console.error("mintAutoLoginUrl failed:", (e as Error).message ?? e);
    return null;
  }
}

async function processOne(row: {
  id: number;
  task_slug: string;
  task_title: string;
  owner_key: string;
}): Promise<void> {
  // Find the team member for this owner_key.
  const { data: members, error: mErr } = await sb
    .from("team_members")
    .select("slack_id, display_name, email")
    .eq("owner_key", row.owner_key)
    .limit(1);

  if (mErr) throw new Error(`team_members lookup: ${mErr.message}`);
  const member = members?.[0];
  if (!member || !member.slack_id) {
    // No slack_id yet (user hasn't signed in once). Mark as error and skip.
    await sb.from("slack_notification_queue")
      .update({ sent_at: new Date().toISOString(), error: "no slack_id mapped" })
      .eq("id", row.id);
    return;
  }

  // Open a DM channel with the user.
  const open = await slack<{ channel: { id: string } }>("conversations.open", {
    users: member.slack_id,
  });
  const channelId = open.channel.id;
  const taskUrl = `${DASHBOARD_BASE_URL}/task/?slug=${encodeURIComponent(row.task_slug)}`;
  const firstName = (member.display_name ?? row.owner_key).split(/\s+/)[0];

  // One-tap auto-login: mint a fresh magic link for this recipient that logs
  // them in AND lands on the task. Falls back to the plain task URL (which shows
  // the login screen) if the member has no email on file or minting fails.
  let buttonUrl = taskUrl;
  if (member.email) {
    const autoLogin = await mintAutoLoginUrl(member.email, taskUrl);
    if (autoLogin) buttonUrl = autoLogin;
  }

  // Best-effort enrichment with status + due date. Never blocks the send.
  let statusLabel = "";
  let dueLabel = "";
  try {
    const { data: t } = await sb
      .from("tasks")
      .select("status, due_date")
      .eq("slug", row.task_slug)
      .limit(1)
      .maybeSingle();
    const STATUS: Record<string, string> = {
      "not-started": "Not started",
      "in-progress": "In progress",
      "blocked": "Blocked",
      "done": "Done",
    };
    if (t?.status) statusLabel = STATUS[t.status as string] ?? String(t.status);
    if (t?.due_date) {
      dueLabel = new Date(`${t.due_date}T00:00:00`).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      });
    }
  } catch (_) {
    /* enrichment is optional */
  }

  const meta = [
    statusLabel ? `Status: *${statusLabel}*` : null,
    dueLabel ? `Due: *${dueLabel}*` : null,
  ].filter(Boolean).join("   ·   ");

  // Post the message. `text` is the lock-screen / push preview — keep it crisp.
  await slack("chat.postMessage", {
    channel: channelId,
    text: `🔔 Your turn — ${row.task_title}`,
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: `:bell:  *Your turn, ${firstName}*` },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${row.task_title}*${meta ? `\n${meta}` : ""}`,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Open task  →", emoji: true },
            url: buttonUrl,
            style: "primary",
          },
        ],
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "RunRec HQ  ·  open the task, then check your name off when you're done.",
          },
        ],
      },
    ],
  });

  await sb.from("slack_notification_queue")
    .update({ sent_at: new Date().toISOString(), error: null })
    .eq("id", row.id);
}

Deno.serve(async (_req: Request) => {
  const { data: rows, error } = await sb
    .from("slack_notification_queue")
    .select("id, task_slug, task_title, owner_key")
    .is("sent_at", null)
    .order("created_at", { ascending: true })
    .limit(25);

  if (error) return new Response(`queue read failed: ${error.message}`, { status: 500 });
  if (!rows || rows.length === 0) return new Response("nothing to send", { status: 200 });

  const results: { id: number; ok: boolean; error?: string }[] = [];
  for (const row of rows) {
    try {
      await processOne(row);
      results.push({ id: row.id, ok: true });
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      await sb.from("slack_notification_queue")
        .update({ sent_at: new Date().toISOString(), error: msg })
        .eq("id", row.id);
      results.push({ id: row.id, ok: false, error: msg });
    }
  }

  return new Response(JSON.stringify({ processed: results.length, results }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});
