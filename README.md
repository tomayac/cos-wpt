# cos-wpt

Runs the [Cross-Origin Storage](https://wicg.github.io/cross-origin-storage/)
web platform tests in a browser, straight from the pull request that adds them
— [web-platform-tests/wpt#61811](https://github.com/web-platform-tests/wpt/pull/61811).

**→ <https://tomayac.github.io/cos-wpt/>**

Nothing here is a copy of the tests. Every file is fetched from GitHub when the
page loads, so pushing to the PR branch and reloading is the whole update
procedure.

## Why this exists

The COS tests are `.https.` tests with cross-origin frames, generated `.any.js`
variants, `?pipe=` response headers and root-absolute `/resources/…` includes.
Normally that means checking out ~2 GB of WPT and running `./wpt serve`. If all
you want is to point a browser (or an extension, or an experimental build) at
the tests, that is a lot of ceremony.

GitHub Pages is a static file host and cannot do any of it. So the runner brings
its own server, in the form of a service worker.

## How it works

```
                    ┌─────────────────────────────────────────┐
  api.github.com ──▶│ runner (index.html)                     │
  (PR head + files) │  · resolves the PR to a commit SHA      │
                    │  · hands the file manifest to the worker│
                    │  · runs each test in a frame            │
                    └───────────────┬─────────────────────────┘
                                    │ configures
                    ┌───────────────▼─────────────────────────┐
  raw.github…    ──▶│ sw.js — a virtual wptserve              │
  (PR blobs +       │  /wpt/cross-origin-storage/…  the PR    │
   wpt@master       │  /resources/…  /common/…      upstream  │
   infrastructure)  │  *.any.worker.html            generated │
                    │  ?pipe=header(…)              applied   │
                    └─────────────────────────────────────────┘
```

The load-bearing detail is that a service worker's **scope restricts which
clients it controls, not which requests it sees**. Once a test page under
`/cos-wpt/wpt/` is controlled, its request for `/resources/testharness.js` is
the worker's to answer, even though that path is nowhere near the scope.

What the worker does:

| Concern | Handling |
| --- | --- |
| The PR's own files | Fetched from `raw.githubusercontent.com` at the PR head SHA, cached in Cache Storage forever (the SHA makes them immutable) |
| `/resources/`, `/common/`, `/fonts/`, `/interfaces/` | Proxied from `web-platform-tests/wpt@master` |
| `/resources/WebIDLParser.js` | Rewritten to `/resources/webidl2/lib/webidl2.js`, as `tools/serve/serve.py` does |
| `.any.js`, `.window.js` | Wrapper documents and worker scripts generated from the `// META:` directives, one per `global=` |
| `?pipe=header(name,value)` | Parsed, unescaped and applied as real response headers — this is what makes the Permissions Policy test meaningful |
| `.sub.js` template variables | Substituted from the configured origins |

Three pieces of infrastructure are replaced rather than proxied, because they
depend on wptserve behaviour a static host cannot provide. They live in
[`shims/`](shims/):

- **`get-host-info.sub.js`** is generated per origin, so `HTTPS_ORIGIN`,
  `HTTPS_REMOTE_ORIGIN` and `HTTPS_NOTSAMESITE_ORIGIN` name the mirrors below.
- **`dispatcher.js`** keeps upstream's `RemoteContext` and `Executor` verbatim
  and swaps only the transport. Upstream polls `dispatcher.py`, which works
  cross-origin only because every wptserve origin is one process; here the
  origins are separate static hosts, so messages travel by `postMessage`
  between the test and its executor frame instead.
- **`testharnessreport.js`** reports results to the runner rather than to
  wptrunner.

## Mirror origins

Cross-origin tests need two more origins serving this same site. GitHub Pages
gives an account one origin, so the mirrors are separate `github.io` sites:

| Role | Origin |
| --- | --- |
| `HTTPS_REMOTE_ORIGIN` | [`cos-wpt-remote.github.io`](https://github.com/cos-wpt-remote/cos-wpt-remote.github.io) |
| `HTTPS_NOTSAMESITE_ORIGIN` | [`cos-wpt-alt.github.io`](https://github.com/cos-wpt-alt/cos-wpt-alt.github.io) |

Both are already set up. To reproduce them from scratch:

1. Create two free GitHub organisations at <https://github.com/organizations/new>.
   This is the only manual step — GitHub has no API for creating an organisation.
2. Run [`tools/setup-mirrors.sh`](tools/setup-mirrors.sh), which creates
   `<org>/<org>.github.io` in each (GitHub serves those at the origin **root**),
   configures Pages, and waits for both to answer.

The mirrors pull rather than being pushed to: each holds nothing but a workflow
that checks this public repository out and publishes it, hourly and on demand.
So there is no deploy key, no personal access token, and no second copy of the
site to drift out of date.

Any host works — a mirror is just a copy of this repository — and the origins
are editable in the runner's Settings panel, so `?remote=…&notsamesite=…` is
enough to try another pair without redeploying.

**Serving a mirror from the origin root matters.** Anything a test reaches
through `get_host_info()` is addressed as *origin + a root-absolute path* —
`cosOpenRemoteContext()` navigates to `/common/dispatcher/remote-executor.html`
on it, `transfer` to `/cross-origin-storage/resources/transfer-receiver.html`.
Only a worker scoped at `/` answers those, which a project page at `/cos-wpt/`
is not.

Which roles that constrains varies by test, and no single assignment satisfies
all of them here: `permissions-policy` needs its own origin *and*
`HTTPS_REMOTE_ORIGIN` root-scoped, while `transfer` needs its own origin *and*
`HTTPS_NOTSAMESITE_ORIGIN`. With two root-scoped mirrors and one project page
each is satisfiable, but only by a different arrangement. So the runner works
out an assignment per test and passes it on the test's own URL
(`?cos-remote=…&cos-notsamesite=…`), which the worker reads back when it
generates `get-host-info.sub.js`. A test with no workable assignment is
reported as unrunnable rather than left to fail misleadingly.

Because `github.io` is on the Public Suffix List, every `*.github.io` site is
its own site. `HTTPS_REMOTE_ORIGIN` is therefore cross-site here, where under
wptserve it is same-site-but-cross-origin. The COS scoping rules are
origin-based, so this does not change any expectation — but it does make the
suite a slightly weaker test of the same-site tier than a real WPT run.

## What cannot run here

The runner marks these unrunnable rather than failing them, with the reason
shown inline:

- **`insecure-context.tentative.any.*`** needs a non-secure origin, and
  `github.io` is HSTS-preloaded. There is no `http://` to run it on.
- **`*.any.serviceworker.html`** variants. A service worker script request
  bypasses service worker interception by design, so the generated worker script
  cannot be served from the virtual tree.

Everything else runs. Against a Chromium build launched with
`--enable-features=CrossOriginStorage`, a full run of the deployed site is
**22 passed, 5 failed, 8 unrunnable** — and those five are exactly the files
`wpt run` flags with "Unexpected subtest result" for the same build:
`cross-mechanism-interop`, `declarative-css/cross-origin-storage`,
`declarative-html/crossoriginstorage`, and both `import-attribute` tests.

## Using it

- **Run all** runs the suite serially — the tests share one COS registry, so
  they are deliberately not run in parallel.
- **Filter** narrows the list; **Run** on a row runs a single test; **Open**
  loads it directly, which is the fastest way to debug one in DevTools.
- **Export JSON** / **Copy summary** produce a result set with the UA, the PR
  head SHA and every subtest, for pasting into a bug or an issue.
- **Refresh** drops the cached GitHub responses and re-reads the PR.
- URL parameters: `?pr=`, `?repo=`, `?ref=` (the wpt ref used for
  infrastructure), `?remote=`, `?notsamesite=`, `?autorun`.

Unauthenticated GitHub API calls are limited to 60/hour per IP. The runner
stores ETags and revalidates, and a `304` does not count against that limit, so
ordinary reloads are cheap.

## Running it locally

The service worker needs a secure context, which `http://localhost` is:

```sh
python3 -m http.server 8123
# and, for the cross-origin tests, two more origins:
python3 -m http.server 8124
python3 -m http.server 8125
open "http://localhost:8123/?remote=http://localhost:8124&notsamesite=http://localhost:8125"
```

Different ports are different origins, which is enough for the executor
plumbing, but they are the *same site* — so the two origins-scoping subtests
that require a genuinely cross-site origin will fail locally and pass on the
deployed mirrors.

Do not use a hard reload while iterating: it loads the page outside the worker's
control. The runner notices and reloads once by itself.
