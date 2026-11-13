审查结论：打回

Reviewed head: `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` (synthetic replay card).

One blocking finding is open, so the review is a rejection. Its evidence is reproducible.

```json
{
  "version": 1,
  "freeze": {
    "goal": "Blocking findings carry reproducible evidence",
    "baseSha": "1111111111111111111111111111111111111111",
    "headSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "reviewScope": ["runtime/lib/classify.mjs", "runtime/lib/review-ledger.mjs"],
    "highRisk": false,
    "mustFixIds": ["F1"]
  },
  "findings": [
    {
      "id": "F1",
      "summary": "An unevidenced rejection is still classified as a rejection",
      "severity": "high",
      "classification": "blocking",
      "status": "open",
      "evidence": "test/runtime/classify.test.mjs:70 — node --test test/runtime/classify.test.mjs → fails: expected reviewer_unavailable, got review_rejected"
    }
  ],
  "riskList": null
}
```
