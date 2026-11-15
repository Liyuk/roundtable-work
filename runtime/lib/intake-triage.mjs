// Pure triage: turns normalized intake reports into planned issue actions. No I/O.
const norm = (s) => s.trim().toLowerCase().replace(/\s+/g, ' ');

export function planTriage({ reports, openIssues, sourceLabel, keywords = [], excludeAuthors = [] }) {
  const excluded = excludeAuthors.map((a) => a.toLowerCase());
  const groups = new Map();
  for (const r of reports) {
    const text = norm(r.text);
    const kept = text && (keywords.length === 0 || keywords.some((k) => text.includes(k.toLowerCase())));
    if (!kept || excluded.includes(r.author.toLowerCase())) continue;
    const issue = openIssues.find((i) => text.includes(norm(i.title)));
    const key = issue ? `issue:${issue.number}` : `text:${text}`;
    if (!groups.has(key)) groups.set(key, { issue, reports: [] });
    groups.get(key).reports.push(r);
  }
  const plans = [...groups.values()].map(({ issue, reports }) => {
    if (issue) return { kind: 'comment', issue: issue.number, url: issue.url, reports: reports.map((r) => r.url) };
    const summary = reports[0].text.trim();
    const body = [
      'Source reports:',
      ...reports.map((r) => `- ${r.url} (${r.author})`),
      '',
      'Reproduction summary:',
      summary,
      '',
      'Acceptance criteria:',
      `1. The reported behavior no longer occurs for: ${summary}`,
      '2. Test covering it passes',
    ].join('\n');
    return { kind: 'create', title: summary, body, labels: ['rt:go', sourceLabel] };
  });
  return { plans };
}
