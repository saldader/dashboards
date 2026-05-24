// RunRec HQ — auth config.
// Flip 'enforce' to true ONLY after you've:
//   1. Run supabase/migrations/2026-05-19_runrec_hq_auth.sql
//   2. Saved the Slack OIDC client_id + client_secret in Supabase Auth Providers
//   3. Added https://saldader.github.io/dashboards/** to the Redirect URLs list
//
// Until then, leave enforce = false. The dashboards stay open like today,
// the login page still works (errors gracefully when you click Sign in),
// and the auth code is exercised so we know it works before locking the door.
window.__RUNREC_AUTH_CONFIG = {
  enforce: true
};
