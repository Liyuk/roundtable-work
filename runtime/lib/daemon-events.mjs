// Daemon events: GitHub observations become inbox events. Each source_event_id names the observation, and ids already in
// the inbox are skipped before any write, so producing the same observations again appends nothing.
const time = (value) => Date.parse(value);

/** `reader` is a GitHub reader (listIssues, listComments and optionally listChecks); `since` is an ISO string, epoch or absent. */
export async function produceEvents({ inbox, reader, since }) {
  const cutoff = since === undefined ? -Infinity : typeof since === 'number' ? since : time(since);
  const known = new Set(inbox.events().map((e) => e.source_event_id));
  const add = (event) => {
    if (known.has(event.source_event_id)) return;
    known.add(event.source_event_id);
    inbox.accept({ ...event, receivedAt: Date.now() });
  };
  for (const item of await reader.listIssues()) {
    if (time(item.updatedAt) > cutoff) {
      add({ source_event_id: `gh-issue:${item.number}:${item.updatedAt}`, kind: 'intake', issue: item.number, payload: { title: item.title } });
    }
    for (const comment of await reader.listComments(item.number)) {
      if (time(comment.createdAt) > cutoff) {
        add({ source_event_id: `gh-comment:${comment.id}`, kind: 'owner_comment', issue: item.number, payload: { body: comment.body } });
      }
    }
    // Checks carry no timestamp here; the known-id check keeps repeated reads from appending again.
    if (reader.listChecks) {
      for (const check of await reader.listChecks(item.number)) {
        add({ source_event_id: `gh-check:${check.suite}:${check.conclusion}`, kind: 'ci', issue: item.number, payload: { suite: check.suite, conclusion: check.conclusion } });
      }
    }
  }
}
