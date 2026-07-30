/**
 * Manager Accountability — rebuilt off Base44 as a static PWA on GitHub Pages
 * with a Cloudflare Worker + D1 ledger behind it.
 *
 * Shift flow matches the original: the app decides which shift is due (morning,
 * then night, then tomorrow morning), keeps a live draft as you tick, and files
 * a final submission plus an optional GM note on submit.
 */

import {
  MORNING_TASKS,
  NIGHT_TASKS,
  NON_NEGOTIABLES,
  AUDIT_ITEMS,
  VIDEO_SECTIONS,
  URGENCY,
  DEFAULT_COMPLETION_MESSAGES,
  SHIFT_BANNER,
  tasksFor,
} from './data/checklists.js';
import { BRANDS, DEFAULT_BRAND, applyBrand } from './brand.js';
import * as cloud from './cloud.js';

const state = {
  route: 'shift',
  shiftTab: 'shift',
  settingsTab: 'profile',
  profile: null,
  data: { profiles: [], shifts: [], notes: [], audits: [], messages: [], videos: [] },
  draft: null,
  shift: null,
  stale: false,
  historyOpen: false,
  historyRange: 'week',
  nonNegOpen: false,
  notesOpen: true,
  photos: new Map(),
};

/* -------------------------------- utilities ------------------------------- */

const $ = (selector, root = document) => root.querySelector(selector);

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

let toastTimer;
function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 2400);
}

function overlay(html, wire) {
  const root = $('#overlay-root');
  root.innerHTML = `<div class="overlay"><div class="sheet">${html}</div></div>`;
  const close = () => {
    root.innerHTML = '';
  };
  root.querySelector('.overlay').addEventListener('click', (event) => {
    if (event.target === root.querySelector('.overlay')) close();
  });
  if (wire) wire(root.querySelector('.sheet'), close);
  return close;
}

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function today() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function addDays(iso, days) {
  const date = new Date(`${iso}T00:00:00`);
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function currentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function fullName(profile) {
  return `${profile?.firstName || ''} ${profile?.lastName || ''}`.trim() || 'Unnamed';
}

function initialsOf(profile) {
  return `${(profile?.firstName || '?')[0] || ''}${(profile?.lastName || '')[0] || ''}`.toUpperCase();
}

function youTubeEmbed(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    let id = null;
    if (parsed.hostname.includes('youtu.be')) id = parsed.pathname.slice(1);
    else if (parsed.hostname.includes('youtube.com')) id = parsed.searchParams.get('v') || (parsed.pathname.startsWith('/shorts/') ? parsed.pathname.split('/')[2] : null);
    return id ? `https://www.youtube.com/embed/${id}` : null;
  } catch {
    return null;
  }
}

/* --------------------------------- getters -------------------------------- */

const settings = () => state.data.messages.find((row) => row.id === 'settings') || { id: 'settings' };

function taskOverrides() {
  return settings().taskOverrides || {};
}

function labelledTasks(shiftType) {
  const overrides = taskOverrides()[shiftType] || {};
  return tasksFor(shiftType).map((name, index) => overrides[index] || name);
}

function completionMessage(shiftType) {
  const record = state.data.messages.find((row) => row.id === `message_${shiftType}`);
  return record?.message || DEFAULT_COMPLETION_MESSAGES[shiftType];
}

function isSuperAdmin() {
  // Device admin PIN OR the #177-style profile admin flag from Base44.
  return cloud.isAdmin() || Boolean(state.profile?.isAdmin);
}

/** Profile #177 is the GM seat — only this profile edits training video URLs. */
function isChief177() {
  return String(state.profile?.employeeNumber || '') === '177';
}

/** Full Settings (roster, messages, checklist, codes, data, deletes) — only profile #177. */
function canManageApp() {
  return isChief177();
}

/** Admin notes on the shift screen — #177 or marked admin profiles. */
function seesAdminNotes() {
  return isChief177() || Boolean(state.profile?.isAdmin);
}

function finalShifts() {
  return state.data.shifts.filter((row) => row.isFinal);
}

/** Which shift is due now — morning, then night, then tomorrow morning. */
function dueShift() {
  const date = today();
  const filed = finalShifts().filter((row) => row.date === date);
  if (!filed.some((row) => row.shiftType === 'morning')) return { shiftType: 'morning', date };
  if (!filed.some((row) => row.shiftType === 'night')) return { shiftType: 'night', date };
  return { shiftType: 'morning', date: addDays(date, 1) };
}

function draftFor(shift) {
  return state.data.shifts.find(
    (row) => !row.isFinal && row.date === shift.date && row.shiftType === shift.shiftType,
  );
}

/* ------------------------------- persistence ------------------------------ */

let draftTimer;
function queueDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(async () => {
    if (!state.draft) return;
    try {
      const saved = await cloud.save('shifts', state.draft);
      state.draft = saved;
      const index = state.data.shifts.findIndex((row) => row.id === saved.id);
      if (index >= 0) state.data.shifts[index] = saved;
      else state.data.shifts.unshift(saved);
    } catch (error) {
      if (error.status === 409) toast('That shift was already submitted');
    }
    renderStatus();
  }, 600);
  renderStatus();
}

/* ---------------------------------- boot --------------------------------- */

async function boot() {
  applyBrand(DEFAULT_BRAND);
  startClock();

  let status;
  try {
    status = await cloud.fetchStatus();
  } catch {
    if (cloud.storedToken()) return startApp({ offline: true });
    return renderLock({ offline: true });
  }

  if (!status.claimed) return renderSetup();
  if (!cloud.storedToken()) return renderLock({});

  // Credential re-claims leave the old token in localStorage while the UI still
  // paints as unlocked. Re-check before loading so a dead token forces unlock
  // instead of a stuck offline banner with missing video links.
  const scope = await cloud.revalidateSession();
  if (!scope) return renderLock({});
  return startApp({});
}

async function startApp({ offline }) {
  $('#lock').classList.add('hidden');
  $('#app').classList.remove('hidden');

  await refresh({ silent: true });
  state.profile = cloud.activeProfile();

  // Keep the stored profile in step with server-side role changes.
  if (state.profile) {
    const fresh = state.data.profiles.find((row) => row.id === state.profile.id);
    if (fresh) {
      state.profile = fresh;
      cloud.setActiveProfile(fresh);
    }
  }

  wireChrome();
  cloud.onConnectionChange(renderStatus);
  cloud.flushOutbox().then(renderStatus).catch(() => {});

  if (state.profile) prepareShift();
  render();
  if (offline) toast('Offline — showing last synced data');
}

async function refresh({ silent } = {}) {
  const { data, stale } = await cloud.listAll();
  state.data = data;
  state.stale = stale;
  applyBrand(settings().brand || DEFAULT_BRAND);
  if (!silent) toast(stale ? 'Offline — cached data' : 'Up to date');
}

/**
 * Loads or creates the draft for the due shift. If the checklist changed since
 * the draft was made, task rows are re-keyed by name so ticks already recorded
 * survive — same behaviour the Base44 version had.
 */
function prepareShift() {
  state.shift = dueShift();
  const names = labelledTasks(state.shift.shiftType);
  const existing = draftFor(state.shift);

  if (existing) {
    const previous = existing.tasks || [];
    const changed =
      previous.length !== names.length || previous.some((task, index) => task.taskName !== names[index]);
    if (changed) {
      existing.tasks = names.map((name) => {
        const match = previous.find((task) => task.taskName === name);
        return { taskName: name, completed: match?.completed || false, photoId: match?.photoId || '' };
      });
    }
    state.draft = existing;
    if (changed) queueDraft();
    return;
  }

  state.draft = {
    id: uid('shift'),
    date: state.shift.date,
    shiftType: state.shift.shiftType,
    submittedByName: fullName(state.profile),
    submittedByEmployeeNumber: state.profile?.employeeNumber || '',
    tasks: names.map((name) => ({ taskName: name, completed: false, photoId: '' })),
    comments: '',
    urgency: '3',
    isFinal: false,
  };
  queueDraft();
}

/* -------------------------------- lock views ------------------------------ */

function renderSetup() {
  $('#lock-body').innerHTML = `
    <div class="card card-pad" style="text-align:left">
      <h2>First-time setup</h2>
      <p class="muted">Nobody has claimed this app yet. Set the two codes now — they are stored hashed on the server and never saved in the repo.</p>
      <form id="setup-form">
        <label class="field">
          <span>Manager access code — every manager gets this</span>
          <input name="accessCode" type="text" autocomplete="off" required minlength="3" />
        </label>
        <label class="field">
          <span>Admin PIN — GM only, unlocks roster, notes and videos</span>
          <input name="adminPin" type="text" autocomplete="off" required minlength="6" placeholder="at least 6 characters" />
        </label>
        <button class="btn block" type="submit">Claim this app</button>
        <p class="err hidden" id="setup-err"></p>
      </form>
      <p class="tiny" style="margin-top:14px">Write both down. The admin PIN can rotate either code later; a forgotten admin PIN can only be cleared from the Cloudflare dashboard.</p>
    </div>`;

  $('#setup-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button');
    const error = $('#setup-err');
    button.disabled = true;
    error.classList.add('hidden');
    try {
      const data = new FormData(form);
      await cloud.claim(String(data.get('accessCode')), String(data.get('adminPin')));
      await cloud.unlock(String(data.get('adminPin')));
      await startApp({});
      toast('Set up — signed in as admin');
    } catch (caught) {
      error.textContent = caught.message;
      error.classList.remove('hidden');
      button.disabled = false;
    }
  });
}

function renderLock({ offline }) {
  $('#lock-body').innerHTML = `
    <div class="card card-pad" style="text-align:left">
      <h2>Enter your code</h2>
      <p class="muted">The manager access code opens the app. The admin PIN also unlocks the roster, GM notes and video links.</p>
      ${offline ? '<div class="warn-box" style="margin-bottom:14px"><b>No connection</b><span class="tiny">You need to be online the first time you unlock on this device.</span></div>' : ''}
      <form id="lock-form">
        <label class="field"><span>Code</span><input name="code" type="password" autocomplete="current-password" required /></label>
        <button class="btn block" type="submit">Unlock</button>
        <p class="err hidden" id="lock-err"></p>
      </form>
    </div>`;

  $('#lock-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button');
    const error = $('#lock-err');
    button.disabled = true;
    error.classList.add('hidden');
    try {
      const scope = await cloud.unlock(String(new FormData(form).get('code')));
      await startApp({});
      toast(scope === 'admin' ? 'Unlocked as admin' : 'Unlocked');
    } catch (caught) {
      error.textContent = caught.status === 401 ? 'That code did not work.' : caught.message;
      error.classList.remove('hidden');
      button.disabled = false;
    }
  });
}

/* --------------------------------- chrome -------------------------------- */

function startClock() {
  const tick = () => {
    const now = new Date();
    const date = $('#bar-date');
    const clock = $('#bar-clock');
    if (date) date.textContent = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    if (clock) clock.textContent = now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  };
  tick();
  setInterval(tick, 1000);
}

function wireChrome() {
  $('#nav').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-route]');
    if (!button) return;
    state.route = button.dataset.route;
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  $('#btn-refresh').addEventListener('click', async () => {
    await cloud.flushOutbox().catch(() => {});
    await refresh({});
    if (state.profile) prepareShift();
    render();
  });
}

function renderStatus() {
  const strip = $('#status-strip');
  if (!strip) return;
  const pending = cloud.pendingWrites();
  if (!cloud.isOnline()) {
    strip.className = 'status-strip offline';
    strip.textContent = pending ? `Offline — ${pending} change${pending === 1 ? '' : 's'} waiting to sync` : 'Offline — showing last synced data';
  } else if (pending) {
    strip.className = 'status-strip pending';
    strip.textContent = `Syncing ${pending} change${pending === 1 ? '' : 's'}…`;
  } else {
    strip.className = 'status-strip hidden';
    strip.textContent = '';
  }

  const who = $('#bar-who');
  if (who) {
    who.textContent = state.profile
      ? `${cloud.isAdmin() ? 'ADMIN · ' : ''}#${state.profile.employeeNumber || initialsOf(state.profile)}`
      : cloud.isAdmin() ? 'ADMIN' : '';
  }
}

function render() {
  $('#nav').querySelectorAll('button[data-route]').forEach((button) => {
    if (button.dataset.route === state.route) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });

  const view = $('#view');
  if (!state.profile) view.innerHTML = profileGateView();
  else if (state.route === 'audit') view.innerHTML = auditView();
  else if (state.route === 'settings') view.innerHTML = settingsView();
  else view.innerHTML = shiftView();

  renderStatus();
  wireView();
  hydratePhotos();
}

/* ------------------------------ profile gate ----------------------------- */

function profileGateView() {
  const profiles = [...state.data.profiles].sort((a, b) => fullName(a).localeCompare(fullName(b)));
  return `<div class="stack">
    <section class="card card-pad">
      <h2>Who's on shift?</h2>
      <p class="muted">Pick your profile so submissions are recorded under your name.</p>
      <button class="btn block accent" style="margin-top:12px" data-act="create-profile">+ Create profile</button>
    </section>
    ${profiles.length ? `<section class="card">
      ${profiles.map((profile) => `
        <button class="list-row" data-act="pick-profile" data-id="${esc(profile.id)}">
          <span class="avatar">${esc(initialsOf(profile))}</span>
          <span class="info">
            <b>${esc(fullName(profile))}</b>
            <span>#${esc(profile.employeeNumber || '—')} · ${esc(profile.role || 'manager')}${profile.isAdmin ? ' · admin' : ''}</span>
          </span>
        </button>`).join('')}
    </section>` : ''}
  </div>`;
}

/* -------------------------------- shift view ----------------------------- */

function shiftView() {
  const tabs = `<div class="settings-tabs" role="tablist" style="margin-bottom:10px">
    <button type="button" role="tab" data-act="shift-tab" data-tab="shift" aria-selected="${state.shiftTab !== 'videos'}">Shift</button>
    <button type="button" role="tab" data-act="shift-tab" data-tab="videos" aria-selected="${state.shiftTab === 'videos'}">Videos</button>
  </div>`;

  if (state.shiftTab === 'videos') {
    return `<div class="stack">${tabs}${videosView()}</div>`;
  }

  const draft = state.draft;
  if (!draft) return `<div class="stack">${tabs}<section class="card card-pad"><p class="muted">Loading shift…</p></section></div>`;

  const done = draft.tasks.filter((task) => task.completed).length;
  const total = draft.tasks.length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const urgency = URGENCY.find((option) => option.value === draft.urgency) || URGENCY[2];

  return `<div class="stack">
    ${tabs}
    ${seesAdminNotes() ? adminNotesCard() : ''}
    ${nonNegotiablesCard()}

    <section class="card">
      <div class="phase-head" style="cursor:default;background:${draft.shiftType === 'morning' ? 'color-mix(in srgb, var(--warn) 10%, transparent)' : 'color-mix(in srgb, var(--info) 10%, transparent)'}">
        <span class="t">
          <b>${draft.shiftType === 'morning' ? 'Morning Shift' : 'Night Shift'} — ${esc(draft.date)}</b>
          <span style="color:var(--bad);font-weight:700">${esc(SHIFT_BANNER)}</span>
        </span>
        <span class="phase-count ${done === total ? 'full' : ''}">${done}/${total}</span>
      </div>
      <div class="phase-bar"><i style="width:${pct}%"></i></div>
      <div>
        ${draft.tasks.map((task, index) => `
          <div class="task ${task.completed ? 'checked' : ''}">
            <button class="check" role="checkbox" aria-checked="${task.completed}" data-act="check" data-index="${index}" aria-label="Mark task ${index + 1}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
            </button>
            <div class="task-body">
              <div class="task-title"><span class="ms">${index + 1}. ${esc(task.taskName)}</span></div>
              ${task.photoId ? `<div class="links"><img data-photo="${esc(task.photoId)}" alt="Verification photo" style="width:78px;height:78px;object-fit:cover;border-radius:10px;border:2px solid color-mix(in srgb, var(--accent) 40%, transparent)" /><button class="btn danger sm" data-act="remove-photo" data-index="${index}">Remove</button></div>` : ''}
              <div class="task-meta">
                <input class="hidden" type="file" accept="image/*" id="photo-${index}" data-act="photo" data-index="${index}" />
                <label class="link-btn" for="photo-${index}">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/></svg>
                  ${task.photoId ? 'Replace photo' : 'Add photo'}
                </label>
              </div>
            </div>
          </div>`).join('')}
      </div>
    </section>

    <section class="card card-pad">
      <label class="field">
        <span>Comments — filed as a GM note when you submit</span>
        <textarea data-act="comments" placeholder="Optional notes…" rows="3">${esc(draft.comments || '')}</textarea>
      </label>
      <label class="field">
        <span>Urgency</span>
        <select data-act="urgency">
          ${URGENCY.map((option) => `<option value="${option.value}" ${draft.urgency === option.value ? 'selected' : ''}>${esc(option.label)}</option>`).join('')}
        </select>
      </label>
      <p class="tiny" style="margin-bottom:12px">Current: <b>${esc(urgency.label)}</b>. Everything on this page auto-saves as a draft — submitting files it for good.</p>
      <button class="btn block" data-act="submit-shift">Submit ${draft.shiftType === 'morning' ? 'Morning' : 'Night'}</button>
    </section>

    ${historyCard()}
  </div>`;
}

function nonNegotiablesCard() {
  return `<section class="card" style="border-color:color-mix(in srgb, var(--warn) 45%, transparent);background:color-mix(in srgb, var(--warn) 8%, transparent)">
    <button class="phase-head" data-act="toggle-nonneg">
      <span class="t"><b style="color:var(--warn)">⭐ Non-Negotiables — Must-Do Top Priority</b><span>${NON_NEGOTIABLES.length} items</span></span>
      <svg class="caret" style="${state.nonNegOpen ? 'transform:rotate(180deg)' : ''}" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 9l6 6 6-6" /></svg>
    </button>
    ${state.nonNegOpen ? `<div style="padding:0 16px 14px">
      ${NON_NEGOTIABLES.map((item) => `<div style="display:flex;gap:9px;padding:9px 11px;margin-bottom:7px;border-radius:10px;background:color-mix(in srgb, var(--warn) 12%, transparent)">
        <span>⭐</span>
        <div><span class="badge day30" style="background:color-mix(in srgb, var(--bad) 15%, transparent);color:var(--bad)">NON-NEGOTIABLE</span>
        <p style="margin:5px 0 0;font-size:12.5px;line-height:1.5">${esc(item)}</p></div>
      </div>`).join('')}
    </div>` : ''}
  </section>`;
}

function adminNotesCard() {
  const notes = state.data.notes.filter((note) => !note.archived);
  return `<section class="card" style="border-color:color-mix(in srgb, var(--accent) 55%, transparent);background:color-mix(in srgb, var(--accent) 8%, transparent)">
    <button class="phase-head" data-act="toggle-notes">
      <span class="t"><b>📌 Admin Notes</b><span>${notes.length} active</span></span>
      <svg class="caret" style="${state.notesOpen ? 'transform:rotate(180deg)' : ''}" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 9l6 6 6-6" /></svg>
    </button>
    ${state.notesOpen ? `<div style="padding:0 16px 14px">
      ${notes.length ? notes.map((note) => `
        <div style="display:flex;align-items:flex-start;gap:9px;padding:10px 11px;margin-bottom:7px;border-radius:10px;background:color-mix(in srgb, var(--accent) 13%, transparent)">
          <div style="flex:1;min-width:0">
            <p style="margin:0;font-size:13px;line-height:1.5">${esc(note.comments)}</p>
            <p class="tiny" style="margin-top:3px">${esc(note.submittedByName || 'unknown')} · ${esc(note.date || '')} · urgency ${esc(note.urgency || '—')}</p>
          </div>
          ${canManageApp() ? `<button class="btn danger sm" data-act="archive-note" data-id="${esc(note.id)}">Clear</button>` : ''}
        </div>`).join('') : '<p class="muted" style="font-style:italic">No admin notes at this time.</p>'}
      ${canManageApp() ? '<button class="btn ghost block sm" style="margin-top:8px" data-act="add-note">+ Add note</button>' : ''}
    </div>` : ''}
  </section>`;
}

function historyCard() {
  const now = new Date();
  const rows = finalShifts()
    .filter((row) => {
      const date = new Date(`${row.date}T00:00:00`);
      if (state.historyRange === 'week') {
        const cutoff = new Date(now);
        cutoff.setDate(now.getDate() - 7);
        return date >= cutoff;
      }
      return row.date.startsWith(currentMonth());
    })
    .sort((a, b) => String(b.submittedAt || b.date).localeCompare(String(a.submittedAt || a.date)));

  return `<section class="card">
    <button class="phase-head" data-act="toggle-history">
      <span class="t"><b>History</b><span>${rows.length} submitted ${state.historyRange === 'week' ? 'in the last 7 days' : 'this month'}</span></span>
      <svg class="caret" style="${state.historyOpen ? 'transform:rotate(180deg)' : ''}" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 9l6 6 6-6" /></svg>
    </button>
    ${state.historyOpen ? `<div style="border-top:1px solid var(--line-soft)">
      <div class="row" style="padding:12px 16px 4px">
        <button class="btn ${state.historyRange === 'week' ? '' : 'ghost'} sm" data-act="range" data-range="week">Last 7 days</button>
        <button class="btn ${state.historyRange === 'month' ? '' : 'ghost'} sm" data-act="range" data-range="month">This month</button>
      </div>
      ${rows.length ? rows.map((row) => {
        const done = (row.tasks || []).filter((task) => task.completed).length;
        const total = (row.tasks || []).length;
        const photos = (row.tasks || []).filter((task) => task.photoId).length;
        return `<button class="list-row" data-act="view-shift" data-id="${esc(row.id)}">
          <span class="avatar">${row.shiftType === 'morning' ? 'AM' : 'PM'}</span>
          <span class="info">
            <b>${esc(row.date)} — ${row.shiftType === 'morning' ? 'Morning' : 'Night'}</b>
            <span>${done}/${total} done · ${photos} photo${photos === 1 ? '' : 's'} · ${esc(row.submittedByName || '—')}</span>
          </span>
          <span class="mini-bar"><i style="width:${total ? Math.round((done / total) * 100) : 0}%"></i></span>
        </button>`;
      }).join('') : '<div class="card-pad"><p class="muted">Nothing submitted in this range yet.</p></div>'}
    </div>` : ''}
  </section>`;
}

/* -------------------------------- audit view ----------------------------- */

function auditView() {
  const month = currentMonth();
  const audits = state.data.audits.filter((row) => row.auditMonth === month);
  const auditedNumbers = new Set(audits.map((row) => row.employeeNumber));
  const pending = state.data.profiles.filter((profile) => !auditedNumbers.has(profile.employeeNumber));
  const displayMonth = new Date().toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  return `<div class="stack">
    <section class="card card-pad">
      <h2>Food Safe Audits</h2>
      <p class="muted">${esc(displayMonth)} · ${audits.length} completed, ${pending.length} pending</p>
    </section>

    <section class="card card-pad">
      <h3>Start new audit</h3>
      ${pending.length ? pending.map((profile) => `
        <div class="kv">
          <div><b>${esc(fullName(profile))}</b><p class="tiny">#${esc(profile.employeeNumber || '—')}</p></div>
          <button class="btn sm" data-act="start-audit" data-id="${esc(profile.id)}">Audit</button>
        </div>`).join('') : '<p class="muted">✅ Everyone on the roster has been audited this month.</p>'}
    </section>

    <section class="card">
      <div class="card-pad" style="padding-bottom:6px"><h3 style="margin:0">Completed this month (${audits.length})</h3></div>
      ${audits.length ? audits.map((audit) => {
        const passed = (audit.items || []).filter((item) => item.passed).length;
        const total = (audit.items || []).length;
        return `<button class="list-row" data-act="view-audit" data-id="${esc(audit.id)}">
          <span class="avatar" style="${audit.overallPass ? 'background:color-mix(in srgb, var(--ok) 15%, transparent);color:var(--ok)' : 'background:color-mix(in srgb, var(--bad) 15%, transparent);color:var(--bad)'}">${audit.overallPass ? 'P' : 'F'}</span>
          <span class="info">
            <b>${esc(audit.employeeName)}</b>
            <span>${passed}/${total} passed · by ${esc(audit.auditorName || '—')}</span>
          </span>
          <span class="chip ${audit.overallPass ? 'done' : ''}">${audit.overallPass ? 'PASS' : 'FAIL'}</span>
        </button>`;
      }).join('') : '<div class="card-pad"><p class="muted">No audits completed yet.</p></div>'}
    </section>
  </div>`;
}

/* ------------------------------- videos view ----------------------------- */

function videosView() {
  return VIDEO_SECTIONS.map((section) => {
    const record = state.data.videos.find((row) => row.id === section.key) || {};
    return `<section class="card card-pad">
      <h2>▶ ${esc(section.title)}</h2>
      ${Array.from({ length: section.slots }, (unused, slot) => {
        const field = `video${slot + 1}Url`;
        const url = record[field] || '';
        const embed = youTubeEmbed(url);
        return `<div style="margin-top:12px">
          <p class="tiny" style="text-transform:uppercase;letter-spacing:0.05em;font-weight:700;margin-bottom:5px">Video ${slot + 1}</p>
          ${isChief177() ? `<input type="url" data-act="set-video" data-section="${esc(section.key)}" data-field="${field}" value="${esc(url)}" placeholder="Paste YouTube URL…" style="margin-bottom:8px" />` : ''}
          ${embed
            ? `<div class="embed" style="margin-top:0"><iframe src="${esc(embed)}" allowfullscreen allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" title="${esc(section.title)} video ${slot + 1}"></iframe></div>`
            : url
              ? `<a class="link-btn" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open link</a>`
              : `<div class="embed" style="margin-top:0;display:grid;place-items:center;background:var(--surface-alt)"><p class="tiny">No video yet${isChief177() ? '' : ' — ask #177 to add it'}</p></div>`}
        </div>`;
      }).join('')}
    </section>`;
  }).join('');
}

/* ------------------------------ settings view ---------------------------- */

function settingsView() {
  const managers = state.data.profiles.filter((row) => (row.role || 'manager') === 'manager');
  const accountants = state.data.profiles.filter((row) => row.role === 'accountant');

  // Regular crew: profile name only. Roster, completion messages, checklist
  // wording, codes, and data export are #177-only.
  if (!canManageApp()) {
    return `<div class="stack">
      <section class="card card-pad">
        <h2>Your profile</h2>
        <p class="muted" style="margin-bottom:12px">Update your name here. Roster, messages, codes and deletes are managed by #177.</p>
        <label class="field"><span>First name</span><input data-act="edit-name" data-field="firstName" value="${esc(state.profile?.firstName || '')}" /></label>
        <label class="field"><span>Last name</span><input data-act="edit-name" data-field="lastName" value="${esc(state.profile?.lastName || '')}" /></label>
        <p class="tiny">Employee #${esc(state.profile?.employeeNumber || '—')} · ${esc(state.profile?.role || 'manager')}</p>
        <button class="btn ghost block sm" style="margin-top:12px" data-act="switch-profile">Switch profile</button>
      </section>
      <section class="card card-pad">
        <button class="btn danger block sm" data-act="sign-out">Log Out</button>
      </section>
    </div>`;
  }

  return `<div class="stack">
    <section class="card card-pad">
      <h2>Your profile</h2>
      <label class="field"><span>First name</span><input data-act="edit-name" data-field="firstName" value="${esc(state.profile?.firstName || '')}" /></label>
      <label class="field"><span>Last name</span><input data-act="edit-name" data-field="lastName" value="${esc(state.profile?.lastName || '')}" /></label>
      <p class="tiny">#${esc(state.profile?.employeeNumber || '—')} · ${esc(state.profile?.role || 'manager')}${state.profile?.isAdmin || isChief177() ? ' · admin' : ''}</p>
      <button class="btn ghost block sm" style="margin-top:12px" data-act="switch-profile">Switch profile</button>
    </section>

    <section class="card card-pad">
      <h2>Branding</h2>
      <label class="field">
        <span>Brand</span>
        <select data-act="set-brand">
          ${Object.values(BRANDS).map((brand) => `<option value="${esc(brand.id)}" ${(settings().brand || DEFAULT_BRAND) === brand.id ? 'selected' : ''}>${esc(brand.plainName)}</option>`).join('')}
        </select>
      </label>
    </section>

    <section class="card card-pad">
      <h2>Roster &amp; roles</h2>
      <h3>Managers (${managers.length})</h3>
      ${managers.length ? managers.map((profile) => profileRow(profile)).join('') : '<p class="muted">None yet.</p>'}
      <h3 style="margin-top:16px">Accountants (${accountants.length})</h3>
      ${accountants.length ? accountants.map((profile) => profileRow(profile)).join('') : '<p class="muted">None yet.</p>'}
      <button class="btn ghost block sm" style="margin-top:12px" data-act="create-profile">+ Add profile</button>
    </section>

    <section class="card card-pad">
      <h2>Completion messages</h2>
      <p class="muted" style="margin-bottom:12px">Shown to the manager right after they submit.</p>
      <label class="field"><span>Morning Message</span><input data-act="set-message" data-shift="morning" value="${esc(completionMessage('morning'))}" /></label>
      <label class="field"><span>Night Message</span><input data-act="set-message" data-shift="night" value="${esc(completionMessage('night'))}" /></label>
    </section>

    <section class="card card-pad">
      <h2>Checklist wording</h2>
      <p class="muted" style="margin-bottom:12px">Overrides a task line for everyone. Blank restores the original.</p>
      <div class="row">
        <button class="btn ghost sm" data-act="edit-tasks" data-shift="morning">Morning (${MORNING_TASKS.length})</button>
        <button class="btn ghost sm" data-act="edit-tasks" data-shift="night">Night (${NIGHT_TASKS.length})</button>
      </div>
    </section>

    <section class="card card-pad">
      <h2>Codes</h2>
      <button class="btn ghost block sm" data-act="rotate">Rotate access code / admin PIN</button>
      ${cloud.isAdmin() ? '<button class="btn ghost block sm" style="margin-top:8px" data-act="drop-admin">Leave admin mode on this device</button>' : ''}
      ${!cloud.isAdmin() ? '<button class="btn ghost block sm" style="margin-top:8px" data-act="elevate">Enter admin PIN on this device</button>' : ''}
    </section>

    <section class="card card-pad">
      <h2>Data</h2>
      <button class="btn ghost block sm" data-act="export-all">Download JSON backup</button>
    </section>

    <section class="card card-pad">
      <button class="btn danger block sm" data-act="sign-out">Log Out</button>
    </section>
  </div>`;
}

function profileRow(profile) {
  return `<div class="kv">
    <div><b>${esc(fullName(profile))}</b><p class="tiny">#${esc(profile.employeeNumber || '—')}${profile.isAdmin ? ' · admin' : ''}</p></div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
      <button class="btn ghost sm" data-act="toggle-role" data-id="${esc(profile.id)}">${(profile.role || 'manager') === 'manager' ? 'Make accountant' : 'Make manager'}</button>
      <button class="btn ghost sm" data-act="toggle-admin" data-id="${esc(profile.id)}">${profile.isAdmin ? 'Remove admin' : 'Make admin'}</button>
      ${canManageApp() ? `<button class="btn danger sm" data-act="delete-profile" data-id="${esc(profile.id)}">Delete</button>` : ''}
    </div>
  </div>`;
}

/* ------------------------------ photo loading ---------------------------- */

/** Fetches referenced photos once and reuses them for the session. */
async function hydratePhotos() {
  const nodes = [...document.querySelectorAll('img[data-photo]')];
  for (const node of nodes) {
    const id = node.dataset.photo;
    if (state.photos.has(id)) {
      node.src = state.photos.get(id);
      continue;
    }
    const dataUrl = await cloud.loadPhoto(id);
    if (dataUrl) {
      state.photos.set(id, dataUrl);
      node.src = dataUrl;
    }
  }
}

/* --------------------------------- wiring ------------------------------- */

let viewWired = false;

/**
 * Attach the delegated handlers exactly once. render() only swaps innerHTML, so
 * delegation on #view survives — re-binding per render would stack duplicate
 * listeners and a single tap would toggle a checkbox twice, back to where it
 * started.
 */
function wireView() {
  if (viewWired) return;
  viewWired = true;
  const view = $('#view');

  view.addEventListener('click', async (event) => {
    const target = event.target.closest('[data-act]');
    if (!target) return;

    switch (target.dataset.act) {
      case 'create-profile':
        promptProfile();
        break;

      case 'pick-profile': {
        const profile = state.data.profiles.find((row) => row.id === target.dataset.id);
        if (!profile) return;
        state.profile = profile;
        cloud.setActiveProfile(profile);
        prepareShift();
        state.route = 'shift';
        render();
        break;
      }

      case 'switch-profile':
        state.profile = null;
        cloud.setActiveProfile(null);
        render();
        break;

      case 'settings-tab':
        state.settingsTab = target.dataset.tab === 'videos' ? 'videos' : 'profile';
        render();
        break;

      case 'shift-tab':
        state.shiftTab = target.dataset.tab === 'videos' ? 'videos' : 'shift';
        render();
        break;

      case 'delete-own-profile': {
        if (!canManageApp() || !state.profile) break;
        if (!window.confirm(`Delete profile for ${fullName(state.profile)}?`)) break;
        const id = state.profile.id;
        await cloud.remove('profiles', id);
        state.data.profiles = state.data.profiles.filter((row) => row.id !== id);
        state.profile = null;
        cloud.setActiveProfile(null);
        toast('Profile deleted');
        render();
        break;
      }

      case 'toggle-nonneg':
        state.nonNegOpen = !state.nonNegOpen;
        render();
        break;

      case 'toggle-notes':
        state.notesOpen = !state.notesOpen;
        render();
        break;

      case 'toggle-history':
        state.historyOpen = !state.historyOpen;
        render();
        break;

      case 'range':
        state.historyRange = target.dataset.range;
        render();
        break;

      case 'check': {
        const index = Number(target.dataset.index);
        state.draft.tasks[index].completed = !state.draft.tasks[index].completed;
        target.setAttribute('aria-checked', String(state.draft.tasks[index].completed));
        target.closest('.task').classList.toggle('checked', state.draft.tasks[index].completed);
        const done = state.draft.tasks.filter((task) => task.completed).length;
        const total = state.draft.tasks.length;
        const count = view.querySelector('.phase-count');
        if (count) {
          count.textContent = `${done}/${total}`;
          count.classList.toggle('full', done === total);
        }
        const bar = view.querySelector('.phase-bar i');
        if (bar) bar.style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
        queueDraft();
        break;
      }

      case 'remove-photo': {
        const index = Number(target.dataset.index);
        const photoId = state.draft.tasks[index].photoId;
        state.draft.tasks[index].photoId = '';
        queueDraft();
        render();
        if (photoId) cloud.deletePhoto(photoId);
        break;
      }

      case 'submit-shift':
        confirmSubmit();
        break;

      case 'view-shift':
        showShift(target.dataset.id);
        break;

      case 'add-note':
        promptNote();
        break;

      case 'archive-note': {
        const note = state.data.notes.find((row) => row.id === target.dataset.id);
        if (!note) return;
        await cloud.save('notes', { ...note, archived: true });
        note.archived = true;
        render();
        toast('Note cleared');
        break;
      }

      case 'start-audit':
        startAudit(target.dataset.id);
        break;

      case 'view-audit':
        showAudit(target.dataset.id);
        break;

      case 'toggle-role': {
        if (!canManageApp()) break;
        const profile = state.data.profiles.find((row) => row.id === target.dataset.id);
        if (!profile) return;
        const updated = { ...profile, role: (profile.role || 'manager') === 'manager' ? 'accountant' : 'manager' };
        await applyProfile(updated);
        break;
      }

      case 'toggle-admin': {
        if (!canManageApp()) break;
        const profile = state.data.profiles.find((row) => row.id === target.dataset.id);
        if (!profile) return;
        await applyProfile({ ...profile, isAdmin: !profile.isAdmin });
        break;
      }

      case 'delete-profile':
        if (!canManageApp()) break;
        confirmDeleteProfile(target.dataset.id);
        break;

      case 'edit-tasks':
        if (!canManageApp()) break;
        promptTaskWording(target.dataset.shift);
        break;

      case 'elevate':
        promptElevate();
        break;

      case 'rotate':
        if (!canManageApp()) break;
        promptRotate();
        break;

      case 'drop-admin':
        cloud.dropAdmin();
        render();
        toast('Admin mode off');
        break;

      case 'sign-out':
        cloud.signOut();
        location.reload();
        break;

      case 'export-all':
        if (!canManageApp()) break;
        download(
          `manager-accountability-backup-${today()}.json`,
          JSON.stringify({ exportedAt: new Date().toISOString(), ...state.data }, null, 2),
        );
        break;

      default:
        break;
    }
  });

  view.addEventListener('change', async (event) => {
    const target = event.target.closest('[data-act]');
    if (!target) return;

    switch (target.dataset.act) {
      case 'comments':
        state.draft.comments = target.value;
        queueDraft();
        break;

      case 'urgency':
        state.draft.urgency = target.value;
        queueDraft();
        break;

      case 'photo': {
        const index = Number(target.dataset.index);
        const file = target.files?.[0];
        if (!file) return;
        try {
          toast('Compressing photo…');
          const compressed = await cloud.compressImage(file);
          const photoId = uid('photo');
          await cloud.savePhoto(photoId, compressed);
          state.photos.set(photoId, `data:${compressed.mimeType};base64,${compressed.dataBase64}`);
          const previous = state.draft.tasks[index].photoId;
          state.draft.tasks[index].photoId = photoId;
          state.draft.tasks[index].completed = true;
          queueDraft();
          render();
          if (previous) cloud.deletePhoto(previous);
          toast('Photo attached');
        } catch (caught) {
          toast(caught.message);
        }
        break;
      }

      case 'set-brand': {
        if (!canManageApp()) break;
        await cloud.save('messages', { ...settings(), id: 'settings', brand: target.value });
        await refresh({ silent: true });
        applyBrand(target.value);
        render();
        toast('Brand updated');
        break;
      }

      case 'set-message': {
        if (!canManageApp()) break;
        const shiftType = target.dataset.shift;
        await cloud.save('messages', { id: `message_${shiftType}`, shiftType, message: target.value });
        await refresh({ silent: true });
        toast('Message saved');
        break;
      }

      case 'set-video': {
        if (!isChief177()) {
          toast('Only profile #177 can change video links');
          break;
        }
        const key = target.dataset.section;
        const existing = state.data.videos.find((row) => row.id === key) || { id: key, section: key };
        await cloud.save('videos', { ...existing, [target.dataset.field]: target.value.trim() });
        await refresh({ silent: true });
        render();
        toast('Video link saved');
        break;
      }

      case 'edit-name': {
        if (!state.profile) break;
        const field = target.dataset.field;
        if (field !== 'firstName' && field !== 'lastName') break;
        const next = { ...state.profile, [field]: target.value.trim() };
        const saved = await cloud.save('profiles', next);
        state.profile = saved;
        cloud.setActiveProfile(saved);
        state.data.profiles = state.data.profiles.map((row) => (row.id === saved.id ? saved : row));
        toast('Name saved');
        break;
      }

      default:
        break;
    }
  });
}

async function applyProfile(updated) {
  await cloud.save('profiles', updated);
  const index = state.data.profiles.findIndex((row) => row.id === updated.id);
  if (index >= 0) state.data.profiles[index] = updated;
  if (state.profile?.id === updated.id) {
    state.profile = updated;
    cloud.setActiveProfile(updated);
  }
  render();
  toast('Updated');
}

/* -------------------------------- prompts ------------------------------- */

function promptProfile() {
  overlay(
    `<h2>Create profile</h2>
     <form id="prof-form">
       <div class="row">
         <label class="field"><span>First name</span><input name="firstName" required /></label>
         <label class="field"><span>Last name</span><input name="lastName" required /></label>
       </div>
       <label class="field"><span>Employee number</span><input name="employeeNumber" required placeholder="177" /></label>
       <button class="btn block" type="submit">Create</button>
     </form>`,
    (sheet, close) => {
      sheet.querySelector('#prof-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const profile = {
          id: uid('prof'),
          firstName: String(data.get('firstName')).trim(),
          lastName: String(data.get('lastName')).trim(),
          employeeNumber: String(data.get('employeeNumber')).trim(),
          role: 'manager',
          isAdmin: false,
        };
        state.data.profiles.push(profile);
        close();
        if (!state.profile) {
          state.profile = profile;
          cloud.setActiveProfile(profile);
          prepareShift();
        }
        render();
        await cloud.save('profiles', profile);
        renderStatus();
        toast('Profile created');
      });
    },
  );
}

function promptNote() {
  overlay(
    `<h2>Add admin note</h2>
     <p class="muted">Shown to every manager and admin on the shift screen.</p>
     <form id="note-form">
       <label class="field"><span>Note</span><textarea name="comments" rows="3" required></textarea></label>
       <label class="field">
         <span>Urgency</span>
         <select name="urgency">${URGENCY.map((option) => `<option value="${option.value}" ${option.value === '2' ? 'selected' : ''}>${esc(option.label)}</option>`).join('')}</select>
       </label>
       <button class="btn block" type="submit">Post note</button>
     </form>`,
    (sheet, close) => {
      sheet.querySelector('#note-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const note = {
          id: uid('note'),
          date: today(),
          shiftType: state.draft?.shiftType || 'morning',
          comments: String(data.get('comments')).trim(),
          urgency: String(data.get('urgency')),
          submittedByName: fullName(state.profile),
          submittedByEmployeeNumber: state.profile?.employeeNumber || '',
          archived: false,
        };
        state.data.notes.unshift(note);
        close();
        render();
        await cloud.save('notes', note);
        renderStatus();
        toast('Note posted');
      });
    },
  );
}

function confirmSubmit() {
  const draft = state.draft;
  const done = draft.tasks.filter((task) => task.completed).length;
  const total = draft.tasks.length;

  overlay(
    `<h2>Submit ${draft.shiftType === 'morning' ? 'morning' : 'night'} shift?</h2>
     <p class="muted">${done} of ${total} tasks ticked.${done < total ? ' The rest will be filed as not completed.' : ''}${draft.comments ? ' Your comments will also be posted as a GM note.' : ''}</p>
     <div class="row">
       <button class="btn ghost" data-close>Cancel</button>
       <button class="btn" id="sub-yes">Submit</button>
     </div>`,
    (sheet, close) => {
      sheet.querySelector('[data-close]').addEventListener('click', close);
      sheet.querySelector('#sub-yes').addEventListener('click', async () => {
        close();
        const submittedAt = new Date().toISOString();
        const final = { ...draft, isFinal: true, date: today(), submittedAt };

        try {
          const saved = await cloud.save('shifts', final);
          const index = state.data.shifts.findIndex((row) => row.id === saved.id);
          if (index >= 0) state.data.shifts[index] = saved;
        } catch (error) {
          toast(error.status === 409 ? 'That shift was already submitted' : error.message);
          return;
        }

        if (final.comments?.trim()) {
          const note = {
            id: uid('note'),
            date: final.date,
            shiftType: final.shiftType,
            comments: final.comments.trim(),
            urgency: final.urgency,
            submittedByName: final.submittedByName,
            submittedByEmployeeNumber: final.submittedByEmployeeNumber,
            archived: false,
          };
          state.data.notes.unshift(note);
          await cloud.save('notes', note);
        }

        showCompletion(completionMessage(final.shiftType));
        prepareShift();
        render();
      });
    },
  );
}

function showCompletion(message) {
  const close = overlay(
    `<div style="text-align:center">
       <div style="width:62px;height:62px;margin:0 auto 14px;border-radius:999px;display:grid;place-items:center;background:color-mix(in srgb, var(--ok) 14%, transparent)">
         <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="var(--ok)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><path d="M22 4L12 14.01l-3-3" /></svg>
       </div>
       <p style="margin:0;font-size:17px;font-weight:650">${esc(message)}</p>
     </div>`,
  );
  setTimeout(close, 2200);
}

function showShift(id) {
  const row = state.data.shifts.find((item) => item.id === id);
  if (!row) return;
  overlay(
    `<h2>${esc(row.date)} — ${row.shiftType === 'morning' ? 'Morning' : 'Night'}</h2>
     <p class="muted">Submitted by ${esc(row.submittedByName || '—')}${row.submittedAt ? ` · ${new Date(row.submittedAt).toLocaleString()}` : ''} · urgency ${esc(row.urgency || '—')}</p>
     ${row.comments ? `<div class="warn-box" style="margin-bottom:14px"><b>Comments</b><span class="tiny">${esc(row.comments)}</span></div>` : ''}
     <div>
       ${(row.tasks || []).map((task, index) => `
         <div style="display:flex;gap:9px;padding:8px 0;border-bottom:1px solid var(--line-soft)">
           <span style="color:${task.completed ? 'var(--ok)' : 'var(--text-faint)'};font-weight:800;flex:0 0 auto">${task.completed ? '✓' : '·'}</span>
           <div style="flex:1;min-width:0">
             <p style="margin:0;font-size:12.5px;line-height:1.45;${task.completed ? '' : 'color:var(--text-soft)'}">${index + 1}. ${esc(task.taskName)}</p>
             ${task.photoId ? `<img data-photo="${esc(task.photoId)}" alt="Verification" style="margin-top:6px;width:100%;max-width:220px;border-radius:10px" />` : ''}
           </div>
         </div>`).join('')}
     </div>`,
    () => hydratePhotos(),
  );
}

function startAudit(profileId) {
  const profile = state.data.profiles.find((row) => row.id === profileId);
  if (!profile) return;
  const items = AUDIT_ITEMS.map((label) => ({ label, passed: null, notes: '' }));

  overlay(
    `<h2>Audit ${esc(fullName(profile))}</h2>
     <p class="muted">All ${AUDIT_ITEMS.length} items must be rated before you can save.</p>
     <div id="audit-items" style="max-height:52vh;overflow-y:auto;margin-bottom:14px">
       ${items.map((item, index) => `
         <div style="padding:10px 0;border-bottom:1px solid var(--line-soft)">
           <p style="margin:0 0 7px;font-size:12.5px;line-height:1.45">${index + 1}. ${esc(item.label)}</p>
           <div class="row">
             <button class="btn ghost sm" data-rate="${index}" data-value="pass">Pass</button>
             <button class="btn ghost sm" data-rate="${index}" data-value="fail">Fail</button>
           </div>
         </div>`).join('')}
     </div>
     <button class="btn block" id="audit-save" disabled>Rate all items to save</button>`,
    (sheet, close) => {
      const saveButton = sheet.querySelector('#audit-save');

      sheet.querySelector('#audit-items').addEventListener('click', (event) => {
        const button = event.target.closest('[data-rate]');
        if (!button) return;
        const index = Number(button.dataset.rate);
        const passed = button.dataset.value === 'pass';
        items[index].passed = passed;

        button.parentElement.querySelectorAll('[data-rate]').forEach((sibling) => {
          sibling.classList.add('ghost');
          sibling.style.background = '';
          sibling.style.color = '';
        });
        button.classList.remove('ghost');
        button.style.background = passed ? 'var(--ok)' : 'var(--bad)';
        button.style.color = '#fff';

        const remaining = items.filter((item) => item.passed === null).length;
        saveButton.disabled = remaining > 0;
        saveButton.textContent = remaining > 0 ? `${remaining} item${remaining === 1 ? '' : 's'} left to rate` : 'Save audit';
      });

      saveButton.addEventListener('click', async () => {
        const audit = {
          id: uid('audit'),
          employeeName: fullName(profile),
          employeeNumber: profile.employeeNumber,
          auditMonth: currentMonth(),
          items,
          overallPass: items.every((item) => item.passed === true),
          auditorName: fullName(state.profile),
          auditorEmployeeNumber: state.profile?.employeeNumber || '',
          submittedAt: new Date().toISOString(),
        };
        state.data.audits.unshift(audit);
        close();
        render();
        await cloud.save('audits', audit);
        renderStatus();
        toast(audit.overallPass ? 'Audit saved — pass' : 'Audit saved — fail');
      });
    },
  );
}

function showAudit(id) {
  const audit = state.data.audits.find((row) => row.id === id);
  if (!audit) return;
  overlay(
    `<h2>${esc(audit.employeeName)}</h2>
     <p class="muted">${esc(audit.auditMonth)} · by ${esc(audit.auditorName || '—')} · <b style="color:${audit.overallPass ? 'var(--ok)' : 'var(--bad)'}">${audit.overallPass ? 'PASS' : 'FAIL'}</b></p>
     <div>
       ${(audit.items || []).map((item) => `
         <div style="display:flex;gap:9px;padding:7px 0;border-bottom:1px solid var(--line-soft)">
           <span style="color:${item.passed ? 'var(--ok)' : 'var(--bad)'};font-weight:800">${item.passed ? '✓' : '✕'}</span>
           <p style="margin:0;font-size:12.5px;line-height:1.45">${esc(item.label)}</p>
         </div>`).join('')}
     </div>`,
  );
}

function promptTaskWording(shiftType) {
  const original = tasksFor(shiftType);
  const overrides = taskOverrides()[shiftType] || {};

  overlay(
    `<h2>${shiftType === 'morning' ? 'Morning' : 'Night'} checklist wording</h2>
     <p class="muted">Blank a line to restore the original.</p>
     <div style="max-height:52vh;overflow-y:auto;margin-bottom:14px">
       ${original.map((name, index) => `
         <div class="media-row">
           <p class="tiny">${index + 1}. ${esc(name)}</p>
           <input data-task-index="${index}" value="${esc(overrides[index] || '')}" placeholder="override…" />
         </div>`).join('')}
     </div>
     <button class="btn block" id="tasks-save">Save wording</button>`,
    (sheet, close) => {
      sheet.querySelector('#tasks-save').addEventListener('click', async () => {
        const next = {};
        sheet.querySelectorAll('[data-task-index]').forEach((input) => {
          const value = input.value.trim();
          if (value) next[input.dataset.taskIndex] = value;
        });
        const allOverrides = { ...taskOverrides(), [shiftType]: next };
        await cloud.save('messages', { ...settings(), id: 'settings', taskOverrides: allOverrides });
        await refresh({ silent: true });
        close();
        prepareShift();
        render();
        toast('Wording saved');
      });
    },
  );
}

function promptElevate() {
  overlay(
    `<h2>Admin PIN</h2>
     <form id="elev-form">
       <label class="field"><span>Admin PIN</span><input name="pin" type="password" autocomplete="current-password" required /></label>
       <button class="btn block" type="submit">Unlock admin</button>
       <p class="err hidden" id="elev-err"></p>
     </form>`,
    (sheet, close) => {
      sheet.querySelector('#elev-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const error = sheet.querySelector('#elev-err');
        try {
          const scope = await cloud.unlock(String(new FormData(event.currentTarget).get('pin')));
          if (scope !== 'admin') throw new Error('That is the manager access code, not the admin PIN.');
          close();
          await refresh({ silent: true });
          render();
          toast('Admin unlocked');
        } catch (caught) {
          error.textContent = caught.status === 401 ? 'Wrong PIN.' : caught.message;
          error.classList.remove('hidden');
        }
      });
    },
  );
}

function promptRotate() {
  overlay(
    `<h2>Rotate codes</h2>
     <p class="muted">Leave a field blank to keep it unchanged.</p>
     <form id="rot-form">
       <label class="field"><span>Current admin PIN</span><input name="currentAdminPin" type="password" required /></label>
       <label class="field"><span>New manager access code</span><input name="accessCode" type="text" autocomplete="off" placeholder="unchanged" /></label>
       <label class="field"><span>New admin PIN</span><input name="adminPin" type="text" autocomplete="off" placeholder="unchanged" /></label>
       <button class="btn block" type="submit">Rotate</button>
       <p class="err hidden" id="rot-err"></p>
     </form>`,
    (sheet, close) => {
      sheet.querySelector('#rot-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const error = sheet.querySelector('#rot-err');
        const data = new FormData(event.currentTarget);
        const payload = { currentAdminPin: String(data.get('currentAdminPin')) };
        const access = String(data.get('accessCode')).trim();
        const admin = String(data.get('adminPin')).trim();
        if (access) payload.accessCode = access;
        if (admin) payload.adminPin = admin;
        if (!access && !admin) {
          error.textContent = 'Enter at least one new code.';
          error.classList.remove('hidden');
          return;
        }
        try {
          await cloud.rotateCredentials(payload);
          close();
          toast('Codes rotated');
        } catch (caught) {
          error.textContent = caught.message;
          error.classList.remove('hidden');
        }
      });
    },
  );
}

function confirmDeleteProfile(id) {
  const profile = state.data.profiles.find((row) => row.id === id);
  if (!profile) return;
  overlay(
    `<h2>Delete ${esc(fullName(profile))}?</h2>
     <p class="muted">Their profile is removed from the roster. Shifts and audits they already filed stay on the record.</p>
     <div class="row">
       <button class="btn ghost" data-close>Cancel</button>
       <button class="btn danger" id="del-yes">Delete</button>
     </div>`,
    (sheet, close) => {
      sheet.querySelector('[data-close]').addEventListener('click', close);
      sheet.querySelector('#del-yes').addEventListener('click', async () => {
        state.data.profiles = state.data.profiles.filter((row) => row.id !== id);
        if (state.profile?.id === id) {
          state.profile = null;
          cloud.setActiveProfile(null);
        }
        close();
        render();
        await cloud.remove('profiles', id);
        renderStatus();
        toast('Deleted');
      });
    },
  );
}

function download(filename, contents) {
  const blob = new Blob([contents], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
  toast('Downloaded');
}

/* --------------------------------- start -------------------------------- */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

boot();
