#!/usr/bin/env python3
"""Build/check a closed, disposable tool/evaluator configuration fixture."""
import argparse,hashlib,json,shutil,tempfile
from pathlib import Path
import yaml
ROOT=Path(__file__).resolve().parents[1]
DEST=ROOT/'examples/v1/golden-release'
def digest(raw):return 'sha256:'+hashlib.sha256(raw).hexdigest()
def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=True).encode()
def generate(target):
    target.mkdir(parents=True,exist_ok=True);entries=[]
    def put(path,raw):
        p=target/path;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(raw)
        p.chmod(0o755 if p.suffix=='.sh' else 0o644)
    put('ui-foundation.json',(ROOT/'contracts/v1/ui-foundation.json').read_bytes())
    def definition(kind,id,spec,package=None):
        value={'apiVersion':'brain.keyrus/v1','kind':kind,'metadata':{'id':id,'version':'1.0.0'},'spec':spec}
        raw=yaml.safe_dump(value,sort_keys=False).encode();path='config/'+id+'.yaml';put(path,raw)
        content=digest(raw)
        if package:
            files=[]
            for relative,data in sorted(package.items()):
                put('tools/'+id+'/'+relative,data)
                files.append({'path':relative,'mode':493 if relative.endswith('.sh') else 420,'digest':digest(data)})
            # TOOL.md metadata is part of executable package identity, without a self-reference.
            metadata=b'---\n'+raw+b'---\n\nDeterministic disposable fixture.\n'
            put('tools/'+id+'/TOOL.md',metadata);files.append({'path':'TOOL.md','mode':420,'digest':digest(metadata)})
            files.sort(key=lambda v:v['path']);package_index=canonical(files);put('tools/'+id+'/package-index.json',package_index+b'\n')
            content=digest(package_index)
        entries.append({'kind':kind,'id':id,'path':path,'digest':content,'definitionDigest':digest(raw)})
        return {'id':id,'digest':content}
    schemas={
      'echo-input.json':json.loads((ROOT/'examples/v1/schemas/echo-input.json').read_text()),
      'echo-output.json':json.loads((ROOT/'examples/v1/schemas/echo-output.json').read_text()),
      'eval-input.json':{'type':'object','properties':{'report':{'type':'object','properties':{'message':{'type':'string'}},'required':['message'],'additionalProperties':False}},'required':['report'],'additionalProperties':False},
      'check.json':{'type':'object','properties':{'passed':{'type':'boolean'},'checks':{'type':'array','items':{'type':'object','properties':{'id':{'type':'string'},'passed':{'type':'boolean'}},'required':['id','passed'],'additionalProperties':False}}},'required':['passed','checks'],'additionalProperties':False}}
    for name,value in schemas.items():put('schemas/'+name,json.dumps(value,indent=2).encode()+b'\n')
    policy=definition('Policy','fixture-policy',{'productionHumanApproval':'required','defaultEffect':'deny','allowedOperations':['fixture.echo','fixture.verify'],'deniedOperations':[],'maxMicroUsd':0,'maxRuntimeSeconds':120,'minimumIsolation':'ephemeral-container','separationOfDuties':True})
    wt=definition('WorkspaceType','fixture-type',{'defaultPolicy':policy,'packs':[],'maxConcurrentJobs':2})
    for id,trust,classes in [('fixture-tools','agent',['tool']),('fixture-evaluators','evaluator',['eval'])]:
        definition('RunnerGroup',id,{'organizationRef':'org_fixture','allowedWorkspaces':['fixture-workspace'],'jobClasses':classes,'isolation':'ephemeral-container','trust':trust,'maxSlotsPerRunner':1,'reserve':{'cpuMillicores':100,'memoryMb':128,'diskMb':128,'slots':0}})
    def tool(id,input_schema,output_schema,run,test):
        return definition('Tool',id,{'effectClass':'read','inputSchemaRef':'schemas/'+input_schema,'outputSchemaRef':'schemas/'+output_schema,'requiredCapabilities':['tool:bash','tool:python3'],'timeoutSeconds':10,'maxOutputBytes':1048576,'allowedEnvironments':['fixture'],'owner':'team_fixture','license':'LicenseRef-Internal','entrypoint':'run.sh','testEntrypoint':'test.sh'},
          {'run.sh':run,'test.sh':test,**{'schemas/'+n:(target/'schemas'/n).read_bytes() for n in [input_schema,output_schema]}})
    echo=tool('fixture.echo','echo-input.json','echo-output.json',(ROOT/'examples/v1/tool/run.sh').read_bytes(),(ROOT/'examples/v1/tool/test.sh').read_bytes())
    verify=b'''#!/usr/bin/env bash
set -euo pipefail
exec python3 -c '
import json,sys
v=json.load(sys.stdin)
message=v["report"]["message"]
checks=[{"id":"echo-message","passed":message=="Brain fixture"},{"id":"echo-bytes","passed":len(message.encode("utf-8"))==13}]
json.dump({"passed":all(x["passed"] for x in checks),"checks":checks},sys.stdout)
sys.stdout.write("\\n")
'
'''
    test=b'''#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
python3 -c 'import json,subprocess; r=subprocess.run(["bash","run.sh"],input=json.dumps({"report":{"message":"Brain fixture"}}),text=True,capture_output=True,check=True); assert json.loads(r.stdout)["passed"] is True; r=subprocess.run(["bash","run.sh"],input=json.dumps({"report":{"message":"wrong"}}),text=True,capture_output=True,check=True); assert json.loads(r.stdout)["passed"] is False; print("2 independent evaluator cases")'
'''
    verifier=tool('fixture.verify','eval-input.json','check.json',verify,test)
    evaluator=definition('Evaluator','fixture-evaluator',{'tool':verifier,'requiredChecks':['echo-message','echo-bytes'],'independence':'L2'})
    def placement(group):return {'group':group,'all':['os:linux','tool:bash','tool:python3','isolation:ephemeral-container'],'resources':{'cpuMillicores':500,'memoryMb':256,'diskMb':256,'slots':1},'isolation':'ephemeral-container'}
    workflow=definition('Workflow','fixture-workflow',{'inputSchemaRef':'schemas/echo-input.json','outputSchemaRef':'schemas/check.json','jobs':{
      'echo':{'kind':'dispatch','needs':[],'input':{'message':{'source':'input','pointer':'/message'}},'outputSchemaRef':'schemas/echo-output.json','timeoutSeconds':30,'uses':{'type':'tool','release':echo},'runsOn':placement('fixture-tools'),'effectClass':'read'},
      'verify':{'kind':'eval','needs':['echo'],'input':{'report':{'source':'job','jobId':'echo','pointer':''}},'outputSchemaRef':'schemas/check.json','timeoutSeconds':30,'evaluator':evaluator,'runsOn':placement('fixture-evaluators'),'independence':'L2'}},
      'outputs':{'passed':{'source':'job','jobId':'verify','pointer':'/passed'},'checks':{'source':'job','jobId':'verify','pointer':'/checks'}},'failFast':True,'deadlineSeconds':120})
    definition('Workspace','fixture-workspace',{'organizationRef':'org_fixture','displayName':'Brain verification fixture','typeRef':wt,'repositories':[],'runnerGroups':['fixture-tools','fixture-evaluators'],'workflows':[workflow],'memoryEnabled':False,'limits':{'concurrentJobs':2,'dailyMicroUsd':0,'dailyTokens':1}})
    brain=yaml.safe_load((ROOT/'examples/v1/config/brainconfig.yaml').read_text())['spec'];brain.update(defaultPolicy=policy,maxConcurrentJobs=2)
    definition('BrainConfig','fixture-brain',brain)
    files=[{'path':str(p.relative_to(target)),'digest':digest(p.read_bytes())} for p in sorted(target.rglob('*')) if p.is_file()]
    manifest={'contractVersion':'brain.golden-release/v1','environment':'fixture','productionReady':False,'entries':entries,'files':files,'manifestContentDigest':digest(canonical(files)),
      'input':{'message':'Brain fixture'},'expectedOutput':{'passed':True,'checks':[{'id':'echo-message','passed':True},{'id':'echo-bytes','passed':True}]}}
    put('manifest.json',json.dumps(manifest,indent=2).encode()+b'\n')
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--check',action='store_true');args=parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='brain-golden-') as temporary:
        target=Path(temporary);generate(target)
        produced={str(p.relative_to(target)):p.read_bytes() for p in target.rglob('*') if p.is_file()}
        if args.check:
            actual={str(p.relative_to(DEST)):p.read_bytes() for p in DEST.rglob('*') if p.is_file()}
            assert produced==actual,'Golden release is stale; rebuild intentionally'
        else:
            # Only fixture-owned outputs, never a user-supplied config directory.
            DEST.mkdir(parents=True,exist_ok=True)
            for path,data in produced.items():
                p=DEST/path;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(data)
                p.chmod(0o755 if p.suffix=='.sh' else 0o644)
        print(f'{len(produced)} closed golden release files; '+('fresh' if args.check else 'generated'))
if __name__=='__main__':main()
