/**
 * Stands in for WPT's /resources/testharnessreport.js.
 *
 * Upstream's version talks to wptrunner over a private protocol. This one
 * reports to whichever window embedded the test, which is how the cos-wpt
 * runner collects results — including from tests hosted on a different origin,
 * hence the `'*'` target origin.
 */

'use strict';

(function () {
  const target = self.parent && self.parent !== self ? self.parent : self.opener;
  if (!target) return;

  function post(message) {
    try {
      target.postMessage(Object.assign({magic: 'cos-wpt-report'}, message), '*');
    } catch (e) {
      // Nothing useful to do if the runner has gone away.
    }
  }

  post({type: 'loaded', url: location.href});

  // ---- Premises that cannot hold on a static host ------------------------
  //
  // Some subtests fail here for reasons unrelated to the browser under test.
  // Rather than list them, this watches for the moment a subtest's premise
  // breaks and tells the runner, which relabels that subtest INFEASIBLE if it
  // then fails. shims/dispatcher.js reports top-level windows the same way.

  let current = null;
  add_test_state_callback(function (test) {
    if (test.phase === test.phases.STARTED) current = test.name;
    watchOriginPools();
  });
  self.cosWptCurrentTest = function () { return current; };

  const reported = new Set();
  self.cosWptInfeasible = function (reason, test) {
    const name = test || current;
    if (!name || reported.has(name + '\n' + reason)) return;
    reported.add(name + '\n' + reason);
    post({type: 'infeasible', url: location.href, test: name, reason: reason});
  };

  // Schemeful sites of the origins in use, worked out by the runner from the
  // Public Suffix List. Empty when it could not fetch the list.
  let sites = {};
  try {
    sites = JSON.parse(new URLSearchParams(location.search).get('cos-sites') || '{}');
  } catch (e) {
    sites = {};
  }
  const normalize = function (origin) {
    try { return new URL(origin).origin; } catch (e) { return String(origin); }
  };
  const siteOf = function (origin) { return sites[normalize(origin)] || null; };

  // The tests pick their partner origins from pools in
  // cross-origin-storage/resources/cross-origin-helpers.js. Under wptserve the
  // same-site pool really is same-site and every pick is distinct; here a
  // pool can hand out a cross-site origin, this document's own origin, or the
  // same origin twice. Wrapped once the helpers have loaded, which they have
  // by the time a subtest starts.
  let poolsWatched = false;
  function watchOriginPools() {
    if (poolsWatched) return;
    poolsWatched = true;
    const picks = new Map();
    const watch = function (name, sameSite) {
      const original = self[name];
      if (typeof original !== 'function') return;
      self[name] = function () {
        const origin = original.apply(this, arguments);
        const here = normalize(location.origin);
        const picked = normalize(origin);
        if (!picks.has(current)) picks.set(current, new Set());
        const seen = picks.get(current);
        if (seen.has(picked)) {
          self.cosWptInfeasible(`The test's origin pools gave ${picked} twice in one ` +
              'subtest, so origins it needs to be distinct are one origin here.');
        }
        seen.add(picked);
        if (picked === here) {
          self.cosWptInfeasible(`${name}() gave this document's own origin, ${here}, ` +
              'as another origin.');
        }
        const siteHere = siteOf(here);
        const sitePicked = siteOf(picked);
        if (siteHere && sitePicked && sameSite && siteHere !== sitePicked) {
          self.cosWptInfeasible(`${name}() gave ${picked} as same site with ${here}, ` +
              `and here they are different sites (${sitePicked} and ${siteHere}).`);
        }
        if (siteHere && sitePicked && !sameSite && siteHere === sitePicked) {
          self.cosWptInfeasible(`${name}() gave ${picked} as cross-site with ${here}, ` +
              `and here they are the same site (${siteHere}).`);
        }
        return origin;
      };
    };
    watch('cosNextSameSiteOrigin', true);
    watch('cosNextCrossSiteOrigin', false);
  }

  // A service worker's script request bypasses the worker that serves this
  // tree, so a script that exists only there cannot be fetched. register()
  // rejects with a TypeError exactly when the script fetch fails.
  if (self.ServiceWorkerContainer && ServiceWorkerContainer.prototype.register) {
    const register = ServiceWorkerContainer.prototype.register;
    ServiceWorkerContainer.prototype.register = function (scriptURL, options) {
      const test = current;
      return register.call(this, scriptURL, options).catch(function (error) {
        if (error && error.name === 'TypeError') {
          self.cosWptInfeasible(`Registering the service worker ${scriptURL} failed ` +
              `(${error.name}): its script request bypasses the worker that serves ` +
              'this tree, and the static host does not have the file.', test);
        }
        throw error;
      });
    };
  }

  // Each subtest as it settles, so a file that times out still reports how
  // far it got.
  add_result_callback(function (test) {
    post({
      type: 'result',
      url: location.href,
      test: {name: test.name, status: test.status, message: test.message, stack: test.stack},
    });
  });

  add_completion_callback(function (tests, status, assertions) {
    post({
      type: 'done',
      url: location.href,
      status: {status: status.status, message: status.message, stack: status.stack},
      tests: tests.map(function (test) {
        return {
          name: test.name,
          status: test.status,
          message: test.message,
          stack: test.stack,
        };
      }),
    });
  });
})();
