/* =============================================================
   Sales OS — sidecar JS

   Architecture:
   - API base = http://127.0.0.1:8765 (Sales OS Flask service on Mac Mini)
   - Hooks the dashboard's showSection() so Sales OS sections lazy-load
   - State held in module-level `state` object
   - All fetches gracefully degrade if backend is down
   ============================================================= */
(function () {
  'use strict';

  // ---------------------------------------------------------------
  // API host resolution
  // The Sales OS dashboard runs in three places:
  //   1. Mac Mini directly         http://127.0.0.1:8765/         → API='' (same-origin)
  //   2. file:// (debug)            file:///.../index.html         → API=localhost
  //   3. GitHub Pages public        saldader.github.io/...        → API=Tailscale URL
  //
  // The Tailscale URL only resolves for devices on Sal's tailnet; outsiders get
  // a connection failure and the Sales OS group auto-hides.
  // To override (e.g. on a different tailnet), set localStorage.sosApiHost.
  // ---------------------------------------------------------------
  // HTTPS via `tailscale serve` (port 443 → 127.0.0.1:8765 on Mac Mini)
  const TAILSCALE_BACKEND = 'https://agents-mac-mini-2.taila0423e.ts.net';
  const override = (typeof localStorage !== 'undefined') ? localStorage.getItem('sosApiHost') : null;
  let API;
  if (override) {
    API = override.replace(/\/$/, '');
  } else if (location.protocol === 'file:') {
    API = 'http://127.0.0.1:8765';
  } else if (location.hostname === '127.0.0.1' || location.hostname === 'localhost' || location.hostname.endsWith('.ts.net')) {
    API = '';   // same-origin (Mac Mini direct or Tailscale)
  } else {
    API = TAILSCALE_BACKEND;   // GitHub Pages → reach into tailnet
  }

  const state = {
    queue: [],
    selectedId: null,
    contact: null,
    pipeline: null,
    scorecard: null,
    pendingCoaching: [],
    logBusy: false,
    pollerStarted: false,
  };

  // ---------------------------------------------------------------
  // Tiny DOM helpers
  // ---------------------------------------------------------------
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const el = (tag, attrs, children) => {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null) continue;
        if (k === 'class') node.className = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else node.setAttribute(k, v);
      }
    }
    if (children) {
      (Array.isArray(children) ? children : [children]).forEach(c => {
        if (c == null) return;
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      });
    }
    return node;
  };
  const fmtPhone = (p) => {
    if (!p) return '';
    const d = p.replace(/\D/g, '').slice(-10);
    if (d.length !== 10) return p;
    return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  };
  const relTime = (iso) => {
    if (!iso) return 'Never';
    const t = new Date(iso).getTime();
    if (isNaN(t)) return iso;
    const diffH = (Date.now() - t) / 3600000;
    if (diffH < 1) return `${Math.max(1, Math.round(diffH * 60))}m ago`;
    if (diffH < 24) return `${Math.round(diffH)}h ago`;
    return `${Math.round(diffH / 24)}d ago`;
  };
  const fmtDate = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
  };

  // ---------------------------------------------------------------
  // API
  // ---------------------------------------------------------------
  async function api(path, opts) {
    try {
      const resp = await fetch(API + path, Object.assign({
        headers: { 'Content-Type': 'application/json' },
      }, opts || {}));
      if (!resp.ok) {
        const txt = await resp.text();
        throw new Error(`${resp.status}: ${txt}`);
      }
      return await resp.json();
    } catch (e) {
      console.warn('[sos] api failed', path, e);
      return null;
    }
  }

  // ---------------------------------------------------------------
  // Queue render
  // ---------------------------------------------------------------
  async function loadQueue() {
    const data = await api('/queue?limit=100');
    if (!data) {
      $('#sos-queue').innerHTML = '<div class="sos-row-empty">Sales OS service offline.<br>Start: <code>~/.aos/services/sales-os/.venv/bin/python ~/.aos/services/sales-os/server.py</code></div>';
      $('#sos-queue-count').textContent = '';
      return;
    }
    state.queue = data.queue || [];
    $('#sos-queue-count').textContent = state.queue.length || '';
    renderQueue();
  }

  function renderQueue() {
    const root = $('#sos-queue');
    if (!root) return;
    root.innerHTML = '';
    if (!state.queue.length) {
      root.appendChild(el('div', { class: 'sos-row-empty', html:
        'No leads in the queue right now.<br>Run the puller / ranker, or wait for fresh signals.' }));
      return;
    }
    state.queue.forEach(c => {
      const row = el('div', {
        class: 'sos-row' + (c.id === state.selectedId ? ' active' : ''),
        dataset: { id: c.id },
        onclick: () => selectContact(c.id),
      }, [
        el('div', { class: `sos-pill ${c.call_signal || 'lapsed'}`, title: c.call_signal || '' }),
        el('div', { class: 'sos-row-main' }, [
          el('div', { class: 'sos-row-name', html:
            (c.name ? c.name : 'Unknown') +
            ` <span class="sos-row-phone">${fmtPhone(c.phone)}</span>` }),
          el('div', { class: 'sos-row-reason' }, c.signal_reason || ''),
        ]),
        el('div', { class: 'sos-row-meta' }, [
          el('div', {}, c.last_called_by_us ? `Called ${relTime(c.last_called_by_us)}` : 'Never called'),
          c.bookings_last_14d ? el('div', {}, `${c.bookings_last_14d} bookings/14d`) : null,
        ].filter(Boolean)),
      ]);
      root.appendChild(row);
    });
    // Auto-select first row if none selected
    if (!state.selectedId && state.queue.length) {
      selectContact(state.queue[0].id);
    }
  }

  // ---------------------------------------------------------------
  // Contact panel
  // ---------------------------------------------------------------
  async function selectContact(id) {
    state.selectedId = id;
    // Update active row
    $$('.sos-row').forEach(r => r.classList.toggle('active', Number(r.dataset.id) === id));
    const data = await api(`/contact/${id}`);
    if (!data) return;
    state.contact = data;
    renderContact();
  }

  function renderContact() {
    const root = $('#sos-contact');
    if (!root) return;
    if (!state.contact) {
      root.innerHTML = '<div class="sos-contact-empty">Select a contact from the queue.<br>Use <kbd>j</kbd>/<kbd>k</kbd> to navigate, <kbd>Enter</kbd> to open.</div>';
      return;
    }
    const c = state.contact.contact;
    root.innerHTML = '';

    // Header
    const head = el('div', { class: 'sos-contact-head' }, [
      el('div', { style: 'flex:1' }, [
        el('div', { class: 'sos-contact-name' }, c.name || 'Unknown'),
        el('a', {
          class: 'sos-contact-phone',
          href: `tel:${c.phone}`,
          title: 'Click to dial via Quo',
        }, fmtPhone(c.phone) + ' ↗'),
        el('div', { class: 'sos-contact-tags' }, [
          c.is_member ? el('span', { class: 'sos-tag member' }, 'MEMBER') : null,
          c.call_signal && c.call_signal !== 'none'
            ? el('span', { class: 'sos-tag signal' }, c.call_signal.replace('_', ' '))
            : null,
          c.do_not_call ? el('span', { class: 'sos-tag', style: 'color:var(--red)' }, 'DNC') : null,
        ].filter(Boolean)),
        c.signal_reason ? el('div', {
          style: 'margin-top:8px;font-size:12.5px;color:var(--text-3)',
        }, c.signal_reason) : null,
      ]),
    ]);
    root.appendChild(head);

    // Bookings
    if (state.contact.bookings.length) {
      const sec = el('div', { class: 'sos-section' });
      sec.appendChild(el('div', { class: 'sos-section-title' },
        `Booking history (${state.contact.bookings.length})`));
      state.contact.bookings.slice(0, 5).forEach(b => {
        sec.appendChild(el('div', { class: 'sos-history-row' }, [
          el('div', { class: 'sos-h-date' }, fmtDate(b.start_time)),
          el('div', { class: 'sos-h-detail' },
            `${b.sport || 'Court'} · ${b.booking_type || 'Standard'} · ${b.status || 'completed'}`),
          el('div', { class: 'sos-h-amount' }, b.amount != null ? `$${b.amount.toFixed(0)}` : ''),
        ]));
      });
      root.appendChild(sec);
    }

    // Calls
    if (state.contact.calls.length) {
      const sec = el('div', { class: 'sos-section' });
      sec.appendChild(el('div', { class: 'sos-section-title' },
        `Call history (${state.contact.calls.length})`));
      state.contact.calls.slice(0, 8).forEach(call => {
        const callRow = el('div', { class: 'sos-call-row' });
        callRow.appendChild(el('div', { class: 'sos-call-meta' }, [
          el('span', {}, fmtDate(call.called_at) + ' · ' +
            (call.direction === 'incoming' ? '📥 In' : '📤 Out') +
            ' · ' + (call.duration_sec || 0) + 's' +
            ' · ' + (call.status || '')),
        ]));
        if (call.summary) {
          callRow.appendChild(el('div', { class: 'sos-call-summary' }, call.summary));
        }
        if (call.transcript) {
          const toggle = el('span', { class: 'sos-call-toggle',
            onclick: () => callRow.classList.toggle('expanded') }, 'Transcript ▼');
          callRow.appendChild(toggle);
          callRow.appendChild(el('div', { class: 'sos-call-transcript' }, call.transcript));
        }
        sec.appendChild(callRow);
      });
      root.appendChild(sec);
    }

    // Recent activities (Izzy's logged calls)
    if (state.contact.activities.length) {
      const sec = el('div', { class: 'sos-section' });
      sec.appendChild(el('div', { class: 'sos-section-title' }, 'Logged calls'));
      state.contact.activities.slice(0, 5).forEach(a => {
        sec.appendChild(el('div', { class: 'sos-history-row' }, [
          el('div', { class: 'sos-h-date' }, fmtDate(a.logged_at)),
          el('div', { class: 'sos-h-detail' },
            `${a.outcome || ''} · ${a.disposition || ''}` +
            (a.notes ? ` · ${a.notes.slice(0, 60)}` : '')),
          el('div', { class: 'sos-h-amount' },
            a.follow_up_at ? `→ ${fmtDate(a.follow_up_at)}` : ''),
        ]));
      });
      root.appendChild(sec);
    }

    // Notes (editable)
    const notesSec = el('div', { class: 'sos-section' });
    notesSec.appendChild(el('div', { class: 'sos-section-title' }, 'Notes'));
    const ta = el('textarea', {
      placeholder: 'Sticky notes about this contact…',
      style: 'width:100%;min-height:60px;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:8px 10px;border-radius:6px;font-size:13px;font-family:inherit;resize:vertical',
      onblur: async () => {
        await api(`/contact/${c.id}/notes`, { method: 'POST', body: JSON.stringify({ notes: ta.value }) });
      },
    });
    ta.value = c.notes || '';
    notesSec.appendChild(ta);
    root.appendChild(notesSec);

    // Log form
    root.appendChild(buildLogForm(c.id));
  }

  // ---------------------------------------------------------------
  // Log form (the closing-deals friction-killer)
  // ---------------------------------------------------------------
  function buildLogForm(contactId) {
    const log = el('div', { class: 'sos-log' });
    log.appendChild(el('div', { class: 'sos-log-title' }, 'Log this call'));

    const formState = {
      outcome: null,
      disposition: null,
      pitched: false,
      followUpAt: '',
      followUpSkipped: false,
      notes: '',
    };

    // Outcome buttons
    const outcomeRow = el('div', { class: 'sos-log-row' });
    const outcomes = [
      { v: 'spoke', label: 'Spoke' },
      { v: 'left_voicemail', label: 'Voicemail' },
      { v: 'no_answer', label: 'No answer' },
      { v: 'closed', label: '✓ Closed', cls: 'closed' },
      { v: 'not_interested', label: 'Not interested' },
    ];
    outcomes.forEach(o => {
      outcomeRow.appendChild(el('button', {
        class: `sos-log-btn ${o.cls || ''}`,
        dataset: { outcome: o.v },
        onclick: () => {
          formState.outcome = o.v;
          $$('.sos-log-btn[data-outcome]', log).forEach(b => b.classList.remove('active'));
          outcomeRow.querySelector(`[data-outcome="${o.v}"]`).classList.add('active');
          updateNextBtn();
        },
      }, o.label));
    });
    log.appendChild(outcomeRow);

    // Disposition + pitched
    const dispRow = el('div', { class: 'sos-log-row' });
    const dispSel = el('select', {
      onchange: (e) => { formState.disposition = e.target.value; },
    });
    [
      ['', 'Disposition…'],
      ['will_think', 'Will think'],
      ['not_now', 'Not now'],
      ['wrong_number', 'Wrong number'],
      ['callback', 'Callback scheduled'],
      ['dnc', 'Do not call'],
    ].forEach(([v, label]) => dispSel.appendChild(el('option', { value: v }, label)));
    dispRow.appendChild(dispSel);

    const pitchedLabel = el('label', { class: 'sos-log-skip', style: 'background:var(--card);padding:7px 10px;border-radius:6px;border:1px solid var(--border)' }, [
      el('input', {
        type: 'checkbox',
        onchange: (e) => { formState.pitched = e.target.checked; },
      }),
      'Pitched membership',
    ]);
    dispRow.appendChild(pitchedLabel);
    log.appendChild(dispRow);

    // Follow-up — REQUIRED
    const fuRow = el('div', { class: 'sos-log-followup-row' });
    fuRow.appendChild(el('div', { class: 'sos-log-followup-label', html:
      'Next follow-up<span class="sos-log-followup-required">*</span>' }));
    const fuInput = el('input', {
      type: 'datetime-local',
      onchange: (e) => {
        formState.followUpAt = e.target.value;
        formState.followUpSkipped = false;
        skipBox.checked = false;
        updateNextBtn();
      },
    });
    // Default to tomorrow 10am
    const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
    tomorrow.setHours(10, 0, 0, 0);
    fuInput.value = tomorrow.toISOString().slice(0, 16);
    formState.followUpAt = fuInput.value;
    fuRow.appendChild(fuInput);

    const skipLabel = el('label', { class: 'sos-log-skip' });
    const skipBox = el('input', {
      type: 'checkbox',
      onchange: (e) => {
        formState.followUpSkipped = e.target.checked;
        if (e.target.checked) {
          formState.followUpAt = '';
          fuInput.value = '';
        }
        updateNextBtn();
      },
    });
    skipLabel.appendChild(skipBox);
    skipLabel.appendChild(document.createTextNode('No follow-up needed'));
    fuRow.appendChild(skipLabel);
    log.appendChild(fuRow);

    // Notes
    const noteRow = el('div', { class: 'sos-log-row' });
    noteRow.appendChild(el('textarea', {
      placeholder: '1-line note (optional but recommended)…',
      onchange: (e) => { formState.notes = e.target.value; },
    }));
    log.appendChild(noteRow);

    // CTA
    const cta = el('div', { class: 'sos-log-cta' });
    const nextBtn = el('button', {
      class: 'sos-log-next',
      disabled: true,
      onclick: () => submitLog(contactId, formState, nextBtn, statusEl),
    }, 'Log + Next →');
    cta.appendChild(nextBtn);
    const statusEl = el('div', { class: 'sos-log-status' }, '');
    cta.appendChild(statusEl);
    log.appendChild(cta);

    function updateNextBtn() {
      const ok = formState.outcome && (formState.followUpAt || formState.followUpSkipped);
      nextBtn.disabled = !ok;
    }
    log.__updateNextBtn = updateNextBtn;
    log.__formState = formState;

    return log;
  }

  async function submitLog(contactId, formState, nextBtn, statusEl) {
    if (state.logBusy) return;
    state.logBusy = true;
    nextBtn.disabled = true;
    statusEl.textContent = 'Saving…';
    const payload = {
      contact_id: contactId,
      outcome: formState.outcome,
      disposition: formState.disposition,
      pitched_membership: formState.pitched,
      notes: formState.notes,
      follow_up_at: formState.followUpAt || null,
      follow_up_skipped: formState.followUpSkipped,
    };
    const resp = await api('/log', { method: 'POST', body: JSON.stringify(payload) });
    state.logBusy = false;
    if (!resp || !resp.ok) {
      statusEl.textContent = 'Save failed';
      nextBtn.disabled = false;
      return;
    }
    statusEl.textContent = '✓ Saved';
    // Advance to next contact
    setTimeout(() => {
      const idx = state.queue.findIndex(c => c.id === contactId);
      const next = state.queue[idx + 1];
      if (next) selectContact(next.id);
      loadQueue();   // Refresh signal_rank may have shifted
      loadScorecardStrip();
    }, 350);
  }

  // ---------------------------------------------------------------
  // Scorecard strip (top of Today)
  // ---------------------------------------------------------------
  async function loadScorecardStrip() {
    const data = await api('/scorecard');
    if (!data) return;
    state.scorecard = data;
    renderScorecardStrip();
  }

  function renderScorecardStrip() {
    const root = $('#sos-strip');
    if (!root || !state.scorecard) return;
    const snap = state.scorecard.snapshot || {};
    const live = state.scorecard.live || {};
    const target = state.scorecard.target_total || 85;
    const closes = snap.closes_total || 0;
    const remaining = target - closes;
    const pct = Math.min(100, Math.round((closes / target) * 100));
    const pace = snap.pace_actual_per_week || 0;
    const need = snap.pace_needed_per_week || 0;
    const onTrack = pace >= need;
    const trackCls = onTrack ? 'on-track' : (need - pace > 1.5 ? 'danger' : 'behind');

    root.innerHTML = '';
    root.appendChild(card('Progress', `${closes}<span class="sos-strip-target"> / ${target}</span>`,
      `${remaining} to go · ${snap.weeks_remaining || '?'} wks left`,
      progressBar(pct, trackCls)));
    root.appendChild(card("Today's calls", `${live.calls_today || 0}`,
      `${live.closes_today || 0} closed today`));
    root.appendChild(card('This week', `${live.calls_7d || 0}`,
      `${live.closes_7d || 0} closed`));
    root.appendChild(card('Pace', `${pace}<span class="sos-strip-target"> / ${need}</span>`,
      onTrack ? 'On pace' : `Need +${(need - pace).toFixed(1)}/wk`,
      null, trackCls));
    root.appendChild(card('Close rate (30d)', `${Math.round((snap.close_rate_30d || 0) * 100)}%`,
      `${Math.round((snap.connect_rate_30d || 0) * 100)}% connect`));

    function card(label, valueHtml, meta, extra, metaCls) {
      const c = el('div', { class: 'sos-strip-cell' });
      c.appendChild(el('div', { class: 'sos-strip-label' }, label));
      c.appendChild(el('div', { class: 'sos-strip-value', html: valueHtml }));
      if (meta) c.appendChild(el('div', { class: `sos-strip-meta ${metaCls || ''}` }, meta));
      if (extra) c.appendChild(extra);
      return c;
    }
    function progressBar(pct, cls) {
      const bar = el('div', { class: 'sos-progress' });
      bar.appendChild(el('div', { class: `sos-progress-fill ${cls}`, style: `width:${pct}%` }));
      return bar;
    }
  }

  // ---------------------------------------------------------------
  // Pipeline
  // ---------------------------------------------------------------
  async function loadPipeline() {
    const data = await api('/pipeline');
    if (!data) {
      $('#sos-pipeline-board').innerHTML = '<div class="sos-row-empty">Service offline.</div>';
      return;
    }
    state.pipeline = data;
    renderPipeline();
  }

  function renderPipeline() {
    const root = $('#sos-pipeline-board');
    if (!root) return;
    const stages = ['committed', 'pitched', 'contacted', 'closed_won', 'closed_lost', 'not_called'];
    const labels = {
      committed: 'Committed',
      pitched: 'Pitched',
      contacted: 'Contacted',
      closed_won: 'Closed Won',
      closed_lost: 'Closed Lost',
      not_called: 'Not Called',
    };
    const grouped = {};
    stages.forEach(s => grouped[s] = []);
    (state.pipeline.pipeline || []).forEach(r => {
      const s = grouped[r.stage] ? r.stage : 'not_called';
      grouped[s].push(r);
    });

    root.innerHTML = '';
    stages.forEach(s => {
      const col = el('div', { class: 'sos-stage-col' });
      col.appendChild(el('div', { class: 'sos-stage-head' }, [
        el('span', {}, labels[s]),
        el('span', { class: 'sos-stage-count' }, String(grouped[s].length)),
      ]));
      if (!grouped[s].length) {
        col.appendChild(el('div', { class: 'sos-stage-empty' }, '—'));
      } else {
        grouped[s].slice(0, 30).forEach(r => {
          const card = el('div', {
            class: 'sos-stage-card',
            onclick: () => {
              // Switch to Today and select
              if (window.showSection) window.showSection('sos-today');
              selectContact(r.id);
            },
          }, [
            el('div', { class: 'sc-name' }, r.name || fmtPhone(r.phone) || 'Unknown'),
            el('div', { class: 'sc-meta' }, [
              el('div', {}, r.signal_reason || labels[s]),
              r.next_follow_up
                ? el('div', { style: 'color:var(--sos)' }, `↻ ${fmtDate(r.next_follow_up)}`)
                : (r.last_activity ? el('div', {}, `Last: ${relTime(r.last_activity)}`) : null),
            ].filter(Boolean)),
          ]);
          col.appendChild(card);
        });
      }
      root.appendChild(col);
    });
  }

  // ---------------------------------------------------------------
  // Full scorecard view
  // ---------------------------------------------------------------
  async function loadScorecardFull() {
    const data = await api('/scorecard');
    if (!data) return;
    renderScorecardFull(data);
  }

  function renderScorecardFull(data) {
    const root = $('#sos-scorecard-full');
    if (!root) return;
    const s = data.snapshot || {};
    const live = data.live || {};
    const target = data.target_total || 85;
    const closes = s.closes_total || 0;
    const remaining = target - closes;
    const pace = s.pace_actual_per_week || 0;
    const need = s.pace_needed_per_week || 0;
    const onTrack = pace >= need;
    const trackCls = onTrack ? '' : (need - pace > 1.5 ? 'danger' : 'behind');

    root.innerHTML = '';
    const grid = el('div', { class: 'sos-sc-grid' });
    grid.appendChild(scCard('Closes', closes, `of ${target} target · ${remaining} remaining`));
    grid.appendChild(scCard('This week', live.calls_7d || 0, `${live.closes_7d || 0} closed`));
    grid.appendChild(scCard('Today', live.calls_today || 0, `${live.closes_today || 0} closed`));
    grid.appendChild(scCard('Connect rate (30d)', `${Math.round((s.connect_rate_30d || 0) * 100)}%`,
      'spoke ÷ dialed'));
    grid.appendChild(scCard('Pitch rate (30d)', `${Math.round((s.pitch_rate_30d || 0) * 100)}%`,
      'pitched ÷ spoke'));
    grid.appendChild(scCard('Close rate (30d)', `${Math.round((s.close_rate_30d || 0) * 100)}%`,
      'closed ÷ pitched'));
    root.appendChild(grid);

    const pace_card = el('div', { class: `sos-sc-pace ${trackCls}` });
    pace_card.appendChild(el('div', { class: 'sos-sc-label' }, 'Pace toward 85 by Dec 1'));
    pace_card.appendChild(el('div', { class: 'sos-sc-num' },
      `${pace.toFixed(2)} / week · need ${need.toFixed(2)} / week`));
    pace_card.appendChild(el('div', { class: 'sos-sc-meta' },
      `${s.weeks_remaining || '?'} weeks remaining · ` +
      (onTrack ? '🟢 On track' : `🟡 Behind by ${(need - pace).toFixed(2)} closes/week`)));
    root.appendChild(pace_card);

    function scCard(label, num, meta) {
      const c = el('div', { class: 'sos-sc-card' });
      c.appendChild(el('div', { class: 'sos-sc-label' }, label));
      c.appendChild(el('div', { class: 'sos-sc-num' }, String(num)));
      if (meta) c.appendChild(el('div', { class: 'sos-sc-meta' }, meta));
      return c;
    }
  }

  // ---------------------------------------------------------------
  // After-Call Card poller
  // ---------------------------------------------------------------
  async function pollCoaching() {
    const data = await api('/coaching/pending');
    if (!data || !data.pending || !data.pending.length) {
      hideCoachingCard();
      return;
    }
    state.pendingCoaching = data.pending;
    showCoachingCard(data.pending[0]);
  }

  function showCoachingCard(c) {
    const root = $('#sos-coaching-card');
    if (!root) return;
    const ratio = c.talk_ratio_izzy_pct;
    const ratioCls = ratio == null ? '' :
      (ratio > 60 ? 'bad' : ratio > 50 ? 'warn' : 'good');
    const nextStepCls = c.next_step_stated ? 'good' : 'bad';

    let objStr = '';
    try {
      const arr = JSON.parse(c.objections_hit || '[]');
      objStr = arr.length ? arr.join(', ') : '—';
    } catch (e) { objStr = c.objections_hit || '—'; }

    root.innerHTML = '';
    root.classList.remove('hidden');
    root.appendChild(el('div', { class: 'sos-coach-head' }, [
      el('span', { class: 'sos-coach-pulse' }),
      'After-Call Coaching',
    ]));
    root.appendChild(el('div', { class: 'sos-coach-meta' },
      `${c.contact_name || fmtPhone(c.contact_phone) || 'Unknown'} · ${fmtDate(c.called_at)} · ${c.duration_sec || 0}s`));
    root.appendChild(el('div', { class: 'sos-coach-note' }, c.top_coaching_note || ''));
    root.appendChild(el('div', { class: 'sos-coach-stats' }, [
      stat('Talk ratio', ratio != null ? `${ratio}%` : '—', ratioCls),
      stat('Next step', c.next_step_stated ? 'Yes' : 'No', nextStepCls),
      stat('Objections', objStr, ''),
      stat('Signal', c.call_outcome_signal || '—', ''),
    ]));

    const cta = el('div', { class: 'sos-coach-cta' });
    cta.appendChild(el('button', {
      class: 'sos-coach-btn',
      onclick: () => {
        // Mark seen + show next card if any
        api(`/coaching/${c.id}/seen`, { method: 'POST', body: '{}' }).then(() => {
          state.pendingCoaching.shift();
          if (state.pendingCoaching.length) showCoachingCard(state.pendingCoaching[0]);
          else hideCoachingCard();
        });
      },
    }, 'Got it'));
    cta.appendChild(el('button', {
      class: 'sos-coach-btn primary',
      onclick: () => {
        if (c.contact_id) {
          if (window.showSection) window.showSection('sos-today');
          selectContact(c.contact_id);
          api(`/coaching/${c.id}/seen`, { method: 'POST', body: '{}' });
          state.pendingCoaching.shift();
          if (state.pendingCoaching.length) showCoachingCard(state.pendingCoaching[0]);
          else hideCoachingCard();
        }
      },
    }, 'Open contact'));
    root.appendChild(cta);

    function stat(label, value, cls) {
      const s = el('div', { class: 'sos-coach-stat' });
      s.appendChild(el('div', { class: 'sos-coach-stat-label' }, label));
      s.appendChild(el('div', { class: `sos-coach-stat-value ${cls || ''}` }, String(value)));
      return s;
    }
  }

  function hideCoachingCard() {
    const root = $('#sos-coaching-card');
    if (root) root.classList.add('hidden');
  }

  // ---------------------------------------------------------------
  // Section activation hooks
  // ---------------------------------------------------------------
  function onSectionShown(id) {
    if (id === 'sos-today') { loadQueue(); loadScorecardStrip(); }
    else if (id === 'sos-pipeline') { loadPipeline(); }
    else if (id === 'sos-scorecard') { loadScorecardFull(); }
  }

  // Wrap the dashboard's existing showSection so we can react
  function hookShowSection() {
    if (typeof window.showSection !== 'function') {
      // showSection may be defined inside an IIFE — fallback: observe class changes
      const obs = new MutationObserver(muts => {
        muts.forEach(m => {
          if (m.attributeName !== 'class') return;
          const t = m.target;
          if (t.classList.contains('section') && t.classList.contains('active')) {
            onSectionShown(t.id);
          }
        });
      });
      $$('.section.sos-track').forEach(s => obs.observe(s, { attributes: true }));
      return;
    }
    const orig = window.showSection;
    window.showSection = function (id) {
      const r = orig.apply(this, arguments);
      onSectionShown(id);
      return r;
    };
  }

  // ---------------------------------------------------------------
  // Keyboard shortcuts (only when sos-today is active)
  // ---------------------------------------------------------------
  function handleKey(e) {
    const todayActive = $('#sos-today.active') != null;
    if (!todayActive) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    const idx = state.queue.findIndex(c => c.id === state.selectedId);
    if (e.key === 'j' || e.key === 'ArrowDown') {
      e.preventDefault();
      const next = state.queue[Math.min(idx + 1, state.queue.length - 1)];
      if (next) selectContact(next.id);
    } else if (e.key === 'k' || e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = state.queue[Math.max(idx - 1, 0)];
      if (prev) selectContact(prev.id);
    } else if (e.key === 'n') {
      e.preventDefault();
      const log = $('.sos-log');
      const btn = log && $('.sos-log-next', log);
      if (btn && !btn.disabled) btn.click();
    }
  }

  // ---------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------
  async function detectBackend() {
    try {
      const r = await fetch(API + '/health', { signal: AbortSignal.timeout(2000) });
      return r.ok;
    } catch (e) { return false; }
  }

  function hideSalesOSNav(reason) {
    // GitHub Pages / file:// without a running Flask backend → hide the Sales OS nav group
    // so the user doesn't see broken tabs. The static Birthday/Membership content keeps working.
    document.querySelectorAll('.nav-item.sos').forEach(n => {
      const grp = n.closest('.nav-group');
      if (grp) grp.style.display = 'none';
    });
    document.querySelectorAll('.section.sos-track').forEach(s => s.style.display = 'none');
    console.info('[sos] backend not reachable — Sales OS hidden:', reason);
  }

  async function init() {
    const ok = await detectBackend();
    if (!ok) {
      hideSalesOSNav('no /health response');
      return;
    }

    // Hook nav refresh button
    const refresh = $('#sos-refresh-queue');
    if (refresh) refresh.addEventListener('click', () => { loadQueue(); loadScorecardStrip(); });

    hookShowSection();
    document.addEventListener('keydown', handleKey);

    // Start coaching poller (every 60s) — only fires once per page load
    if (!state.pollerStarted) {
      state.pollerStarted = true;
      pollCoaching();
      setInterval(pollCoaching, 60000);
    }

    // Pre-warm queue if Sales OS section is already visible
    if ($('#sos-today.active')) onSectionShown('sos-today');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
