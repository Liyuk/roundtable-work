审查结论：打回

Reviewed head: `cccccccccccccccccccccccccccccccccccccccc` (synthetic replay card).

F1 is properly evidenced, but the new in-scope miss F2 is speculation. One unevidenced blocking item is enough to make the card malformed.

```json
{
  "version": 1,
  "freeze": {
    "goal": "Blocking findings carry reproducible evidence",
    "baseSha": "1111111111111111111111111111111111111111",
    "headSha": "cccccccccccccccccccccccccccccccccccccccc",
    "reviewScope": ["runtime/lib/classify.mjs", "runtime/lib/review-ledger.mjs"],
    "highRisk": false,
    "mustFixIds": ["F1"]
  },
  "findings": [
    {
      "id": "F1",
      "summary": "Evidence rule is not documented in the reviewer prompt",
      "severity": "medium",
      "classification": "blocking",
      "status": "open",
      "evidence": ".agents/skills/roundtable-work/prompts/roles/reviewer.md:9 — grep -n evidence .agents/skills/roundtable-work/prompts/roles/reviewer.md → no match"
    },
    {
      "id": "F2",
      "summary": "The classifier may be slow on large finding lists",
      "severity": "low",
      "classification": "in-scope miss",
      "status": "open"
    }
  ],
  "riskList": null
}
```
