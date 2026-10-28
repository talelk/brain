#!/usr/bin/env bash
set -euo pipefail
tool_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
python3 - "$tool_dir/run.sh" <<'PY'
import json, subprocess, sys
tool = sys.argv[1]
for value in ['hello', '$(touch forbidden)', 'bonjour été', '"quoted"']:
    result = subprocess.run(['bash', tool], input=json.dumps({'message': value}), text=True, capture_output=True, timeout=5)
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {'message': value}
for raw in ['{}', '{"message":1}', '{"message":"a","message":"b"}', '{"message":"a","extra":1}', 'x', 'x' * 4097]:
    result = subprocess.run(['bash', tool], input=raw, text=True, capture_output=True, timeout=5)
    assert result.returncode != 0 and not result.stdout, result
print('fixture tool: 4 valid and 6 invalid cases passed')
PY
