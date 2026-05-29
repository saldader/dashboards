// RunRec HQ — shared auth helper.
// Loaded on every page. Enforces sign-in via Supabase email OTP (one-time code)
// and supports one-tap auto-login links (magic links minted per-recipient in the
// Slack ping). detectSessionInUrl:true picks up the session from the URL fragment
// that an auto-login link lands with, so tapping "Open task" logs you in with zero
// typing — even inside Slack's isolated in-app browser.
// Pages that should be public (currently just /login/, and the standalone
// /eyad-prospectus/ which omits this script) set window.__RUNREC_PUBLIC = true
// BEFORE this script loads.

(function(){
  const SUPABASE_URL = 'https://ivdzpptjtwoxdaxsbsqz.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_CLEzGz8hR3Z2cioPFSSu-g_33VtSdDb';

  // Compute the base path of /dashboards/ regardless of where this loads from.
  function dashboardsBase(){
    const p = location.pathname;
    const i = p.indexOf('/dashboards/');
    return i >= 0 ? p.slice(0, i + '/dashboards/'.length) : '/';
  }
  const BASE = dashboardsBase();
  const LOGIN_URL = BASE + 'login/';

  function loadSupabaseSdk(){
    return new Promise((resolve, reject) => {
      if(window.supabase && window.supabase.createClient){ resolve(); return; }
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error('supabase-js failed to load'));
      document.head.appendChild(s);
    });
  }

  // Hard switch: when this is true, the dashboards REQUIRE a Slack sign-in.
  // Flip to true after the Supabase Slack OIDC provider is configured.
  // Source of truth lives at /dashboards/assets/js/auth-config.js (a separate
  // file so flipping the flag is a one-line change, not a multi-file edit).
  async function loadConfig(){
    try {
      await new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = BASE + 'assets/js/auth-config.js';
        s.onload = res;
        s.onerror = res;  // missing config = treat as defaults
        document.head.appendChild(s);
      });
    } catch(_){}
    return Object.assign({ enforce: false }, window.__RUNREC_AUTH_CONFIG || {});
  }

  async function init(){
    const cfg = await loadConfig();
    await loadSupabaseSdk();
    const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: true }
    });
    window.RUNREC = window.RUNREC || {};
    window.RUNREC.supabase = client;

    const { data: { session } } = await client.auth.getSession();
    const isPublic = !!window.__RUNREC_PUBLIC;

    if(cfg.enforce){
      if(!session && !isPublic){ location.replace(LOGIN_URL); return; }
      if(session && isPublic){ location.replace(BASE); return; }
    }
    if(session){
      window.RUNREC.session = session;
      window.RUNREC.user = session.user;
      decorateHeader(session.user);
    }
    document.documentElement.classList.add('runrec-auth-ready');
    // Fire a custom event so page scripts can wait for auth.
    document.dispatchEvent(new CustomEvent('runrec:auth-ready', { detail: { session, enforced: cfg.enforce } }));
  }

  function decorateHeader(user){
    // Adds a sign-out button next to the brand mark. By the time auth resolves,
    // init() has already awaited the SDK load + a network round-trip, so
    // DOMContentLoaded has almost always fired — a listener added now would never
    // run. So build immediately when the DOM is ready, and only wait otherwise.
    const build = () => {
      const brand = document.querySelector('.brand');
      if(!brand) return;
      if(brand.querySelector('.runrec-userchip')) return;
      const chip = document.createElement('div');
      chip.className = 'runrec-userchip';
      chip.style.cssText = 'margin-left:auto;display:flex;align-items:center;gap:8px;font-size:12px;color:#aaa;';
      const name = (user.user_metadata && (user.user_metadata.name || user.user_metadata.full_name)) || user.email || 'Signed in';
      // Build via textContent (not innerHTML) so a hostile display name can't inject markup.
      const nameSpan = document.createElement('span');
      nameSpan.title = name;
      nameSpan.textContent = name;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'runrec-signout';
      btn.style.cssText = 'background:transparent;border:1px solid rgba(255,255,255,0.15);color:#ccc;padding:4px 10px;border-radius:6px;font-size:11px;cursor:pointer;';
      btn.textContent = 'Sign out';
      chip.appendChild(nameSpan);
      chip.appendChild(btn);
      // Brand is usually inside a parent that uses flex; inject the chip after the brand so it sits on the right.
      if(brand.parentElement) brand.parentElement.appendChild(chip);
      else document.body.appendChild(chip);
      btn.addEventListener('click', async () => {
        await window.RUNREC.supabase.auth.signOut();
        location.replace(LOGIN_URL);
      });
    };
    if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build, { once:true });
    else build();
  }

  // Boot
  init().catch(err => {
    console.error('[auth] init failed', err);
    if(!window.__RUNREC_PUBLIC) location.replace(LOGIN_URL);
  });
})();
