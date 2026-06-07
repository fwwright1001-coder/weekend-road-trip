/* ============================================================
 * Weekend Road Trip - Road Crew capture
 * Vercel + Neon assignment layer. The game still runs on static GitHub Pages;
 * the cloud signup path activates when this same repo is deployed on Vercel.
 * ============================================================ */

(() => {
  'use strict';

  const LOCAL_KEY = 'wrt.roadCrew.local.v1';
  const API_URL = '/api/waitlist';
  const form = document.getElementById('waitlist-form');
  const nameInput = document.getElementById('waitlist-name');
  const emailInput = document.getElementById('waitlist-email');
  const statusEl = document.getElementById('waitlist-status');

  if (!form || !emailInput || !statusEl) return;

  function canUseCloudWaitlist() {
    if (typeof fetch !== 'function') return false;
    const host = String(window.location.hostname || '');
    if (!host || window.location.protocol === 'file:') return false;
    if (/\.github\.io$/i.test(host)) return false;
    if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/i.test(host)) return false;
    return true;
  }

  function fallbackMessage() {
    return /\.github\.io$/i.test(window.location.hostname)
      ? 'GitHub Pages fallback active; Vercel saves this form to Neon.'
      : 'Local fallback active; Vercel saves this form to Neon.';
  }

  function clean(value, max) {
    return String(value || '').trim().replace(/\s+/g, ' ').slice(0, max);
  }

  function validEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
  }

  function setStatus(kind, message) {
    statusEl.className = 'waitlist-status' + (kind ? ' ' + kind : '');
    statusEl.textContent = message || '';
  }

  function localEntries() {
    try {
      const parsed = JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function saveLocal(payload) {
    try {
      const entries = localEntries().filter((entry) => entry.email !== payload.email);
      entries.push({ ...payload, savedAt: new Date().toISOString(), storage: 'local' });
      localStorage.setItem(LOCAL_KEY, JSON.stringify(entries.slice(-25)));
      return true;
    } catch (e) {
      return false;
    }
  }

  function payloadFromForm() {
    return {
      name: clean(nameInput ? nameInput.value : '', 80),
      email: clean(emailInput.value, 120).toLowerCase(),
      interest: 'road-crew',
      source: 'weekend-road-trip-title'
    };
  }

  async function refreshCloudCount() {
    if (!canUseCloudWaitlist()) {
      setStatus('', fallbackMessage());
      return;
    }
    try {
      const res = await fetch(API_URL, { method: 'GET', cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      if (data && data.ok && Number.isFinite(Number(data.count))) {
        setStatus('ok', `Cloud list online: ${Number(data.count)} Road Crew signups.`);
      }
    } catch (e) {
      // Local static servers do not expose /api; the submit path still falls back.
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const payload = payloadFromForm();
    if (!validEmail(payload.email)) {
      setStatus('bad', 'Enter a valid email to join the Road Crew.');
      emailInput.focus();
      return;
    }

    if (!canUseCloudWaitlist()) {
      const saved = saveLocal(payload);
      setStatus(saved ? 'ok' : 'bad',
        saved ? 'Saved locally here; deploy on Vercel to sync Neon.' : 'Local save is unavailable in this browser.');
      if (saved) form.reset();
      return;
    }

    setStatus('pending', 'Saving to the Road Crew list...');
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (res.status === 503) {
          setStatus('bad', 'Neon is not connected yet; add DATABASE_URL in Vercel.');
          return;
        }
        throw new Error(data.error || 'Signup failed.');
      }

      const count = Number(data.count);
      setStatus('ok', Number.isFinite(count)
        ? `Saved to Neon. Road Crew count: ${count}.`
        : 'Saved to Neon.');
      form.reset();
    } catch (e) {
      const saved = saveLocal(payload);
      setStatus(saved ? 'ok' : 'bad',
        saved ? 'Saved locally; Vercel API was not reachable.' : 'Could not save. Try again from the Vercel deployment.');
      if (saved) form.reset();
    }
  });

  refreshCloudCount();
})();
