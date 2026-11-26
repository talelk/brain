#!/usr/bin/env bash
set -euo pipefail
# web.render: open one https address in a headless browser, let its scripts run, and return the visible text and the links.
#   stdin:  {"url": "https://host/path", "max_chars": 8000, "wait_ms": 3000}
#   stdout: {"url", "final_url", "status", "title", "text", "links": [{"text", "href"}], "truncated"}
# A refused input or a failed page prints {"error": "..."} and exits 2.
# The tool sandbox's egress proxy decides which hosts answer (the tool's `network` list); the browser reaches the network only through it.
# The root is read-only: the browser keeps its profile and cache under /tmp.
export HOME=/tmp XDG_CONFIG_HOME=/tmp XDG_CACHE_HOME=/tmp
exec python3 "$(dirname "$0")/render.py"
