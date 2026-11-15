#!/usr/bin/env python3
"""Generate contracts/v1/openapi.json from the contract sources; the file is never edited by hand.

Sources: api-routes.json (route inventory), brain.schema.json (schemas), registry.json (commands, queries),
authorization-matrix.json (roles and scopes). The output is self-contained: every schema is a component.
"""
import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
V1 = ROOT / 'contracts/v1'
OUTPUT = V1 / 'openapi.json'
ERROR = {'$ref': '#/components/schemas/BrainError'}
DESCRIPTIONS = {'400': 'Invalid request', '401': 'Not signed in', '403': 'Not allowed', '404': 'Not found', '409': 'Conflict with current state',
                '410': 'Gone', '413': 'Too large', '422': 'Rejected by a domain rule', '429': 'Rate limited', '503': 'Not ready', 'default': 'Structured error'}


def load(name):
    return json.loads((V1 / name).read_text())


def rewrite(node):
    """Point every reference at a component: bare names (route inventory) and #/$defs/ (schema file)."""
    if isinstance(node, dict):
        out = {}
        for key, value in node.items():
            if key == '$ref' and isinstance(value, str):
                name = value.split('/')[-1]
                out[key] = f'#/components/schemas/{name}'
            else:
                out[key] = rewrite(value)
        return out
    if isinstance(node, list):
        return [rewrite(v) for v in node]
    return node


def operation_id(method, path):
    return method.lower() + '_' + re.sub(r'_+', '_', re.sub(r'[^A-Za-z0-9]+', '_', re.sub(r'\{([^}]+)\}', r'\1', path))).strip('_')


def render():
    routes = load('api-routes.json')
    schema = load('brain.schema.json')['$defs']
    registry = load('registry.json')
    matrix = load('authorization-matrix.json')
    paths = {}
    seen = set()
    for route in routes['routes']:
        method, path = route['method'], route['path']
        assert (method, path) not in seen, f'duplicate route {method} {path}'
        seen.add((method, path))
        op = {'operationId': operation_id(method, path)}
        if route.get('summary'):
            op['summary'] = route['summary']
        op['security'] = [{name: []} for name in route.get('auth', [])]
        for name in route.get('auth', []):
            assert name in routes['securitySchemes'], f'{method} {path}: unknown security scheme {name}'
        params = [{'name': n, 'in': 'path', 'required': True, 'schema': {'type': 'string'}} for n in re.findall(r'\{([^}]+)\}', path)]
        op['parameters'] = params + route.get('parameters', [])
        if not op['parameters']:
            del op['parameters']
        if 'request' in route:
            op['requestBody'] = route['request']
        if 'operation' in route:
            op['x-brain-operation'] = route['operation']
        responses = dict(route['responses'])
        for code in route.get('errors', []):
            responses[code] = {'description': DESCRIPTIONS[code], 'content': {'application/json': {'schema': {'$ref': 'BrainError'}}}}
        op['responses'] = dict(sorted(responses.items(), key=lambda kv: (kv[0] == 'default', kv[0])))
        paths.setdefault(path, {})[method.lower()] = op
    commands = [{'type': c['type'], 'schema': c['schema'], 'scope': c['scope'], 'authority': c['authority'], 'actors': c['actors']} for c in registry['commands']]
    roles = {name: role['scopes'] for name, role in matrix['roles'].items()}
    doc = {
        'openapi': '3.1.0',
        'info': routes['info'],
        'servers': routes['servers'],
        'paths': paths,
        'components': {'securitySchemes': routes['securitySchemes'], 'schemas': schema},
        'x-brain-commands': commands,
        'x-brain-queries': registry['queries'],
        'x-brain-roles': roles,
    }
    doc = rewrite(doc)
    names = set(schema)
    refs = set(re.findall(r'"#/components/schemas/([^"]+)"', json.dumps(doc)))
    assert refs <= names, f'unknown schema references: {sorted(refs - names)}'
    for command in commands:
        assert command['schema'] in names, f"command {command['type']} names unknown schema {command['schema']}"
    return json.dumps(doc, indent=1) + '\n'


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    result = render()
    if args.check:
        if not OUTPUT.exists() or OUTPUT.read_text() != result:
            raise SystemExit('OpenAPI is stale; run scripts/generate_openapi.py (edit contracts/v1/api-routes.json, never openapi.json)')
    else:
        OUTPUT.write_text(result)
