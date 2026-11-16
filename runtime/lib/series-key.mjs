/** Series key from the first `[...]` tag of an issue title, or null. `[RT-B7a]` → `rt-b7`; `[RT-F-1c]` → `rt-f-1`. */
export function seriesKey(title = '') {
  const token = /^\[([^\]]*)\]/.exec(title)?.[1]?.split(/[ /:]/)[0];
  if (!token) return null;
  return token.replace(/(\d)[a-z]$/, '$1').toLowerCase();
}
