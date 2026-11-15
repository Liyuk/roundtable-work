// IM adapters for notification outbox items. Each subtype has one fixed template that reads only named payload fields,
// so tokens, host paths and raw logs in a payload never reach the message text.
// Exports:
//   loadRoutes({ channels, routes })  validates the routing table; returns { subtype: [channel names] } for all subtypes
//   createWebhookProvider({ root, name, urlEnv, env, send })  generic JSON POST {id, subtype, issue, text}
//   createSlackProvider({ root, name, urlEnv, env, send })    Slack incoming webhook JSON {text}
//   createTelegramProvider({ root, name, tokenEnv, chatEnv, env, send })  POST sendMessage {chat_id, text}
//   createImRouter({ routes, providers })  outbox provider: delivers a notification to each channel routed for its subtype
// Endpoints and secrets are read from env by variable name at delivery time. Each provider records its receipts in
// <root>/.roundtable/state/im-sent.jsonl, keyed by item id and channel; a repeated item returns the stored receipt.
// Network: this module makes no network call itself. `send(url, init)` is injected (REQUIRED) and must resolve to
// { ok, status }, a subset of an HTTP response. The real transport lives outside runtime/, in
// scripts/im-transport.mjs. A non-2xx response throws an Error with the status only.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const SENT_PATH = '.roundtable/state/im-sent.jsonl';
const TELEGRAM_API = 'https://api.telegram.org';

const TEMPLATES = {
  'merge-notice': ({ payload: { pr, head } }) => `PR #${pr} merged at ${head}`,
  'action-pending-confirmation': ({ issue, payload: { action } }) => `Action ${action} on issue #${issue} awaits confirmation`,
  'approval-request': ({ payload: { of, action } }) => `Approval requested for ${of}: ${action}`,
  'rollback-result': ({ payload: { of, state } }) => `Rollback of ${of}: ${state}`,
  'stall-alert': ({ payload: { of } }) => `Stall alert for ${of}`,
  digest: ({ payload: { state } }) => `Digest: ${state}`,
};

export function loadRoutes({ channels, routes }) {
  const table = Object.fromEntries(Object.keys(TEMPLATES).map((subtype) => [subtype, []]));
  for (const [subtype, names] of Object.entries(routes)) {
    if (!Object.hasOwn(TEMPLATES, subtype)) throw new TypeError(`unknown subtype: ${subtype}`);
    for (const name of names) if (!Object.hasOwn(channels, name)) throw new TypeError(`unknown channel: ${name}`);
    table[subtype] = names;
  }
  return table;
}

const text = (item) => TEMPLATES[item.payload.subtype](item);

async function post(send, url, body) {
  const res = await send(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`IM endpoint answered HTTP ${res.status}`);
  return { ok: true, status: res.status };
}

// Wraps a channel send so that a repeated item id on the same channel returns its stored receipt without a send.
function recorded(root, name, send) {
  const file = join(root, SENT_PATH);
  return async (item) => {
    const past = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
    const hit = past.find((record) => record.id === item.id && record.channel === name);
    if (hit) return hit.receipt;
    const receipt = await send(item);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify({ id: item.id, channel: name, receipt }) + '\n');
    return receipt;
  };
}

const requireSend = (send) => {
  if (typeof send !== 'function') throw new TypeError('send must be a function');
  return send;
};

export function createWebhookProvider({ root, name, urlEnv, env = process.env, send }) {
  requireSend(send);
  return {
    deliver: recorded(root, name, (item) => post(send, env[urlEnv], { id: item.id, subtype: item.payload.subtype, issue: item.issue, text: text(item) })),
  };
}

export function createSlackProvider({ root, name, urlEnv, env = process.env, send }) {
  requireSend(send);
  return { deliver: recorded(root, name, (item) => post(send, env[urlEnv], { text: text(item) })) };
}

export function createTelegramProvider({ root, name, tokenEnv, chatEnv, env = process.env, send }) {
  requireSend(send);
  return {
    deliver: recorded(root, name, (item) => post(send, `${TELEGRAM_API}/bot${env[tokenEnv]}/sendMessage`, { chat_id: env[chatEnv], text: text(item) })),
  };
}

export function createImRouter({ routes, providers }) {
  return {
    async deliver(item) {
      const channels = routes[item.payload.subtype] ?? [];
      for (const name of channels) await providers[name].deliver(item);
      return { ok: true, channels };
    },
  };
}
