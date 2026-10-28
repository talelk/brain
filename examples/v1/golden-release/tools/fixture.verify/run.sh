#!/usr/bin/env bash
set -euo pipefail
exec python3 -c '
import json,sys
v=json.load(sys.stdin)
message=v["report"]["message"]
checks=[{"id":"echo-message","passed":message=="Brain fixture"},{"id":"echo-bytes","passed":len(message.encode("utf-8"))==13}]
json.dump({"passed":all(x["passed"] for x in checks),"checks":checks},sys.stdout)
sys.stdout.write("\n")
'
