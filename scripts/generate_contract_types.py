#!/usr/bin/env python3
"""Generate DTOs and sync canonical runtime contract inputs; fail on new shapes."""
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = ROOT / 'contracts/v1/brain.schema.json'
OUTPUT = ROOT / 'contracts/v1/brain.generated.ts'

def emit(schema):
    if '$ref' in schema:
        assert schema['$ref'].startswith('#/$defs/'), schema
        return schema['$ref'].split('/')[-1]
    if 'const' in schema:
        return json.dumps(schema['const'])
    if 'enum' in schema:
        return ' | '.join(json.dumps(v) for v in schema['enum'])
    if 'oneOf' in schema:
        return ' | '.join('(' + emit(v) + ')' for v in schema['oneOf'])
    kind = schema.get('type')
    if kind == 'string': return 'string'
    if kind in ('integer', 'number'): return 'number'
    if kind == 'boolean': return 'boolean'
    if kind == 'null': return 'null'
    if kind == 'array': return 'ReadonlyArray<' + emit(schema['items']) + '>'
    if kind == 'object':
        if 'properties' not in schema:
            assert isinstance(schema.get('additionalProperties'), dict), schema
            return 'Readonly<Record<string, ' + emit(schema['additionalProperties']) + '>>'
        required = set(schema.get('required', []))
        fields = [f'readonly {json.dumps(k)}' + ('' if k in required else '?') + ': ' + emit(v) + ';' for k, v in schema['properties'].items()]
        assert schema.get('additionalProperties') is False, schema
        return '{ ' + ' '.join(fields) + ' }'
    if schema == {}: return 'JsonValue'
    raise ValueError(f'Unsupported schema: {schema}')

def render():
    definitions = json.loads(SCHEMA.read_text())['$defs']
    lines = ['// Generated from brain.schema.json. Edit the schema and regenerate.',
             '// Numeric bounds, regexes, formats and semantic invariants require runtime validation.',
             'export type JsonValue = null | boolean | number | string | ReadonlyArray<JsonValue> | { readonly [key: string]: JsonValue };']
    for name, schema in definitions.items():
        if name != 'JsonValue': lines.append(f'export type {name} = {emit(schema)};')
    return '\n'.join(lines) + '\n'

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    result = render()
    mirrors = [ROOT / 'packages/contracts/src/brain.generated.ts'] if (ROOT / 'packages/contracts/src').is_dir() else []
    assets = ['brain.schema.json', 'registry.json', 'state-machines.json', 'authorization-matrix.json', 'ports.ts']
    if args.check:
        for target in [OUTPUT] + mirrors:
            if not target.exists() or target.read_text() != result:
                raise SystemExit('Generated TypeScript is stale; run scripts/generate_contract_types.py')
        for name in assets if mirrors else []:
            if (ROOT / 'packages/contracts/src' / name).read_bytes() != (SCHEMA.parent / name).read_bytes():
                raise SystemExit('Runtime contracts are stale; run scripts/generate_contract_types.py')
    else:
        for target in [OUTPUT] + mirrors:
            target.write_text(result)
        if mirrors:
            for name in assets:
                (ROOT / 'packages/contracts/src' / name).write_bytes((SCHEMA.parent / name).read_bytes())
