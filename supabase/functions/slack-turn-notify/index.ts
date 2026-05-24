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

  // Post the message.
  await slack("chat.postMessage", {
    channel: channelId,
    text: `Hey ${firstName} — your turn on *${row.task_title}*. <${taskUrl}|Open task>`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `Hey *${firstName}* — your turn on *${row.task_title}*.`,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Open task" },
            url: taskUrl,
            style: "primary",
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
