#!/usr/bin/env bash
set -euo pipefail
exec python3 -c '
import json, sys
raw = sys.stdin.buffer.read(4097)
if len(raw) > 4096:
    print("input exceeds fixture limit", file=sys.stderr)
    raise SystemExit(2)
try:
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate key")
            result[key] = value
        return result
    value = json.loads(raw, object_pairs_hook=unique)
    if not isinstance(value, dict) or set(value) != {"message"}:
        raise ValueError("expected only message")
    message = value["message"]
    if not isinstance(message, str) or not 1 <= len(message) <= 128:
        raise ValueError("invalid message")
except (ValueError, UnicodeError):
    print("invalid fixture input", file=sys.stderr)
    raise SystemExit(2)
json.dump({"message": message}, sys.stdout, ensure_ascii=False)
sys.stdout.write("\n")
'
