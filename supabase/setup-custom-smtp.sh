#!/usr/bin/env bash
# RunRec HQ — configure reliable login email via custom SMTP (Resend).
#
# WHY: Supabase's built-in emailer is rate-limited (2 emails/hour, project-wide),
# so login codes get throttled and the team would be blocked at rollout. Custom
# SMTP removes that cap. This switches the auth emailer to Resend and raises the
# email rate limit. It does NOT change the login flow (still email one-time CODE,
# verifyOtp type:'email', shouldCreateUser:false, disable_signup=true).
#
# OPERATOR STEP (the only manual part — ~2 minutes):
#   1. Go to https://resend.com  → sign up (free).
#   2. API Keys → Create API Key → copy it (starts with "re_").
#   3. Run:  ~/aos/core/bin/cli/agent-secret set RESEND_API_KEY <paste-key>
#   4. Run this script:  bash supabase/setup-custom-smtp.sh
#
# Sends from onboarding@resend.dev immediately (no domain verification needed).
# To send from login@therunrec.com later, verify the domain in Resend and set
# SMTP_SENDER below to that address, then re-run.
#
# No secrets live in this file — the API key is read from the macOS Keychain.

set -euo pipefail

PROJECT_REF="ivdzpptjtwoxdaxsbsqz"   # HQ project (NEVER the booking project)
SMTP_HOST="smtp.resend.com"
SMTP_PORT="465"
SMTP_USER="resend"
SMTP_SENDER="onboarding@resend.dev" # works with no domain verification
SMTP_ADMIN_EMAIL="sal@therunrec.com"
SMTP_SENDER_NAME="RunRec HQ"
RATE_LIMIT_EMAIL_SENT="100"          # per hour; ample for a 5-person team

ACCESS_TOKEN="$(~/aos/core/bin/cli/agent-secret get SUPABASE_ACCESS_TOKEN)"
RESEND_KEY="$(~/aos/core/bin/cli/agent-secret get RESEND_API_KEY 2>/dev/null || true)"

if [ -z "${RESEND_KEY:-}" ]; then
  echo "ERROR: RESEND_API_KEY not found in keychain."
  echo "Run: ~/aos/core/bin/cli/agent-secret set RESEND_API_KEY <your re_... key>"
  exit 1
fi

echo "Configuring custom SMTP (Resend) on project ${PROJECT_REF}..."

RESP="$(curl -s -X PATCH \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "User-Agent: Mozilla/5.0" \
  -H "Content-Type: application/json" \
  "https://api.supabase.com/v1/projects/${PROJECT_REF}/config/auth" \
  -d "{
    \"smtp_host\": \"${SMTP_HOST}\",
    \"smtp_port\": \"${SMTP_PORT}\",
    \"smtp_user\": \"${SMTP_USER}\",
    \"smtp_pass\": \"${RESEND_KEY}\",
    \"smtp_sender_name\": \"${SMTP_SENDER_NAME}\",
    \"smtp_admin_email\": \"${SMTP_SENDER}\",
    \"rate_limit_email_sent\": ${RATE_LIMIT_EMAIL_SENT}
  }")"

# smtp_admin_email is the FROM address Supabase sends as. Resend requires the
# from-address to be your verified sender; onboarding@resend.dev is pre-verified.
echo "$RESP" | python3 -c "
import sys, json
d = json.load(sys.stdin)
if isinstance(d, dict) and 'message' in d and 'smtp_host' not in d:
    print('FAILED:', d['message']); sys.exit(1)
print('OK — custom SMTP applied.')
print('  smtp_host           =', d.get('smtp_host'))
print('  smtp_port           =', d.get('smtp_port'))
print('  smtp_user           =', d.get('smtp_user'))
print('  smtp_admin_email    =', d.get('smtp_admin_email'))
print('  smtp_sender_name    =', d.get('smtp_sender_name'))
print('  rate_limit_email_sent =', d.get('rate_limit_email_sent'))
"

echo ""
echo "Done. Test: open the login page, request a code with a team email, confirm delivery."
