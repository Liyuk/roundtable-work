// Real IM transport, kept outside runtime/ so that runtime code stays network-free. Pass it as `send` to the providers.
export async function fetchTransport(url, init) {
  const res = await globalThis.fetch(url, init);
  return { ok: res.ok, status: res.status };
}
