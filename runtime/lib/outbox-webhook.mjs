// Webhook sink for notification outbox items: POSTs each item's record (see buildNotifyRecord) as JSON to RT_NOTIFY_WEBHOOK_URL.
// Exports:
//   createWebhookSink({ env, send, sleep, maxAttempts, backoffMs })  { deliver(item) }, or null when RT_NOTIFY_WEBHOOK_URL is unset
//   withWebhook(provider, sink)  adds webhook delivery after an outbox provider, for notification items only
// Env is read at delivery time: RT_NOTIFY_WEBHOOK_URL, RT_NOTIFY_WEBHOOK_KEY (sent in the RT_NOTIFY_WEBHOOK_HEADER header,
// default x-rt-notify-key; as "<RT_NOTIFY_WEBHOOK_SCHEME> <key>" when RT_NOTIFY_WEBHOOK_SCHEME is set, else the raw key). The item id is the receiver's dedupe key and is the same on every attempt (at-least-once).
// Network: `send(url, init)` is injected and must resolve to { ok, status }; the real transport is scripts/im-transport.mjs.
// Errors carry only the HTTP status or "network error", never the URL, the key or the response body.
import { buildNotifyRecord } from './outbox-notify.mjs';

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createWebhookSink({ env, send, sleep = defaultSleep, maxAttempts = 3, backoffMs = 1000 }) {
  if (!env.RT_NOTIFY_WEBHOOK_URL) return null;
  return {
    async deliver(item) {
      const body = JSON.stringify(buildNotifyRecord(item, new Date().toISOString()));
      const keyHeader = env.RT_NOTIFY_WEBHOOK_HEADER || 'x-rt-notify-key';
      const { RT_NOTIFY_WEBHOOK_KEY: key, RT_NOTIFY_WEBHOOK_SCHEME: scheme } = env;
      const headers = { 'content-type': 'application/json', ...(key && { [keyHeader]: scheme ? `${scheme} ${key}` : key }) };
      let failure;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (attempt > 1) await sleep(backoffMs * 2 ** (attempt - 2));
        try {
          const res = await send(env.RT_NOTIFY_WEBHOOK_URL, { method: 'POST', headers, body });
          if (res.ok) return { ok: true, status: res.status };
          failure = `HTTP ${res.status}`;
        } catch {
          failure = 'network error';
        }
      }
      throw new Error(`webhook delivery failed after ${maxAttempts} attempts: ${failure}`);
    },
  };
}

// The provider delivers first, so a webhook failure never delays or repeats the provider's write.
export function withWebhook(provider, sink) {
  if (!sink) return provider;
  return {
    async deliver(item) {
      const receipt = await provider.deliver(item);
      if (item.kind === 'notification') await sink.deliver(item);
      return receipt;
    },
  };
}
