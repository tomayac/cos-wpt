/**
 * cos-wpt — a virtual wptserve implemented as a service worker.
 *
 * The Cross-Origin Storage tests live in a WPT pull request, not in a
 * checkout, and GitHub Pages is a dumb static host. This worker bridges the
 * two: it serves the PR's files (fetched live from GitHub) and the rest of
 * the WPT infrastructure (fetched from web-platform-tests/wpt@master) at the
 * paths the tests expect, so an unmodified `<script src="/resources/
 * testharness.js">` resolves even though nothing of the sort exists in this
 * repository.
 *
 * The load-bearing detail is that a service worker's scope restricts which
 * *clients* it controls, not which *requests* it sees. Once a test page under
 * the scope is controlled, its root-absolute subresource requests are ours to
 * answer, wherever they point.
 */

'use strict';

const SCOPE = new URL(self.registration.scope);
// Site root, e.g. '/cos-wpt/' on a project page or '/' on a user/org page.
const BASE = SCOPE.pathname;
// Virtual WPT root. Tests are addressed as `<MOUNT><wpt path>`.
const MOUNT = BASE + 'wpt/';

const CONFIG_CACHE = 'cos-wpt-config';
const CONFIG_KEY = new URL(BASE + '__cos-wpt-config', SCOPE.origin).href;
const CONTENT_CACHE = 'cos-wpt-content-v1';

const UPSTREAM_RAW = 'https://raw.githubusercontent.com/web-platform-tests/wpt/';

// wptserve rewrites a handful of URLs before they reach the filesystem
// (tools/serve/serve.py). Only this one matters for the COS suite, via
// idlharness's `// META: script=/resources/WebIDLParser.js`.
const REWRITES = {
  'resources/WebIDLParser.js': 'resources/webidl2/lib/webidl2.js',
};

// Paths under BASE that belong to the runner itself and must never be
// mistaken for WPT content.
const RUNNER_ASSETS = [
  '', 'index.html', 'bootstrap.html', 'sw.js', 'favicon.svg', 'README.md',
  '.nojekyll',
];
const RUNNER_DIRS = ['assets/', 'shims/'];

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

/* ------------------------------------------------------------------ config */

let configPromise = null;

function readConfig() {
  if (!configPromise) {
    configPromise = caches.open(CONFIG_CACHE)
      .then((c) => c.match(CONFIG_KEY))
      .then((r) => (r ? r.json() : null))
      .catch(() => null);
  }
  return configPromise;
}

async function writeConfig(config) {
  const cache = await caches.open(CONFIG_CACHE);
  await cache.put(CONFIG_KEY, new Response(JSON.stringify(config), {
    headers: {'Content-Type': 'application/json'},
  }));
  configPromise = Promise.resolve(config);
  // Blobs are addressed by commit SHA, so stale entries are dead weight
  // rather than a correctness problem. Prune them anyway.
  const wanted = new Set(Object.values(config.files || {}).map((f) => f.rawUrl));
  const content = await caches.open(CONTENT_CACHE);
  for (const req of await content.keys()) {
    if (req.url.startsWith('https://raw.githubusercontent.com/') &&
        !wanted.has(req.url) && !req.url.includes('/web-platform-tests/wpt/')) {
      await content.delete(req);
    }
  }
}

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data) return;

  // Reading a file straight from the worker, rather than fetching it through
  // the virtual tree, means the runner does not have to be a controlled client
  // to build its test list — which a hard reload, or DevTools' network bypass,
  // would otherwise prevent.
  // Lets the runner find out whether this worker is new enough to answer
  // reads, instead of discovering it one timeout at a time.
  if (data.type === 'cos-wpt:ping') {
    const port = (event.ports || [])[0];
    if (port) port.postMessage({ok: true});
    return;
  }

  if (data.type === 'cos-wpt:read') {
    event.waitUntil((async () => {
      const port = (event.ports || [])[0];
      if (!port) return;
      try {
        const target = new URL(MOUNT + data.path, SCOPE.origin);
        const response = await serve(data.path, target, null);
        const text = await response.text();
        port.postMessage(response.ok ? {ok: true, text} : {ok: false, status: response.status});
      } catch (err) {
        port.postMessage({ok: false, error: String((err && err.message) || err)});
      }
    })());
    return;
  }

  if (data.type !== 'cos-wpt:config') return;
  event.waitUntil((async () => {
    await writeConfig(data.config);
    for (const port of event.ports || []) port.postMessage({ok: true});
    if (event.source && !(event.ports || []).length) {
      event.source.postMessage({type: 'cos-wpt:config-ack', base: BASE, mount: MOUNT});
    }
  })());
});

/* ----------------------------------------------------------------- routing */

function isRunnerAsset(rest) {
  return RUNNER_ASSETS.includes(rest) || RUNNER_DIRS.some((d) => rest.startsWith(d));
}

/**
 * Maps a same-origin request path onto a path inside the virtual WPT root, or
 * returns null when the request belongs to the runner and should hit the
 * network unchanged.
 */
function toWptPath(pathname) {
  if (pathname.startsWith(MOUNT)) return decodeURI(pathname.slice(MOUNT.length));
  if (BASE !== '/' && pathname.startsWith(BASE)) return null;
  if (BASE === '/' && isRunnerAsset(pathname.slice(1))) return null;
  const rest = decodeURI(pathname.slice(1));
  return rest === '' ? null : rest;
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  const wptPath = toWptPath(url.pathname);
  if (wptPath === null) return;
  event.respondWith(serve(wptPath, url, event).catch((err) => new Response(
    `cos-wpt: ${err && err.message ? err.message : err}`,
    {status: 502, headers: {'Content-Type': 'text/plain; charset=utf-8'}})));
});

/* ------------------------------------------------------------------- serve */

const MIME = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  css: 'text/css; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  idl: 'text/plain; charset=utf-8',
  py: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

function mimeFor(path) {
  const ext = path.split('/').pop().split('.').pop().toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

function textResponse(body, path, extraHeaders) {
  const headers = new Headers(extraHeaders || {});
  headers.set('Content-Type', mimeFor(path));
  // The worker caches deliberately; leave nothing for the HTTP cache to get
  // wrong across reruns.
  headers.set('Cache-Control', 'no-store');
  return new Response(body, {headers});
}

async function serve(rawWptPath, url, event) {
  const wptPath = REWRITES[rawWptPath] || rawWptPath;
  const config = (await readConfig()) || {};
  const pipeHeaders = parsePipe(url.searchParams.get('pipe'));

  const generated = await generateVariant(wptPath, config);
  if (generated !== null) return textResponse(generated, wptPath, pipeHeaders);

  const shim = await serveShim(wptPath, config, event);
  if (shim !== null) return textResponse(shim, wptPath, pipeHeaders);

  if (wptPath === 'common/dispatcher/dispatcher.py') {
    return new Response(
      'cos-wpt: the wptserve message queue is replaced by a postMessage ' +
      'transport in shims/dispatcher.js; nothing should reach dispatcher.py.',
      {status: 501, headers: {'Content-Type': 'text/plain; charset=utf-8'}});
  }

  const source = await fetchSource(wptPath, config);
  if (!source) {
    return new Response(`cos-wpt: no source for ${wptPath}`, {
      status: 404, headers: {'Content-Type': 'text/plain; charset=utf-8'},
    });
  }
  if (/\.sub\.(js|html|css|txt)$/.test(wptPath)) {
    return textResponse(substitute(await source.text(), config), wptPath, pipeHeaders);
  }
  const headers = new Headers(pipeHeaders || {});
  headers.set('Content-Type', mimeFor(wptPath));
  headers.set('Cache-Control', 'no-store');
  return new Response(source.body, {headers});
}

/* ------------------------------------------------------------------ source */

/** The PR's own files first, then upstream master, both content-addressed. */
async function fetchSource(wptPath, config) {
  const entry = (config.files || {})[wptPath];
  if (entry) return cachedFetch(entry.rawUrl, {immutable: true});
  const ref = config.upstreamRef || 'master';
  return cachedFetch(UPSTREAM_RAW + ref + '/' + wptPath, {immutable: ref !== 'master'});
}

async function cachedFetch(url, {immutable} = {}) {
  const cache = await caches.open(CONTENT_CACHE);
  const hit = await cache.match(url);
  if (hit && immutable) return hit;
  try {
    const res = await fetch(url, {cache: immutable ? 'default' : 'no-cache'});
    if (res.ok) {
      await cache.put(url, res.clone());
      return res;
    }
    if (res.status === 404) return hit || null;
  } catch (err) {
    // Offline, rate limited, or blocked: a stale copy beats nothing.
  }
  return hit || null;
}

async function sourceText(wptPath, config) {
  const res = await fetchSource(wptPath, config);
  return res ? res.text() : null;
}

/* ------------------------------------------------------- generated variants */

/**
 * Rebuilds the wrapper documents that wpt's manifest generates on the fly for
 * `.any.js` and `.window.js` tests. Returns null when `wptPath` is not one.
 */
async function generateVariant(wptPath, config) {
  let m;
  if ((m = wptPath.match(/^(.+)\.any\.(html|worker\.html|worker\.js|sharedworker\.html|sharedworker\.js|serviceworker\.html|serviceworker\.js)$/))) {
    const src = await sourceText(m[1] + '.any.js', config);
    if (src === null) return null;
    const meta = parseMeta(src);
    const base = m[1].split('/').pop() + '.any.js';
    switch (m[2]) {
      case 'html':
        return windowWrapper(meta, base, true);
      case 'worker.html':
        return workerHostWrapper(m[1].split('/').pop() + '.any.worker.js', 'Worker');
      case 'sharedworker.html':
        return workerHostWrapper(m[1].split('/').pop() + '.any.sharedworker.js', 'SharedWorker');
      case 'serviceworker.html':
        return workerHostWrapper(m[1].split('/').pop() + '.any.serviceworker.js', 'ServiceWorker');
      default:
        return workerScript(meta, base, m[2].startsWith('shared') ? 'shared' : m[2].startsWith('service') ? 'service' : 'dedicated');
    }
  }
  if ((m = wptPath.match(/^(.+)\.window\.html$/))) {
    const src = await sourceText(m[1] + '.window.js', config);
    if (src === null) return null;
    return windowWrapper(parseMeta(src), m[1].split('/').pop() + '.window.js', true);
  }
  return null;
}

/** Reads the `// META:` directives at the top of a generated-variant test. */
function parseMeta(source) {
  const meta = {globals: ['window'], scripts: [], variants: [], timeout: null};
  let sawGlobal = false;
  for (const line of source.split('\n')) {
    const m = line.match(/^\/\/\s*META:\s*(\w+)=(.*)$/);
    if (!m) {
      if (!/^\s*(\/\/.*)?$/.test(line)) break;
      continue;
    }
    const [, key, value] = m;
    if (key === 'global') { meta.globals = value.split(',').map((s) => s.trim()); sawGlobal = true; }
    else if (key === 'script') meta.scripts.push(value.trim());
    else if (key === 'variant') meta.variants.push(value.trim());
    else if (key === 'timeout') meta.timeout = value.trim();
  }
  if (!sawGlobal) meta.globals = ['window'];
  return meta;
}

/** `global=worker` is shorthand for all three worker flavours. */
function expandGlobals(globals) {
  const out = new Set();
  for (const g of globals) {
    if (g === 'worker') ['dedicatedworker', 'sharedworker', 'serviceworker'].forEach((x) => out.add(x));
    else out.add(g);
  }
  return [...out];
}

function windowWrapper(meta, testScript, isWindow) {
  const scripts = meta.scripts.map((s) => `<script src="${s}"></script>`).join('\n');
  return `<!doctype html>
<meta charset="utf-8">
<!-- Generated by cos-wpt from the test's // META: directives. -->
<script>
self.GLOBAL = {
  isWindow: function() { return ${isWindow}; },
  isWorker: function() { return false; },
  isShadowRealm: function() { return false; },
};
</script>
<script src="/resources/testharness.js"></script>
<script src="/resources/testharnessreport.js"></script>
${scripts}
<div id="log"></div>
<script src="${testScript}"></script>
`;
}

function workerHostWrapper(workerScriptName, kind) {
  const ctor = kind === 'SharedWorker'
    ? `new SharedWorker(${JSON.stringify(workerScriptName)})`
    : `new Worker(${JSON.stringify(workerScriptName)})`;
  return `<!doctype html>
<meta charset="utf-8">
<!-- Generated by cos-wpt. -->
<script src="/resources/testharness.js"></script>
<script src="/resources/testharnessreport.js"></script>
<div id="log"></div>
<script>
fetch_tests_from_worker(${ctor});
</script>
`;
}

function workerScript(meta, testScript, flavour) {
  const imports = meta.scripts
    .concat([testScript])
    .map((s) => `importScripts(${JSON.stringify(s)});`)
    .join('\n');
  return `// Generated by cos-wpt from the test's // META: directives.
self.GLOBAL = {
  isWindow: function() { return false; },
  isWorker: function() { return true; },
  isShadowRealm: function() { return false; },
};
importScripts("/resources/testharness.js");
${imports}
done();
`;
}

/* ------------------------------------------------------------------- shims */

/**
 * Infrastructure this worker replaces rather than proxies, because the
 * upstream version depends on wptserve behaviour a static host cannot offer.
 */
async function serveShim(wptPath, config, event) {
  if (wptPath === 'common/get-host-info.sub.js') {
    return hostInfo(config, await roleOverrides(event));
  }
  if (wptPath === 'resources/testharnessreport.js') return localFile('shims/testharnessreport.js');
  if (wptPath === 'common/dispatcher/dispatcher.js') return localFile('shims/dispatcher.js');
  if (wptPath === 'common/dispatcher/remote-executor.html') return localFile('shims/remote-executor.html');
  return null;
}

async function localFile(rel) {
  const res = await fetch(new URL(BASE + rel, SCOPE.origin).href, {cache: 'no-cache'});
  if (!res.ok) throw new Error(`cos-wpt: missing shim ${rel}`);
  return res.text();
}

/**
 * A generated stand-in for `/common/get-host-info.sub.js`. wptserve fills the
 * template in from its own multi-host configuration; here the extra origins
 * are whatever the runner was configured with.
 */
/**
 * The runner assigns these two roles per test rather than per origin, because
 * different tests need different origins to be root-scoped. It passes its
 * choice on the test page's own URL, which is where these come from.
 */
async function roleOverrides(event) {
  let source = '';
  try {
    if (event && event.clientId) {
      const client = await self.clients.get(event.clientId);
      if (client && client.url) source = client.url;
    }
  } catch (err) {
    // No client (a navigation, or a worker); fall back to the referrer.
  }
  if (!source && event && event.request) source = event.request.referrer || '';
  if (!source) return null;
  try {
    const params = new URL(source).searchParams;
    const remote = params.get('cos-remote');
    const notsamesite = params.get('cos-notsamesite');
    if (!remote && !notsamesite) return null;
    return {remote, notsamesite};
  } catch (err) {
    return null;
  }
}

function hostInfo(config, overrides) {
  const origins = config.origins || {};
  const self_ = self.location.origin;
  const UNSET = 'https://cos-wpt-origin-not-configured.invalid';
  const remote = (overrides && overrides.remote) || origins.remote || UNSET;
  const notsamesite = (overrides && overrides.notsamesite) || origins.notsamesite || UNSET;
  const host = (o) => { try { return new URL(o).host; } catch { return o; } };
  const info = {
    HTTP_PORT: '80', HTTP_PORT2: '80', HTTPS_PORT: '443', HTTPS_PORT2: '443',
    HTTP_PORT_ELIDED: '', HTTPS_PORT_ELIDED: '', PORT: '443', PORT2: '443',
    ORIGINAL_HOST: host(self_),
    REMOTE_HOST: host(remote),
    NOTSAMESITE_HOST: host(notsamesite),
    ORIGIN: self_,
    HTTP_ORIGIN: self_.replace('https:', 'http:'),
    HTTPS_ORIGIN: self_,
    HTTPS_ORIGIN_WITH_CREDS: self_.replace('https://', 'https://foo:bar@'),
    HTTP_ORIGIN_WITH_DIFFERENT_PORT: self_.replace('https:', 'http:'),
    REMOTE_ORIGIN: remote,
    OTHER_ORIGIN: notsamesite,
    HTTP_REMOTE_ORIGIN: remote.replace('https:', 'http:'),
    HTTP_NOTSAMESITE_ORIGIN: notsamesite.replace('https:', 'http:'),
    HTTP_REMOTE_ORIGIN_WITH_DIFFERENT_PORT: remote.replace('https:', 'http:'),
    HTTPS_REMOTE_ORIGIN: remote,
    HTTPS_REMOTE_ORIGIN_WITH_CREDS: remote.replace('https://', 'https://foo:bar@'),
    HTTPS_NOTSAMESITE_ORIGIN: notsamesite,
    HTTPS_OTHER_NOTSAMESITE_ORIGIN: notsamesite,
    UNAUTHENTICATED_ORIGIN: notsamesite.replace('https:', 'http:'),
    AUTHENTICATED_ORIGIN: notsamesite,
  };
  return `// Generated by cos-wpt in place of wptserve's template substitution.
// HTTPS_REMOTE_ORIGIN and HTTPS_NOTSAMESITE_ORIGIN are the mirror origins the
// runner was configured with; both are separate sites here, whereas under
// wptserve the remote origin is same-site.
function get_host_info() {
  return ${JSON.stringify(info, null, 2)};
}

function get_port(loc) {
  if (loc.port) return loc.port;
  return loc.protocol === 'https:' ? '443' : '80';
}
`;
}

/** Best-effort wptserve template substitution for other `.sub.` files. */
function substitute(text, config) {
  const origins = config.origins || {};
  const selfHost = self.location.host;
  const remoteHost = origins.remote ? new URL(origins.remote).host : selfHost;
  const altHost = origins.notsamesite ? new URL(origins.notsamesite).host : selfHost;
  return text
    .replace(/\{\{host\}\}/g, selfHost)
    .replace(/\{\{location\[host\]\}\}/g, selfHost)
    .replace(/\{\{domains\[\]\}\}/g, selfHost)
    .replace(/\{\{domains\[[^\]]*\]\}\}/g, remoteHost)
    .replace(/\{\{hosts\[alt\]\[[^\]]*\]\}\}/g, altHost)
    .replace(/\{\{hosts\[\]\[[^\]]*\]\}\}/g, remoteHost)
    .replace(/\{\{ports\[https\]\[\d\]\}\}/g, '443')
    .replace(/\{\{ports\[http\]\[\d\]\}\}/g, '80')
    .replace(/\{\{ports\[ws\]\[\d\]\}\}/g, '80')
    .replace(/\{\{ports\[wss\]\[\d\]\}\}/g, '443');
}

/* -------------------------------------------------------------------- pipes */

/**
 * Implements just enough of wptserve's `?pipe=` to cover `header(name,value)`,
 * which the Permissions Policy tests use to put a real response header on the
 * remote executor. Values arrive with wptserve's backslash escaping intact.
 */
function parsePipe(pipe) {
  if (!pipe) return null;
  const headers = {};
  for (const part of splitUnescaped(pipe, '|')) {
    const m = part.match(/^header\((.*)\)$/s);
    if (!m) continue;
    const args = splitUnescaped(m[1], ',');
    if (args.length < 2) continue;
    const name = unescapePipe(args[0]).trim();
    const value = unescapePipe(args.slice(1).join(','));
    headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
  }
  return Object.keys(headers).length ? headers : null;
}

function splitUnescaped(text, sep) {
  const out = [];
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\' && i + 1 < text.length) { cur += ch + text[++i]; continue; }
    if (ch === sep) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function unescapePipe(text) {
  return text.replace(/\\(.)/g, '$1');
}
