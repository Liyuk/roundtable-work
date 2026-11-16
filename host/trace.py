#!/usr/bin/env python3
# trace.py <session.jsonl> [N]: compact list of the last N tool calls / texts
import json,sys
f=sys.argv[1]; N=int(sys.argv[2]) if len(sys.argv)>2 else 30
out=[]
for line in open(f):
    try: e=json.loads(line)
    except: continue
    m=e.get("message") or {}
    ts=e.get("timestamp","")[11:19]
    if m.get("role")=="assistant":
        for c in m.get("content",[]):
            if c.get("type")=="toolCall":
                a=c.get("arguments",{}); s=a.get("command") or a.get("path") or json.dumps(a,ensure_ascii=False)
                out.append(f"{ts}Z {c.get('name')}: {str(s)[:160]}".replace("\n"," "))
            elif c.get("type")=="text" and c.get("text","").strip():
                out.append(f"{ts}Z TEXT: {c['text'][:160]}".replace("\n"," "))
    elif m.get("role")=="toolResult" and m.get("isError"):
        t="".join(x.get("text","") for x in m.get("content",[]))
        out.append(f"{ts}Z   ERR: {t[:120]}".replace("\n"," "))
print("\n".join(out[-N:]))
