/**
 * A drop-in replacement for WPT's /common/dispatcher/dispatcher.js.
 *
 * Upstream, `send()` and `receive()` are a polling HTTP queue on
 * dispatcher.py. That works cross-origin only because every wptserve origin is
 * the same process. Here the origins are genuinely separate static hosts with
 * nothing shared between them, so the transport is postMessage instead: a
 * remote context is always a direct child frame of the test, which is exactly
 * the topology the COS tests use.
 *
 * `RemoteContext` and `Executor` below are upstream's, unchanged, so the API
 * the tests see is the real one.
 */

'use strict';

const dispatcher_path = '/common/dispatcher/dispatcher.py';

function findLocationFromAncestors(w) {
  if (w.location.href == 'about:srcdoc') {
    return findLocationFromAncestors(w.parent);
  }
  return w.location;
}

function findLocation() {
  if (location.href == 'about:srcdoc') {
    return findLocationFromAncestors(self.parent);
  }
  if (location.protocol == 'blob:' || location.protocol == 'data:') {
    if (self.document && self.document.baseURI) {
      return self.document.baseURI;
    }
  }
  return location;
}

const dispatcherLocation = findLocation();

/* ---------------------------------------------------------------- transport */

const MAGIC = 'cos-wpt-dispatcher';
// Deliveries can be retried (see `send`), so receivers dedupe on message id.
const seen = new Set();
// uuid -> {queue: [payloads], waiters: [resolve]}
const mailboxes = new Map();
// uuid -> the window a reply for that uuid should be posted to.
const routes = new Map();
// id -> resolver, so a send returns the moment its acknowledgement lands
// rather than on the next poll.
const ackWaiters = new Map();

let nextId = 0;
const idPrefix = `${Math.random().toString(36).slice(2)}-`;

function mailbox(uuid) {
  let box = mailboxes.get(uuid);
  if (!box) {
    box = {queue: [], waiters: []};
    mailboxes.set(uuid, box);
  }
  return box;
}

function deliver(uuid, payload) {
  const box = mailbox(uuid);
  const waiter = box.waiters.shift();
  if (waiter) waiter(payload);
  else box.queue.push(payload);
}

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.magic !== MAGIC) return;
  if (data.kind === 'ack') {
    const waiter = ackWaiters.get(data.id);
    if (waiter) waiter();
    return;
  }
  if (data.kind !== 'msg') return;
  // Reply to whoever asked, even if we have never seen this uuid before.
  if (event.source) routes.set(data.uuid, event.source);
  try {
    event.source.postMessage({magic: MAGIC, kind: 'ack', id: data.id}, '*');
  } catch (e) {
    // The sender may already be gone; the message itself still counts.
  }
  if (seen.has(data.id)) return;
  seen.add(data.id);
  deliver(data.uuid, data.message);
});

/**
 * Finds the window that should receive traffic for `uuid`: an already-known
 * peer, the frame the test created for this uuid, or — when we are the
 * executor — whoever embedded us.
 */
function targetFor(uuid) {
  const known = routes.get(uuid);
  if (known) return known;
  if (self.document) {
    for (const frame of self.document.querySelectorAll('iframe, frame')) {
      const src = frame.getAttribute('src') || '';
      if (src.includes(`uuid=${uuid}`) && frame.contentWindow) {
        return frame.contentWindow;
      }
    }
  }
  if (self.parent && self.parent !== self) return self.parent;
  if (self.opener) return self.opener;
  return null;
}

/**
 * Posts until the peer acknowledges. Retrying matters because a test creates
 * the executor frame and immediately talks to it, long before the frame has a
 * document that could listen.
 */
const send = async function (uuid, message) {
  const id = idPrefix + (nextId++);
  const envelope = {magic: MAGIC, kind: 'msg', uuid, id, message};
  const deadline = Date.now() + 60000;
  const acknowledged = new Promise((resolve) => ackWaiters.set(id, resolve));
  try {
    while (true) {
      const target = targetFor(uuid);
      if (target) {
        try {
          target.postMessage(envelope, '*');
        } catch (e) {
          // Frame not navigated yet, or torn down. Retry.
        }
      }
      const settled = await Promise.race([
        acknowledged.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 50)),
      ]);
      if (settled) return;
      if (Date.now() > deadline) {
        throw new Error(`cos-wpt dispatcher: no peer acknowledged uuid ${uuid}`);
      }
    }
  } finally {
    ackWaiters.delete(id);
  }
};

const receive = async function (uuid) {
  const box = mailbox(uuid);
  if (box.queue.length) return box.queue.shift();
  return new Promise((resolve) => box.waiters.push(resolve));
};

/**
 * Upstream returns a URL that makes the server echo request headers into a
 * queue. There is no server here, so this is unavailable; nothing in the COS
 * suite uses it.
 */
const showRequestHeaders = function (origin, uuid) {
  throw new Error('cos-wpt dispatcher: showRequestHeaders() needs wptserve');
};

const cacheableShowRequestHeaders = showRequestHeaders;

/* ------------------------------------------------- upstream API, unchanged */

function remoteExecutorUrl(uuid, options) {
  const url = new URL('/common/dispatcher/remote-executor.html', dispatcherLocation);
  url.searchParams.set('uuid', uuid);

  if (options?.host) {
    url.host = options.host;
  }

  if (options?.protocol) {
    url.protocol = options.protocol;
  }

  return url;
}

class RemoteContext {
  constructor(uuid) {
    this.context_id = uuid;
  }

  async execute_script(fn, args) {
    const receiver = token();
    await this.send({receiver: receiver, fn: fn.toString(), args: args});
    const response = JSON.parse(await receive(receiver));
    if (response.status === 'success') {
      return response.value;
    }

    if (response.name === 'TypeError') {
      throw new TypeError(response.value);
    }
    throw new Error(response.value);
  }

  async send(msg) {
    return await send(this.context_id, JSON.stringify(msg));
  }
}

class Executor {
  constructor(uuid) {
    this.uuid = uuid;
    this.suspend_callback = null;
    this.execute();
  }

  suspend(callback) {
    this.suspend_callback = callback;
  }

  resume() {
  }

  async execute() {
    while (true) {
      if (this.suspend_callback !== null) {
        this.suspend_callback();
        this.suspend_callback = null;
        await new Promise((resolve) => this.resume = resolve);
        await new Promise((resolve) => setTimeout(resolve, 0));
        continue;
      }

      const task = JSON.parse(await receive(this.uuid));

      let response;
      try {
        const value = await eval(task.fn).apply(null, task.args);
        response = JSON.stringify({
          status: 'success',
          value: value
        });
      } catch (e) {
        response = JSON.stringify({
          status: 'exception',
          name: e.name,
          value: e.message
        });
      }
      await send(task.receiver, response);
    }
  }
}
