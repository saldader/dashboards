// RunRec HQ — shared auth helper.
// Loaded on every page. Enforces sign-in via Supabase + Slack OIDC.
// Pages that should be public (currently just /login/) set window.__RUNREC_PUBLIC = true
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

  async function init(){
    await loadSupabaseSdk();
    const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: true }
    });
    window.RUNREC = window.RUNREC || {};
    window.RUNREC.supabase = client;

    const { data: { session } } = await client.auth.getSession();
    const isPublic = !!window.__RUNREC_PUBLIC;

    if(!session && !isPublic){
      // Not authenticated, redirect to the gate.
      location.replace(LOGIN_URL);
      return;
    }
    if(session && isPublic){
      // Already signed in, skip the gate.
      location.replace(BASE);
      return;
    }
    if(session){
      window.RUNREC.session = session;
      window.RUNREC.user = session.user;
      decorateHeader(session.user);
    }
    document.documentElement.classList.add('runrec-auth-ready');
    // Fire a custom event so page scripts can wait for auth.
    document.dispatchEvent(new CustomEvent('runrec:auth-ready', { detail: { session } }));
  }

  function decorateHeader(user){
    // Tries to add a sign-out button next to the brand mark.
    document.addEventListener('DOMContentLoaded', () => {
      const brand = document.querySelector('.brand');
      if(!brand) return;
      if(brand.querySelector('.runrec-userchip')) return;
      const chip = document.createElement('div');
      chip.className = 'runrec-userchip';
      chip.style.cssText = 'margin-left:auto;display:flex;align-items:center;gap:8px;font-size:12px;color:#aaa;';
      const name = (user.user_metadata && (user.user_metadata.name || user.user_metadata.full_name)) || user.email || 'Signed in';
      chip.innerHTML = `<span title="${name}">${name}</span><button type="button" id="runrec-signout" style="background:transparent;border:1px solid rgba(255,255,255,0.15);color:#ccc;padding:4px 10px;border-radius:6px;font-size:11px;cursor:pointer;">Sign out</button>`;
      // Brand is usually inside a parent that uses flex; inject the chip after the brand so it sits on the right.
      if(brand.parentElement) brand.parentElement.appendChild(chip);
      else document.body.appendChild(chip);
      const btn = chip.querySelector('#runrec-signout');
      btn.addEventListener('click', async () => {
        await window.RUNREC.supabase.auth.signOut();
        location.replace(LOGIN_URL);
      });
    });
  }

  // Boot
  init().catch(err => {
    console.error('[auth] init failed', err);
    if(!window.__RUNREC_PUBLIC) location.replace(LOGIN_URL);
  });
})();
