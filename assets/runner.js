/**
 * cos-wpt runner.
 *
 * Reads the Cross-Origin Storage pull request from GitHub, hands the resulting
 * file manifest to the service worker that serves it as a virtual WPT tree,
 * then runs each test in a frame and collects what testharness.js reports.
 */

const DEFAULTS = {
  prRepo: 'web-platform-tests/wpt',
  prNumber: 61811,
  upstreamRef: 'master',
  testPath: 'cross-origin-storage/',
  origins: {
    remote: 'https://cos-wpt-remote.github.io',
    notsamesite: 'https://cos-wpt-alt.github.io',
  },
  timeoutSeconds: 60,
  testHost: 'self',
};

const SETTINGS_KEY = 'cos-wpt:settings';
const BASE = new URL('./', location.href);
const MOUNT = new URL('wpt/', BASE);

const state = {
  settings: loadSettings(),
  manifest: null,
  tests: [],
  origins: [],          // [{origin, scope, rootScoped, ok, error}]
  running: false,
  abort: false,
};

/* ---------------------------------------------------------------- settings */

function loadSettings() {
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
  } catch (e) {
    stored = {};
  }
  const settings = {
    ...DEFAULTS,
    ...stored,
    origins: {...DEFAULTS.origins, ...(stored.origins || {})},
  };
  const params = new URLSearchParams(location.search);
  if (params.has('pr')) settings.prNumber = Number(params.get('pr'));
  if (params.has('repo')) settings.prRepo = params.get('repo');
  if (params.has('ref')) settings.upstreamRef = params.get('ref');
  if (params.has('remote')) settings.origins.remote = params.get('remote');
  if (params.has('notsamesite')) settings.origins.notsamesite = params.get('notsamesite');
  return settings;
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
}

/* ------------------------------------------------------------------ GitHub */

async function ghJson(url) {
  const key = `cos-wpt:etag:${url}`;
  let cached = null;
  try {
    cached = JSON.parse(localStorage.getItem(key) || 'null');
  } catch (e) { /* ignore */ }

  const headers = {Accept: 'application/vnd.github+json'};
  if (cached && cached.etag) headers['If-None-Match'] = cached.etag;

  let res;
  try {
    res = await fetch(url, {headers});
  } catch (e) {
    if (cached) return {data: cached.data, stale: true, note: 'offline; using cached response'};
    throw new Error(`could not reach api.github.com (${e.message})`);
  }

  // A 304 does not count against the unauthenticated rate limit, which is why
  // the ETag is worth keeping around.
  if (res.status === 304 && cached) return {data: cached.data, cached: true};
  if (!res.ok) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    const note = remaining === '0'
      ? 'GitHub API rate limit reached for this IP (60 requests/hour unauthenticated)'
      : `GitHub returned ${res.status}`;
    if (cached) return {data: cached.data, stale: true, note};
    throw new Error(note);
  }
  const data = await res.json();
  return {data, etag: res.headers.get('ETag'), key};
}

function rememberJson(result, data) {
  if (!result.etag || !result.key) return;
  try {
    localStorage.setItem(result.key, JSON.stringify({etag: result.etag, data}));
  } catch (e) { /* quota; caching is optional */ }
}

/** The PR head, plus every file it touches, as `{path: {sha, rawUrl}}`. */
async function loadManifest() {
  const {prRepo, prNumber} = state.settings;
  const notes = [];

  const prResult = await ghJson(`https://api.github.com/repos/${prRepo}/pulls/${prNumber}`);
  if (prResult.note) notes.push(prResult.note);
  const pr = prResult.data;
  rememberJson(prResult, {
    title: pr.title,
    state: pr.state,
    updated_at: pr.updated_at,
    head: {sha: pr.head.sha, ref: pr.head.ref, repo: {full_name: pr.head.repo.full_name}},
    html_url: pr.html_url,
  });

  const headRepo = pr.head.repo.full_name;
  const headSha = pr.head.sha;

  const files = {};
  for (let page = 1; page <= 30; page++) {
    const url = `https://api.github.com/repos/${prRepo}/pulls/${prNumber}/files?per_page=100&page=${page}`;
    const result = await ghJson(url);
    if (result.note) notes.push(result.note);
    const trimmed = result.data.map((f) => ({filename: f.filename, status: f.status, sha: f.sha}));
    rememberJson(result, trimmed);
    for (const file of trimmed) {
      if (file.status === 'removed') continue;
      files[file.filename] = {
        sha: file.sha,
        rawUrl: `https://raw.githubusercontent.com/${headRepo}/${headSha}/${file.filename}`,
      };
    }
    if (result.data.length < 100) break;
  }

  return {
    pr: {
      repo: prRepo,
      number: prNumber,
      title: pr.title,
      state: pr.state,
      updatedAt: pr.updated_at,
      htmlUrl: pr.html_url,
      headRepo,
      headSha,
      headRef: pr.head.ref,
    },
    upstreamRef: state.settings.upstreamRef,
    files,
    notes: [...new Set(notes)],
  };
}

/* ---------------------------------------------------- service worker wiring */

async function registerWorker() {
  if (!('serviceWorker' in navigator)) {
    throw new Error('this browser exposes no service worker, so the tests cannot be served');
  }
  const registration = await navigator.serviceWorker.register(
      new URL('sw.js', BASE), {scope: './'});
  await navigator.serviceWorker.ready;
  // `fetch()` from this page is only intercepted once the worker controls it,
  // and the runner reads the test sources through it. A hard reload loads the
  // page outside the worker's control on purpose, so recover with one ordinary
  // reload rather than quietly building the test list from 404s.
  if (!navigator.serviceWorker.controller) {
    await Promise.race([
      new Promise((resolve) =>
          navigator.serviceWorker.addEventListener('controllerchange', resolve, {once: true})),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
  }
  if (!navigator.serviceWorker.controller) {
    if (!sessionStorage.getItem('cos-wpt:reloaded-for-control')) {
      sessionStorage.setItem('cos-wpt:reloaded-for-control', '1');
      location.reload();
      await new Promise(() => {});
    }
    throw new Error('this page is not controlled by its service worker, so the ' +
                    'test tree cannot be served (a hard reload does this; reload normally)');
  }
  sessionStorage.removeItem('cos-wpt:reloaded-for-control');
  return registration;
}

function originConfig(origin, allOrigins, manifest) {
  const others = allOrigins.filter((o) => o !== origin);
  return {
    files: manifest.files,
    upstreamRef: manifest.upstreamRef,
    pr: manifest.pr,
    origins: {self: origin, remote: others[0] || null, notsamesite: others[1] || null},
  };
}

async function pushConfig(registration, config) {
  const worker = registration.active || registration.waiting || registration.installing;
  if (!worker) throw new Error('no service worker to configure');
  const channel = new MessageChannel();
  const acked = new Promise((resolve) => { channel.port1.onmessage = () => resolve(true); });
  worker.postMessage({type: 'cos-wpt:config', config}, [channel.port2]);
  const ok = await Promise.race([acked, new Promise((r) => setTimeout(() => r(false), 5000))]);
  if (!ok) throw new Error('the service worker did not acknowledge its configuration');
}

/**
 * A mirror is configured as a URL, which may carry a path when the mirror is a
 * project page rather than an origin root. The origin is what the tests see as
 * HTTPS_REMOTE_ORIGIN; the path is where this site lives on it.
 */
function parseMirror(value) {
  const url = new URL(value);
  const base = url.pathname.endsWith('/') ? url.pathname : url.pathname + '/';
  return {origin: url.origin, base, href: url.origin + base};
}

/** Registers and configures a mirror origin's worker inside this partition. */
function bootstrapOrigin(mirror, config) {
  const origin = mirror.origin;
  return new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.src = mirror.href + 'bootstrap.html';
    frame.setAttribute('allow', 'cross-origin-storage');
    frame.title = `cos-wpt bootstrap for ${origin}`;
    const timer = setTimeout(() => finish({
      origin, ok: false, error: 'no response (is the mirror deployed?)',
    }), 20000);

    function finish(result) {
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      frame.remove();
      resolve(result);
    }

    function onMessage(event) {
      const data = event.data;
      if (!data || data.magic !== 'cos-wpt-bootstrap') return;
      if (event.source !== frame.contentWindow) return;
      if (data.type === 'awaiting-config') {
        frame.contentWindow.postMessage({magic: 'cos-wpt-configure', config}, '*');
        return;
      }
      if (data.type === 'ready') {
        finish({origin, ok: true, scope: data.scope, rootScoped: data.rootScoped});
      } else if (data.type === 'error') {
        finish({origin, ok: false, error: data.error});
      }
    }

    window.addEventListener('message', onMessage);
    frameHost().appendChild(frame);
  });
}

function frameHost() {
  let host = document.getElementById('harness-frames');
  if (!host) {
    host = document.createElement('div');
    host.id = 'harness-frames';
    document.body.appendChild(host);
  }
  return host;
}

/* ------------------------------------------------------------- test list */

/** Reads a file out of the virtual tree the service worker serves. */
async function readTestFile(path) {
  const res = await fetch(new URL(path, MOUNT).href);
  if (!res.ok) throw new Error(`could not read ${path} (${res.status})`);
  return res.text();
}

function parseMeta(source) {
  const meta = {globals: ['window'], scripts: [], timeout: null};
  let sawGlobal = false;
  for (const line of source.split('\n')) {
    const m = line.match(/^\/\/\s*META:\s*(\w+)=(.*)$/);
    if (!m) {
      if (!/^\s*(\/\/.*)?$/.test(line)) break;
      continue;
    }
    if (m[1] === 'global') { meta.globals = m[2].split(',').map((s) => s.trim()); sawGlobal = true; }
    else if (m[1] === 'script') meta.scripts.push(m[2].trim());
    else if (m[1] === 'timeout') meta.timeout = m[2].trim();
  }
  if (!sawGlobal) meta.globals = ['window'];
  return meta;
}

function expandGlobals(globals) {
  const out = [];
  for (const g of globals) {
    if (g === 'worker') out.push('dedicatedworker', 'sharedworker', 'serviceworker');
    else out.push(g);
  }
  return [...new Set(out)];
}

const GLOBAL_SUFFIX = {
  window: '.any.html',
  dedicatedworker: '.any.worker.html',
  sharedworker: '.any.sharedworker.html',
  serviceworker: '.any.serviceworker.html',
};

/**
 * Reasons a test cannot run here. Each is a property of the host, not of the
 * implementation under test, so they are reported separately from failures.
 */
function unrunnableReason(test, env) {
  if (test.global === 'serviceworker') {
    return 'service worker globals need a real worker script, and a service ' +
           'worker registration bypasses the worker that serves this tree';
  }
  if (!test.path.includes('.https.')) {
    return 'this test must run in an insecure context, and github.io is ' +
           'HSTS-preloaded, so there is no http:// origin to run it on';
  }
  if (test.needsRemoteOrigin && !env.hasMirrors) {
    return 'needs HTTPS_REMOTE_ORIGIN and HTTPS_NOTSAMESITE_ORIGIN — configure ' +
           'two mirror origins in Settings';
  }
  if (test.needsRootScope && !env.anyRootScoped) {
    return 'hard-codes root-absolute paths such as ' +
           '/common/dispatcher/remote-executor.html on its own origin, which ' +
           'needs a host serving this site from an origin root; neither this ' +
           `host (${BASE.pathname}) nor any configured mirror is one`;
  }
  return null;
}

async function buildTests(manifest) {
  const {testPath} = state.settings;
  const paths = Object.keys(manifest.files)
      .filter((p) => p.startsWith(testPath))
      .filter((p) => !p.includes('/resources/'))
      .filter((p) => !/(^|\/)META\.yml$/.test(p))
      .sort();

  const tests = [];
  const unreadable = [];
  for (const path of paths) {
    let source = '';
    try {
      source = await readTestFile(path);
    } catch (e) {
      unreadable.push(path);
    }
    const needs = {
      needsRemoteOrigin: /HTTPS_REMOTE_ORIGIN|HTTPS_NOTSAMESITE_ORIGIN/.test(source),
      // Two tests build URLs as origin + a root-absolute path, which only a
      // root-scoped host can answer.
      needsRootScope: /cosOpenRemoteContext\(\s*HTTPS_ORIGIN/.test(source) ||
                      /['"]\/(cross-origin-storage|common)\/[^'"]*\.html['"]/.test(source),
    };

    if (/\.any\.js$/.test(path)) {
      const meta = parseMeta(source);
      for (const global of expandGlobals(meta.globals)) {
        const suffix = GLOBAL_SUFFIX[global];
        if (!suffix) continue;
        tests.push({
          path, global, meta, ...needs,
          url: path.replace(/\.any\.js$/, suffix),
          name: path.replace(/\.any\.js$/, suffix),
        });
      }
    } else if (/\.window\.js$/.test(path)) {
      const meta = parseMeta(source);
      tests.push({
        path, global: 'window', meta, ...needs,
        url: path.replace(/\.window\.js$/, '.window.html'),
        name: path.replace(/\.window\.js$/, '.window.html'),
      });
    } else if (/\.worker\.js$/.test(path)) {
      const meta = parseMeta(source);
      tests.push({
        path, global: 'dedicatedworker', meta, ...needs,
        url: path.replace(/\.worker\.js$/, '.worker.html'),
        name: path.replace(/\.worker\.js$/, '.worker.html'),
      });
    } else if (/\.html?$/.test(path)) {
      tests.push({path, global: 'window', meta: {timeout: null}, ...needs, url: path, name: path});
    }
  }
  return {tests, unreadable};
}

/* ------------------------------------------------------------- test running */

function testHostOrigin() {
  const choice = state.settings.testHost;
  if (choice === 'self') return location.origin;
  const entry = state.origins.find((o) => o.origin === choice && o.ok);
  return entry ? entry.origin : location.origin;
}

/**
 * Two tests build URLs as their own origin plus a root-absolute path, so they
 * are moved to an origin serving this site from its root whenever one exists,
 * even if the rest of the run is hosted here.
 */
function hostForTest(test) {
  const selected = testHostOrigin();
  const entry = state.origins.find((o) => o.origin === selected);
  if (test.needsRootScope && !(entry && entry.rootScoped)) {
    const rooted = state.origins.find((o) => o.ok && o.rootScoped);
    if (rooted) return rooted.origin;
  }
  return selected;
}

function testUrl(test) {
  const origin = hostForTest(test);
  const entry = state.origins.find((o) => o.origin === origin);
  const base = (entry && entry.scope) || BASE.pathname;
  return new URL(base + 'wpt/' + test.url, origin).href;
}

function timeoutFor(test) {
  const base = Number(state.settings.timeoutSeconds) * 1000;
  return test.meta && test.meta.timeout === 'long' ? base * 3 : base;
}

function runTest(test) {
  return new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.setAttribute('allow', 'cross-origin-storage; fullscreen');
    frame.title = test.name;
    let settled = false;

    const timer = setTimeout(() => finish({
      status: 'timeout',
      tests: [],
      message: `no result within ${Math.round(timeoutFor(test) / 1000)} s`,
    }), timeoutFor(test));

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      frame.remove();
      resolve(result);
    }

    function onMessage(event) {
      const data = event.data;
      if (!data || data.magic !== 'cos-wpt-report') return;
      if (event.source !== frame.contentWindow) return;
      if (data.type !== 'done') return;
      const harnessStatus = ['OK', 'ERROR', 'TIMEOUT', 'PRECONDITION_FAILED'][data.status.status] || 'ERROR';
      const subtests = data.tests || [];
      const statusName = (n) => ['PASS', 'FAIL', 'TIMEOUT', 'NOTRUN', 'PRECONDITION_FAILED'][n] || 'FAIL';
      const mapped = subtests.map((t) => ({
        name: t.name,
        status: statusName(t.status),
        message: t.message || '',
      }));
      let status;
      if (harnessStatus !== 'OK') status = harnessStatus.toLowerCase();
      else if (mapped.some((t) => t.status !== 'PASS')) status = 'fail';
      else status = 'pass';
      finish({status, tests: mapped, message: data.status.message || ''});
    }

    window.addEventListener('message', onMessage);
    frame.src = testUrl(test);
    frame.onerror = () => finish({status: 'error', tests: [], message: 'the frame failed to load'});
    frameHost().appendChild(frame);
  });
}

async function runAll(subset) {
  if (state.running) return;
  state.running = true;
  state.abort = false;
  document.getElementById('run-all').disabled = true;
  document.getElementById('stop').disabled = false;

  for (const test of subset) {
    if (state.abort) break;
    if (test.reason) continue;
    test.result = {status: 'running', tests: []};
    render();
    // Tests share one Cross-Origin Storage registry, so they run one at a
    // time rather than racing each other for it.
    test.result = await runTest(test);
    render();
  }

  state.running = false;
  state.abort = false;
  document.getElementById('run-all').disabled = false;
  document.getElementById('stop').disabled = true;
  render();
}

/* ------------------------------------------------------------------- render */

function visibleTests() {
  const filter = document.getElementById('filter').value.trim().toLowerCase();
  const hideSkipped = document.getElementById('hide-skipped').checked;
  return state.tests.filter((t) => {
    if (hideSkipped && t.reason) return false;
    if (!filter) return true;
    return t.name.toLowerCase().includes(filter);
  });
}

function renderEnvironment(entries) {
  const list = document.getElementById('env-list');
  list.innerHTML = '';
  for (const entry of entries) {
    const li = document.createElement('li');
    li.className = entry.level;
    li.append(entry.label);
    if (entry.detail) {
      const span = document.createElement('span');
      span.className = 'detail';
      span.append(entry.detail);
      li.append(' ', span);
    }
    list.append(li);
  }
}

function render() {
  const tests = visibleTests();
  const container = document.getElementById('tests');
  container.textContent = '';

  const counts = {pass: 0, fail: 0, skip: 0, other: 0};
  for (const test of state.tests) {
    if (test.reason) counts.skip++;
    else if (!test.result) counts.other++;
    else if (test.result.status === 'pass') counts.pass++;
    else if (test.result.status === 'running') counts.other++;
    else counts.fail++;
  }

  const summary = document.getElementById('summary');
  summary.hidden = false;
  summary.innerHTML =
      `<span class="pass">Passed <b>${counts.pass}</b></span>` +
      `<span class="fail">Failed <b>${counts.fail}</b></span>` +
      `<span class="skip">Unrunnable here <b>${counts.skip}</b></span>` +
      `<span>Not run <b>${counts.other}</b></span>` +
      `<span>Total <b>${state.tests.length}</b></span>`;

  for (const test of tests) {
    const details = document.createElement('details');
    details.className = 'test';
    if (test.open) details.open = true;
    details.addEventListener('toggle', () => { test.open = details.open; });

    const summaryEl = document.createElement('summary');
    const badge = document.createElement('span');
    const status = test.reason ? 'skip' : (test.result ? test.result.status : 'idle');
    badge.className = `badge ${status}`;
    badge.textContent = test.reason ? 'skipped' : status;
    const name = document.createElement('span');
    name.className = 'test-name';
    name.textContent = test.name.replace(state.settings.testPath, '');
    const countsEl = document.createElement('span');
    countsEl.className = 'test-counts';
    if (test.result && test.result.tests && test.result.tests.length) {
      const passed = test.result.tests.filter((t) => t.status === 'PASS').length;
      countsEl.textContent = `${passed}/${test.result.tests.length} subtests`;
    }
    const actions = document.createElement('span');
    actions.className = 'test-actions';
    const runOne = document.createElement('button');
    runOne.type = 'button';
    runOne.textContent = 'Run';
    runOne.disabled = state.running || !!test.reason;
    runOne.addEventListener('click', (event) => {
      event.preventDefault();
      runAll([test]);
    });
    const open = document.createElement('a');
    open.href = testUrl(test);
    open.target = '_blank';
    open.rel = 'noopener';
    open.textContent = 'Open';
    actions.append(runOne, open);

    summaryEl.append(badge, name, countsEl, actions);
    details.append(summaryEl);

    const body = document.createElement('div');
    body.className = 'test-body';
    if (test.reason) {
      const p = document.createElement('p');
      p.className = 'reason';
      p.textContent = test.reason;
      body.append(p);
    }
    if (test.result && test.result.message) {
      const p = document.createElement('p');
      p.className = 'reason';
      p.textContent = test.result.message;
      body.append(p);
    }
    if (test.result && test.result.tests && test.result.tests.length) {
      const ul = document.createElement('ul');
      ul.className = 'subtests';
      for (const sub of test.result.tests) {
        const li = document.createElement('li');
        const st = document.createElement('span');
        st.className = `st ${sub.status}`;
        st.textContent = sub.status;
        const wrap = document.createElement('span');
        wrap.append(sub.name);
        if (sub.message) {
          const msg = document.createElement('div');
          msg.className = 'msg';
          msg.textContent = sub.message;
          wrap.append(msg);
        }
        li.append(st, wrap);
        ul.append(li);
      }
      body.append(ul);
    }
    details.append(body);
    container.append(details);
  }

  if (!tests.length) {
    const p = document.createElement('p');
    p.className = 'pending';
    p.textContent = 'No tests match the current filter.';
    container.append(p);
  }
}

/* --------------------------------------------------------------- exporting */

function resultsJson() {
  return {
    generatedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    host: testHostOrigin(),
    pr: state.manifest ? state.manifest.pr : null,
    origins: state.origins,
    results: state.tests.map((t) => ({
      test: t.name,
      status: t.reason ? 'skipped' : (t.result ? t.result.status : 'notrun'),
      reason: t.reason || undefined,
      subtests: t.result ? t.result.tests : [],
    })),
  };
}

function markdownSummary() {
  const data = resultsJson();
  const rows = data.results.map((r) => `| \`${r.test}\` | ${r.status} | ${r.reason || ''} |`);
  return [
    `Cross-Origin Storage WPT run — ${data.generatedAt}`,
    `PR: ${data.pr ? `${data.pr.repo}#${data.pr.number} @ ${data.pr.headSha.slice(0, 7)}` : 'unknown'}`,
    `UA: ${data.userAgent}`,
    '',
    '| Test | Status | Note |',
    '| --- | --- | --- |',
    ...rows,
  ].join('\n');
}

/* ------------------------------------------------------------------- start */

function fillSettingsForm() {
  document.getElementById('pr-number').value = state.settings.prNumber;
  document.getElementById('pr-repo').value = state.settings.prRepo;
  document.getElementById('upstream-ref').value = state.settings.upstreamRef;
  document.getElementById('origin-remote').value = state.settings.origins.remote || '';
  document.getElementById('origin-notsamesite').value = state.settings.origins.notsamesite || '';
  document.getElementById('timeout').value = state.settings.timeoutSeconds;

  const select = document.getElementById('test-host');
  select.innerHTML = '';
  const options = [{value: 'self', label: `${location.origin} (this page)`}];
  for (const entry of state.origins.filter((o) => o.ok && o.origin !== location.origin)) {
    options.push({
      value: entry.origin,
      label: `${entry.origin}${entry.rootScoped ? ' (origin root)' : ''}`,
    });
  }
  for (const option of options) {
    const el = document.createElement('option');
    el.value = option.value;
    el.textContent = option.label;
    if (option.value === state.settings.testHost) el.selected = true;
    select.append(el);
  }
}

function wireUi() {
  document.getElementById('run-all').addEventListener('click', () => runAll(visibleTests()));
  document.getElementById('stop').addEventListener('click', () => { state.abort = true; });
  document.getElementById('refresh').addEventListener('click', () => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('cos-wpt:etag:')) localStorage.removeItem(key);
    }
    location.reload();
  });
  document.getElementById('filter').addEventListener('input', render);
  document.getElementById('hide-skipped').addEventListener('change', render);
  document.getElementById('settings-toggle').addEventListener('click', () => {
    const form = document.getElementById('settings');
    form.hidden = !form.hidden;
  });
  document.getElementById('settings').addEventListener('submit', (event) => {
    event.preventDefault();
    state.settings.prNumber = Number(document.getElementById('pr-number').value);
    state.settings.prRepo = document.getElementById('pr-repo').value.trim();
    state.settings.upstreamRef = document.getElementById('upstream-ref').value.trim() || 'master';
    state.settings.origins.remote = document.getElementById('origin-remote').value.trim();
    state.settings.origins.notsamesite = document.getElementById('origin-notsamesite').value.trim();
    state.settings.timeoutSeconds = Number(document.getElementById('timeout').value) || DEFAULTS.timeoutSeconds;
    state.settings.testHost = document.getElementById('test-host').value;
    saveSettings();
    location.href = location.pathname;
  });
  document.getElementById('settings-reset').addEventListener('click', () => {
    localStorage.removeItem(SETTINGS_KEY);
    location.href = location.pathname;
  });
  document.getElementById('export-json').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(resultsJson(), null, 2)], {type: 'application/json'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'cos-wpt-results.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
  document.getElementById('copy-summary').addEventListener('click', async () => {
    await navigator.clipboard.writeText(markdownSummary());
    const button = document.getElementById('copy-summary');
    const label = button.textContent;
    button.textContent = 'Copied';
    setTimeout(() => { button.textContent = label; }, 1500);
  });
}

async function main() {
  wireUi();
  const env = [];
  const push = (level, label, detail) => {
    env.push({level, label, detail});
    renderEnvironment(env);
  };

  push(self.isSecureContext ? 'ok' : 'bad', 'Secure context',
       self.isSecureContext ? '' : 'the tests need https');
  const hasCos = 'crossOriginStorage' in navigator;
  push(hasCos ? 'ok' : 'warn', 'navigator.crossOriginStorage',
       hasCos ? 'present' : 'missing — every test will fail until an implementation or extension provides it');

  let registration;
  try {
    registration = await registerWorker();
    const scope = new URL(registration.scope).pathname;
    push(scope === '/' ? 'ok' : 'warn', `Service worker at ${scope}`,
         scope === '/' ? 'origin root: root-absolute test paths work'
                       : 'not the origin root, so two tests that hard-code root-absolute paths cannot run here');
  } catch (error) {
    push('bad', 'Service worker', error.message);
    return;
  }

  let manifest;
  try {
    manifest = await loadManifest();
  } catch (error) {
    push('bad', 'Pull request', error.message);
    return;
  }
  state.manifest = manifest;
  document.getElementById('pr-link').href = manifest.pr.htmlUrl;
  document.getElementById('pr-link').textContent =
      `${manifest.pr.repo}#${manifest.pr.number}`;
  push('ok', `Pull request ${manifest.pr.repo}#${manifest.pr.number}`,
       `${manifest.pr.headRepo}@${manifest.pr.headSha.slice(0, 7)} · ${Object.keys(manifest.files).length} files · updated ${new Date(manifest.pr.updatedAt).toLocaleString()}`);
  for (const note of manifest.notes) push('warn', 'GitHub', note);

  const mirrors = [];
  for (const value of [state.settings.origins.remote, state.settings.origins.notsamesite]) {
    const trimmed = (value || '').trim();
    if (!trimmed) continue;
    try {
      const mirror = parseMirror(trimmed);
      if (mirror.origin !== location.origin) mirrors.push(mirror);
      else push('warn', 'Mirror', `${trimmed} is this same origin, so it cannot act as a remote origin`);
    } catch (e) {
      push('warn', 'Mirror', `${trimmed} is not a URL`);
    }
  }
  const allOrigins = [location.origin, ...mirrors.map((m) => m.origin)];

  await pushConfig(registration, originConfig(location.origin, allOrigins, manifest));
  state.origins.push({
    origin: location.origin,
    ok: true,
    scope: new URL(registration.scope).pathname,
    rootScoped: new URL(registration.scope).pathname === '/',
  });

  for (const mirror of mirrors) {
    const result = await bootstrapOrigin(mirror, originConfig(mirror.origin, allOrigins, manifest));
    state.origins.push(result);
    push(result.ok ? 'ok' : 'warn', `Mirror ${mirror.origin}`,
         result.ok ? `scope ${result.scope}${result.rootScoped ? ' (origin root)' : ''}` : result.error);
  }

  const hasMirrors = state.origins.filter((o) => o.ok && o.origin !== location.origin).length >= 2;
  if (!hasMirrors) {
    push('warn', 'Cross-origin coverage',
         'fewer than two usable mirror origins, so the cross-origin tests are marked unrunnable');
  }

  const built = await buildTests(manifest);
  state.tests = built.tests;
  if (built.unreadable.length) {
    push('bad', 'Test sources',
         `${built.unreadable.length} file(s) could not be read through the ` +
         `service worker, so their variants may be missing: ${built.unreadable.join(', ')}`);
  }
  fillSettingsForm();

  const envFacts = {
    hasMirrors,
    anyRootScoped: state.origins.some((o) => o.ok && o.rootScoped),
  };
  for (const test of state.tests) test.reason = unrunnableReason(test, envFacts);

  render();

  if (new URLSearchParams(location.search).has('autorun')) runAll(visibleTests());
}

main();
