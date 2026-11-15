#!/usr/bin/env bash
set -euo pipefail
# The pinned client of one external MCP tool (ADR 0064). It runs only inside the launcher's sandbox, whose whole network is the egress
# proxy's grant for the one declared server host. Input on stdin: {"arguments": {...}, "mcp": {"url", "tool", "toolListDigest",
# "headers", "maxOutputBytes", "mode"}}; the runner builds "mcp" from the pinned Tool document, never the model.
# Exit 2: refused before the call was sent (nothing changed). Exit 3: the call was sent (its effect may be unknown).
exec python3 -c '
import hashlib, json, sys, urllib.error, urllib.request

def out(value, code=0):
    print(json.dumps(value))
    sys.exit(code)

def refuse(message): out({"error": message}, 2)
def failed(message): out({"error": message}, 3)

try:
    v = json.load(sys.stdin)
    m = v["mcp"]
    url, tool, pinned, headers, mode = m["url"], m["tool"], m.get("toolListDigest"), m.get("headers") or {}, m.get("mode", "call")
    limit = int(m.get("maxOutputBytes", 16384))
    arguments = v.get("arguments") or {}
except Exception:
    refuse("the call carried no pinned MCP definition")
if not isinstance(arguments, dict): refuse("arguments must be an object")

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k): return None
opener = urllib.request.build_opener(NoRedirect)
MAX_BODY = 2 * 1024 * 1024
session = {}
counter = [0]

def rpc(method, params=None, notify=False):
    counter[0] += 1
    body = {"jsonrpc": "2.0", "method": method}
    if params is not None: body["params"] = params
    if not notify: body["id"] = counter[0]
    h = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
    h.update(headers)
    h.update(session)
    request = urllib.request.Request(url, data=json.dumps(body).encode(), headers=h, method="POST")
    try:
        with opener.open(request, timeout=15) as response:
            raw = response.read(MAX_BODY + 1)
            kind = response.headers.get("Content-Type", "")
            sid = response.headers.get("Mcp-Session-Id")
            if sid: session["Mcp-Session-Id"] = sid
    except urllib.error.HTTPError as e:
        if 300 <= e.code < 400: raise RuntimeError("the server tried to redirect; redirects are refused")
        raise RuntimeError("the server answered HTTP %d" % e.code)
    except Exception as e:
        raise RuntimeError("the server could not be reached through the sandbox network (%s)" % type(e).__name__)
    if len(raw) > MAX_BODY: raise RuntimeError("the server answered with more than 2 MiB")
    if notify or not raw.strip(): return None
    text = raw.decode("utf-8", "replace")
    messages = []
    if "text/event-stream" in kind:
        for line in text.splitlines():
            if line.startswith("data:"):
                try: messages.append(json.loads(line[5:].strip()))
                except ValueError: pass
    else:
        try: parsed = json.loads(text)
        except ValueError: raise RuntimeError("the server did not answer with JSON")
        messages = parsed if isinstance(parsed, list) else [parsed]
    for message in messages:
        if isinstance(message, dict) and "method" in message and "id" in message:
            raise RuntimeError("the server asked the client for something (sampling, roots or elicitation); Brain answers none of these")
    for message in messages:
        if isinstance(message, dict) and message.get("id") == counter[0]:
            if "error" in message: raise RuntimeError("the server refused: %s" % str((message["error"] or {}).get("message", "error"))[:200])
            return message.get("result")
    raise RuntimeError("the server sent no answer to the request")

def canonical(x): return json.dumps(x, sort_keys=True, separators=(",", ":"), ensure_ascii=True)

try:
    rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "brain-governed-mcp", "version": "1"}})
    rpc("notifications/initialized", notify=True)
    tools, cursor = [], None
    for _ in range(20):
        result = rpc("tools/list", {"cursor": cursor} if cursor else {}) or {}
        tools += [{"name": t["name"], "description": t.get("description", ""), "inputSchema": t.get("inputSchema", {})} for t in result.get("tools", [])]
        cursor = result.get("nextCursor")
        if not cursor: break
    else:
        raise RuntimeError("the server listed more than 20 pages of tools")
except RuntimeError as e:
    refuse(str(e))
tools.sort(key=lambda t: t["name"])
digest = "sha256:" + hashlib.sha256(canonical(tools).encode()).hexdigest()
if mode == "list": out({"tools": tools, "toolListDigest": digest})
if digest != pinned:
    refuse("the server tool list changed since it was registered (pinned %s, now %s); a person must review it and register it again" % (pinned, digest))
if not any(t["name"] == tool for t in tools): refuse("the server no longer lists the tool %s" % tool)
try:
    result = rpc("tools/call", {"name": tool, "arguments": arguments}) or {}
except RuntimeError as e:
    failed(str(e))
parts = []
for item in result.get("content", []):
    if isinstance(item, dict) and item.get("type") == "text": parts.append(str(item.get("text", "")))
    elif isinstance(item, dict): parts.append("[%s content omitted]" % item.get("type", "unknown"))
if not parts and result.get("structuredContent") is not None: parts.append(json.dumps(result["structuredContent"]))
text = "\n".join(parts)
encoded = text.encode("utf-8")
truncated = len(encoded) > limit
if truncated: text = encoded[:limit].decode("utf-8", "ignore")
if result.get("isError"): failed("the tool reported an error: " + text[:500])
out({"tool": tool, "text": text, "truncated": truncated})
'
