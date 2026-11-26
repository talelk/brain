#!/usr/bin/env bash
set -euo pipefail
# The one client of an external MCP tool (docs/model.md, "A tool"): it calls the tool that mcp.json beside it names, over Streamable HTTP,
# with the call's input from standard input. It runs in the tool sandbox like any script: the egress proxy decides what it reaches, and a
# secret, when the tool names one, arrives in the environment, goes out as a bearer token in a header file and is never an argument.
# It prints the tool's structured content, or its text, and exits 0; an error of the server or of the tool is {"error": "..."} and exit 2.

here="$(cd "$(dirname "$0")" && pwd)"
exec python3 -I -c '
import json, os, subprocess, sys, tempfile

VERSION = "2025-11-25"
TEXT_LIMIT = 200000

def fail(why):
    print(json.dumps({"error": why[:2000]}))
    sys.exit(2)

with open(os.path.join(sys.argv[1], "mcp.json")) as handle:
    config = json.load(handle)
try:
    arguments = json.load(sys.stdin)
except ValueError:
    fail("the input is not JSON")
secret = config.get("secretEnv")
token = os.environ.get(secret, "") if secret else ""
if secret and not token:
    fail("the secret of this tool is not available to it")

session = None
version = None
with tempfile.TemporaryDirectory() as tmp:
    def send(message, method="POST"):
        """One HTTP request; returns (status, headers, body)."""
        request = os.path.join(tmp, "headers")
        with open(request, "w") as handle:
            handle.write("Content-Type: application/json\nAccept: application/json, text/event-stream\n")
            if token:
                handle.write("Authorization: Bearer " + token + "\n")
            if session:
                handle.write("Mcp-Session-Id: " + session + "\n")
            if version:
                handle.write("MCP-Protocol-Version: " + version + "\n")
        received, body = os.path.join(tmp, "received"), os.path.join(tmp, "body")
        cmd = ["curl", "-q", "--silent", "--show-error", "--proto", "=http,https", "--max-time", str(config["timeout"]), "--max-filesize", "5000000",
               "--user-agent", "brain-mcp/1", "--request", method, "--header", "@" + request, "--dump-header", received, "--output", body, "--write-out", "%{http_code}"]
        if message is not None:
            cmd += ["--data-binary", "@-"]
        cmd += ["--", config["url"]]
        run = subprocess.run(cmd, input=None if message is None else json.dumps(message), capture_output=True, text=True)
        status = int(run.stdout.strip() or 0)
        headers = {}
        if os.path.exists(received):
            with open(received, errors="replace") as handle:
                for line in handle:
                    name, colon, value = line.partition(":")
                    if colon:
                        headers[name.strip().lower()] = value.strip()
        text = ""
        if os.path.exists(body):
            with open(body, errors="replace") as handle:
                text = handle.read()
            os.remove(body)
        # A stream of events that ends late still holds the answer: curl is judged only when nothing came.
        if run.returncode != 0 and not text:
            fail("the server could not be reached (curl exit %d): %s" % (run.returncode, run.stderr[:300].replace("\n", " ").strip()))
        return status, headers, text

    def answer(number, method, params):
        """A JSON-RPC request and its result."""
        status, headers, text = send({"jsonrpc": "2.0", "id": number, "method": method, "params": params})
        if status != 200:
            fail("the server answered %d to %s%s" % (status, method, ": " + text[:300] if text else ""))
        if "text/event-stream" in headers.get("content-type", ""):
            messages = []
            for block in text.replace("\r\n", "\n").split("\n\n"):
                data = "\n".join(line[5:].lstrip() for line in block.split("\n") if line.startswith("data:"))
                if data:
                    messages.append(data)
        else:
            messages = [text]
        for raw in messages:
            try:
                reply = json.loads(raw)
            except ValueError:
                continue
            if isinstance(reply, dict) and reply.get("id") == number:
                if "error" in reply:
                    fail("%s failed: %s" % (method, (reply["error"] or {}).get("message", "no message")))
                return headers, reply.get("result") or {}
        fail("the server sent no answer to " + method)

    headers, started = answer(1, "initialize", {"protocolVersion": VERSION, "capabilities": {}, "clientInfo": {"name": "brain", "version": "1"}})
    session = headers.get("mcp-session-id")
    version = started.get("protocolVersion", VERSION)
    send({"jsonrpc": "2.0", "method": "notifications/initialized"})
    _, result = answer(2, "tools/call", {"name": config["tool"], "arguments": arguments})
    if session:
        send(None, "DELETE")

content = result.get("content") or []
said = "\n".join(part.get("text", "") for part in content if isinstance(part, dict) and part.get("type") == "text")[:TEXT_LIMIT]
if result.get("isError"):
    fail(said or "the tool reported an error and said nothing")
structured = result.get("structuredContent")
if isinstance(structured, dict):
    print(json.dumps(structured))
elif structured is not None:
    print(json.dumps({"result": structured}))
else:
    other = sum(1 for part in content if not (isinstance(part, dict) and part.get("type") == "text"))
    print(json.dumps({"text": said, **({"other_parts": other} if other else {})}))
' "$here"
