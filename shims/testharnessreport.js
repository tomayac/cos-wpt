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
