// Optional loopback HTTP webhook listener: verifies a signed POST, appends it to the event inbox, then acknowledges.
// Not started by default; binds to 127.0.0.1 unless told otherwise. Node built-ins only.
import { createServer } from 'node:http';
import { openInbox } from './event-inbox.mjs';
import { verifySignature } from './intake-triggers.mjs';

const MAX_BYTES = 1024 * 1024;

// Resolves with the body, or null as soon as it exceeds maxBytes (the rest is not read).
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.pause();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createHandler({ verify = verifySignature, sources, inbox, maxBytes = MAX_BYTES }) {
  const counts = { accepted: 0, duplicate: 0, bad_signature: 0, unknown_source: 0, event_type: 0, too_large: 0, bad_request: 0, failed: 0 };

  const reply = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
    res.end(JSON.stringify(body));
  };

  async function route(req, res) {
    const [path] = req.url.split('?');
    const match = path.match(/^\/webhook\/([^/]+)$/);
    if (req.method !== 'POST' || !match) {
      res.writeHead(404).end();
      return;
    }
    const name = decodeURIComponent(match[1]);

    const rawBody = await readBody(req, maxBytes);
    if (rawBody === null) {
      counts.too_large++;
      reply(res, 413, { status: 'rejected', reason: 'too_large' });
      return;
    }
    if (!Object.hasOwn(sources, name)) {
      counts.unknown_source++;
      reply(res, 202, { status: 'ignored', reason: 'unknown_source' });
      return;
    }
    const source = sources[name];
    if (!verify(rawBody, req.headers['x-hub-signature-256'], source.secret)) {
      counts.bad_signature++;
      reply(res, 401, { status: 'rejected', reason: 'bad_signature' });
      return;
    }
    const eventType = req.headers['x-github-event'];
    if (!source.eventTypes.includes(eventType)) {
      counts.event_type++;
      reply(res, 202, { status: 'ignored', reason: 'event_type' });
      return;
    }
    const delivery = req.headers['x-github-delivery'];
    if (!delivery) {
      counts.bad_request++;
      reply(res, 400, { status: 'rejected', reason: 'bad_request' });
      return;
    }
    try {
      const accepted = inbox.accept({
        source_event_id: delivery, kind: 'webhook', issue: null,
        payload: { source: name, event_type: eventType, body: rawBody.toString('utf8') },
        receivedAt: Date.now(),
      });
      if (accepted) counts.accepted++;
      else counts.duplicate++;
      reply(res, 202, { status: accepted ? 'accepted' : 'duplicate' });
    } catch {
      counts.failed++;
      reply(res, 500, { status: 'failed' });
    }
  }

  const handler = (req, res) => route(req, res).catch(() => res.destroy());
  handler.counts = counts;
  return handler;
}

export async function start({ host = '127.0.0.1', port, root, ...options }) {
  const server = createServer(createHandler({ ...options, inbox: options.inbox ?? openInbox(root) }));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return server;
}
