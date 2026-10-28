#!/usr/bin/env python3
"""Generate navigational indexes from canonical work/route/layout records."""
import argparse,json,re
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def load(path):return json.loads((ROOT/path).read_text())
def scenario_ids(text):
    result=set(re.findall(r'E\d{3}',text))
    for first,last in re.findall(r'E(\d{3})[–-](?:E)?(\d{3})',text):
        result.update(f'E{i:03}' for i in range(int(first),int(last)+1))
    return sorted(result)
def render():
    work=load('contracts/v1/work-plan.json')['tasks'];layout=load('contracts/v1/module-layout.json');screens=load('contracts/v1/ui-screen-contracts.json')
    cases=[]
    for line in (ROOT/'docs/implementation/11-acceptance-and-edge-cases.md').read_text().splitlines():
        match=re.match(r'^\| (E\d{3}) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|$',line)
        if match:
            id,trigger,expected,suites=match.groups();cases.append({'id':id,'trigger':trigger.strip(),'requiredObservation':expected.strip(),'suites':suites.strip().split('/'),'owners':[k for k,v in work.items() if id in scenario_ids(v['verify'])] or ['T50']})
    packets={}
    for id,task in work.items():
        packet={**task,'scenarioIds':scenario_ids(task['verify'])}
        commands=[]
        for test in re.findall(r'tests/[\w./-]+\.(?:test|spec)\.ts',task['verify']):
            suite=test.split('/')[1];suite='browser' if suite=='browser' else suite
            commands.append(f'rtk pnpm test:{suite} -- {test}'+(' --forbid-only --update-snapshots=none' if suite=='browser' else ''))
        if id in ['T19','T49']:commands.append('rtk pnpm bench -- '+('scheduler' if id=='T19' else 'baseline'))
        if id=='T50':commands=['rtk pnpm verify:full','rtk pnpm verify:release']
        packet['verificationCommands']=commands
        packet['oracleIds']=[o['id'] for o in load('contracts/v1/acceptance-oracles.json')['traces'] if set(o['scenarios']) & set(packet['scenarioIds'])]
        packets[id]=packet
    outputs={
      'contracts/v1/task-packets.json':json.dumps({'contractVersion':'brain.task-packets/v1','generatedFrom':'contracts/v1/work-plan.json','tasks':packets},indent=2,ensure_ascii=False)+'\n',
      'contracts/v1/scenario-catalog.json':json.dumps({'contractVersion':'brain.scenario-catalog/v1','generatedFrom':'docs/implementation/11-acceptance-and-edge-cases.md + contracts/v1/work-plan.json','scenarios':cases,'executionStatusSource':'artifacts/runtime/*/manifest.json'},indent=2,ensure_ascii=False)+'\n'}
    def block(path,name,content):
        text=(ROOT/path).read_text();start=f'<!-- BEGIN GENERATED {name} -->';end=f'<!-- END GENERATED {name} -->'
        assert text.count(start)==text.count(end)==1,path+' needs one generated block'
        before,rest=text.split(start);_,after=rest.split(end)
        outputs[path]=before+start+'\n'+content.strip()+'\n'+end+after
    rows=['| Target | Owns | Public entry | Forbidden |','|---|---|---|---|']
    rows += [f"| `{v['path']}` | {v['owns']} | `{v['public']}` | {v['forbidden']} |" for v in layout['roots']]
    rows += ['','Governor module folders share this one deployment:','','| Module | Folder | Responsibility |','|---|---|---|']
    rows += [f"| {k} | `{v['path']}` | {v['owns']} |" for k,v in layout['governorModules'].items()]
    block('docs/implementation/01-architecture-and-modules.md','LAYOUT','\n'.join(rows))
    rows=['| Task / dependencies | Files to create/change | Behavior and boundary | Verification and exit |','|---|---|---|---|']
    rows += [f"| {id} / {t['dependencies']} | {t['targetFiles']} | {t['behavior']} | {t['verify']} |" for id,t in work.items()]
    block('docs/implementation/12-implementation-tasks.md','TASKS','\n'.join(rows))
    rows=['| Route | Main area | Primary task | Essential content |','|---|---|---|---|']
    rows += [f"| `{s['route']}` | {s['navigationGroup']} | {s['task']} | {', '.join(s['content'])} |" for s in screens['screens']]
    block('docs/implementation/09-ux-and-ui.md','ROUTES','\n'.join(rows))
    return outputs
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--check',action='store_true');args=parser.parse_args()
    outputs=render()
    for name,content in outputs.items():
        path=ROOT/name
        if args.check:assert path.read_text()==content,'Stale generated index: '+name
        else:path.write_text(content)
    print(f'{len(outputs)} implementation indexes '+('fresh' if args.check else 'generated'))
if __name__=='__main__':main()
