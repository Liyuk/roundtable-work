审查结论：打回

Reviewed head: `bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb` (synthetic replay card).

Every finding here is speculation: there is no file:line, command output, or named test behind the blocking item, so the card is malformed and the reviewer must be retried once.

```json
{
  "version": 1,
  "freeze": {
    "goal": "Blocking findings carry reproducible evidence",
    "baseSha": "1111111111111111111111111111111111111111",
    "headSha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "reviewScope": ["runtime/lib/classify.mjs"],
    "highRisk": false,
    "mustFixIds": ["F1"]
  },
  "findings": [
    {
      "id": "F1",
      "summary": "This might behave badly under load",
      "severity": "high",
      "classification": "blocking",
      "status": "open",
      "evidence": ""
    }
  ],
  "riskList": null
}
```
