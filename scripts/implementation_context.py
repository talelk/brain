#!/usr/bin/env python3
"""Print a focused reading index; never assert that implementation tasks passed."""
import argparse,json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser();p.add_argument('--schemas',action='store_true');p.add_argument('--oracles',action='store_true');p.add_argument('tasks',nargs='+');args=p.parse_args()
pack=json.loads((ROOT/'contracts/v1/task-packets.json').read_text())
selected=[]
for task in args.tasks:
    if task not in pack['tasks']:raise SystemExit('Unknown coverage task: '+task)
    selected.append(pack['tasks'][task])
result={'policy':'direct-target; no compatibility, historical migration or incremental delivery constraints',
 'readFirst':['AGENTS.md','contracts/v1/implementation-policy.json','contracts/v1/execution-plan.json'],
 'tasks':selected,'continuation':'Read the current ledger/checkpoint and inspect real files before acting.'}
if args.schemas:
    definitions=json.loads((ROOT/'contracts/v1/brain.schema.json').read_text())['$defs']
    names=sorted({name for task in selected for name in task['contractDefinitions']})
    result['schemaDefinitions']={name:definitions[name] for name in names}
    result['schemaNote']='Referenced definitions remain in the canonical schema; retrieve them by name only when needed.'
if args.oracles:
    ids={name for task in selected for name in task['oracleIds']}
    scenarios={name for task in selected for name in task['scenarioIds']}
    result['literalOracles']=[o for o in json.loads((ROOT/'contracts/v1/acceptance-oracles.json').read_text())['traces'] if o['id'] in ids]
    result['expectedObservations']=[{'scenarioId':c['id'],'expected':c['requiredObservation']} for c in json.loads((ROOT/'contracts/v1/scenario-catalog.json').read_text())['scenarios'] if c['id'] in scenarios]
print(json.dumps(result,indent=2))
