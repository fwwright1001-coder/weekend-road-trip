/* ============================================================
 * Road Crew client contract
 * Loads launch.js in a small DOM shim and verifies GitHub Pages fallback,
 * Vercel API success, invalid input, and Neon-not-configured messaging.
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const code = fs.readFileSync(path.join(__dirname, '..', 'launch.js'), 'utf8');

function createHarness({ hostname, protocol, fetchImpl }) {
  const listeners = {};
  const store = new Map();
  const elements = {
    'waitlist-form': {
      id: 'waitlist-form',
      resetCount: 0,
      addEventListener(type, cb) { listeners[type] = cb; },
      reset() {
        this.resetCount++;
        elements['waitlist-name'].value = '';
        elements['waitlist-email'].value = '';
      }
    },
    'waitlist-name': { id: 'waitlist-name', value: '', focusCount: 0, focus() { this.focusCount++; } },
    'waitlist-email': { id: 'waitlist-email', value: '', focusCount: 0, focus() { this.focusCount++; } },
    'waitlist-status': { id: 'waitlist-status', className: 'waitlist-status', textContent: '' }
  };

  const localStorage = {
    getItem(key) { return store.has(key) ? store.get(key) : null; },
    setItem(key, value) { store.set(key, String(value)); },
    removeItem(key) { store.delete(key); }
  };

  const sandbox = {
    console,
    document: {
      getElementById(id) { return elements[id] || null; }
    },
    localStorage,
    fetch: fetchImpl,
    window: {
      location: { hostname, protocol },
      setTimeout,
      clearTimeout
    },
    setTimeout,
    clearTimeout
  };
  sandbox.window.document = sandbox.document;
  sandbox.window.localStorage = localStorage;
  sandbox.window.fetch = fetchImpl;
  sandbox.globalThis = sandbox.window;

  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'launch.js' });

  return {
    elements,
    store,
    async submit(name, email) {
      elements['waitlist-name'].value = name;
      elements['waitlist-email'].value = email;
      await listeners.submit({ preventDefault() {} });
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    async settle() {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; }
  };
}

const checks = [];
let fail = 0;
const check = (name, pass, detail) => {
  checks.push({ name, pass: !!pass, detail: detail || '' });
  if (!pass) fail++;
};

(async () => {
  {
    const calls = [];
    const h = createHarness({
      hostname: 'fwwright1001-coder.github.io',
      protocol: 'https:',
      fetchImpl: async (...args) => { calls.push(args); throw new Error('should not fetch on Pages'); }
    });
    await h.settle();
    check('GitHub Pages shows fallback status',
      /GitHub Pages fallback active/.test(h.elements['waitlist-status'].textContent),
      h.elements['waitlist-status'].textContent);
    await h.submit('Marty Driver', 'MARTY@example.com');
    const saved = JSON.parse(h.store.get('wrt.roadCrew.local.v1') || '[]');
    check('GitHub Pages fallback saves one local signup', saved.length === 1, JSON.stringify(saved));
    check('GitHub Pages fallback normalizes email', saved[0] && saved[0].email === 'marty@example.com', JSON.stringify(saved[0]));
    check('GitHub Pages fallback does not call fetch', calls.length === 0, `calls=${calls.length}`);
    check('GitHub Pages fallback resets form', h.elements['waitlist-form'].resetCount === 1, `reset=${h.elements['waitlist-form'].resetCount}`);
  }

  {
    const calls = [];
    const h = createHarness({
      hostname: 'weekend-road-trip.vercel.app',
      protocol: 'https:',
      fetchImpl: async (url, opts) => {
        calls.push({ url, opts });
        if (!opts || opts.method === 'GET') return jsonResponse(200, { ok: true, count: 7 });
        return jsonResponse(200, { ok: true, email: 'driver@example.com', count: 8 });
      }
    });
    await h.settle();
    check('Vercel mode fetches cloud count', calls[0] && calls[0].url === '/api/waitlist', JSON.stringify(calls[0]));
    check('Vercel cloud count status renders', /7 Road Crew signups/.test(h.elements['waitlist-status'].textContent),
      h.elements['waitlist-status'].textContent);
    await h.submit('Driver', 'driver@example.com');
    const post = calls.find((call) => call.opts && call.opts.method === 'POST');
    check('Vercel submit posts to API', !!post && post.url === '/api/waitlist', JSON.stringify(post));
    check('Vercel submit sends JSON body', !!post && JSON.parse(post.opts.body).email === 'driver@example.com', post && post.opts.body);
    check('Vercel submit renders saved count', /Road Crew count: 8/.test(h.elements['waitlist-status'].textContent),
      h.elements['waitlist-status'].textContent);
  }

  {
    const calls = [];
    const h = createHarness({
      hostname: 'weekend-road-trip.vercel.app',
      protocol: 'https:',
      fetchImpl: async (url, opts) => {
        calls.push({ url, opts });
        if (!opts || opts.method === 'GET') return jsonResponse(200, { ok: true, count: 0 });
        return jsonResponse(503, { ok: false, error: 'Neon DATABASE_URL is not configured.' });
      }
    });
    await h.submit('No DB', 'nodb@example.com');
    check('503 API response explains Neon setup', /DATABASE_URL/.test(h.elements['waitlist-status'].textContent),
      h.elements['waitlist-status'].textContent);
    check('503 API response does not local-save silently', !h.store.has('wrt.roadCrew.local.v1'));
  }

  {
    const calls = [];
    const h = createHarness({
      hostname: 'weekend-road-trip.vercel.app',
      protocol: 'https:',
      fetchImpl: async (...args) => { calls.push(args); return jsonResponse(200, { ok: true, count: 0 }); }
    });
    await h.submit('Bad', 'not-an-email');
    check('invalid email focuses email input', h.elements['waitlist-email'].focusCount === 1,
      `focus=${h.elements['waitlist-email'].focusCount}`);
    check('invalid email does not submit POST', !calls.some((call) => call[1] && call[1].method === 'POST'),
      JSON.stringify(calls));
  }

  for (const c of checks) {
    console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name + (c.detail ? '  - ' + c.detail : ''));
  }
  console.log('\nRoad Crew client contract: ' + (checks.length - fail) + '/' + checks.length + ' passed.');
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(2);
});
