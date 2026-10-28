#!/usr/bin/env python3
"""Validate current evidence records. Does not execute or certify vendor runtimes."""
import hashlib,json
from datetime import datetime
from pathlib import Path
from jsonschema import Draft202012Validator,FormatChecker
ROOT=Path(__file__).resolve().parents[1]
EXCLUDED={'node_modules','dist','build','__pycache__','.git','.cache'}
def sha(path):return 'sha256:'+hashlib.sha256(path.read_bytes()).hexdigest()
def product_fingerprint(root):
    paths=[]
    for name in ['apps','packages','tests','contracts','sql','scripts','deploy']:
        paths.extend(p for p in (root/name).rglob('*') if p.is_file() and not EXCLUDED.intersection(p.relative_to(root).parts))
    paths += [root/p for p in ['package.json','pnpm-lock.yaml','pnpm-workspace.yaml','tsconfig.base.json'] if (root/p).is_file()]
    digest=hashlib.sha256()
    for p in sorted(set(paths)):
        digest.update(str(p.relative_to(root)).encode()+b'\0'+hashlib.sha256(p.read_bytes()).digest())
    return 'sha256:'+digest.hexdigest()
def evaluate_run(root,path,gate,required_assertions,required_scenarios,fingerprint,schema,model=None):
    if not path.is_file():return {'status':'not-run','reason':'evidence-missing'}
    try:
        value=json.loads(path.read_text())
        Draft202012Validator({**schema,'$ref':'#/$defs/VerificationRun'},format_checker=FormatChecker()).validate(value)
        assert value['gateId']==gate,'wrong gate'
        assert datetime.fromisoformat(value['finishedAt'].replace('Z','+00:00'))>=datetime.fromisoformat(value['startedAt'].replace('Z','+00:00')),'inverted run timestamps'
        if value['status']!='passed':return {'status':value['status'],'reason':'recorded-run-status'}
        assert value['productFingerprint']==fingerprint,'stale product source'
        lock=root/'pnpm-lock.yaml';assert lock.is_file() and value['lockDigest']==sha(lock),'stale/missing lock'
        assert value['commands'] and all(c['argv'] and c['exitCode']==0 for c in value['commands']),'failed/missing commands'
        checks=value['checks'];assert len({c['id'] for c in checks})==len(checks),'duplicate checks'
        assert set(required_assertions)<={c['id'] for c in checks} and all(c['passed'] for c in checks),'missing/failed checks'
        selected=value['selectedScenarios'];executed=value['executedScenarios']
        assert len(set(selected))==len(selected) and len(set(executed))==len(executed),'duplicate cases'
        assert set(required_scenarios)<=set(selected)==set(executed) and not value['skippedScenarios'],'missing/skipped cases'
        assert value['artifacts'],'no raw evidence'
        for artifact in value['artifacts']:
            target=(root/artifact['path']).resolve()
            assert target.is_relative_to(root.resolve()) and target.is_file(),'artifact outside root/missing'
            assert sha(target)==artifact['digest'],'artifact hash mismatch'
        if model is not None:assert value.get('model')==model,'wrong qualification model'
        return {'status':'passed','reason':'current-evidence-records-validated'}
    except Exception as error:
        # Do not return arbitrary file/validation content that may contain private data.
        return {'status':'failed','reason':'invalid-or-stale-evidence','errorClass':type(error).__name__}
def report(root=ROOT):
    schema=json.loads((ROOT/'contracts/v1/brain.schema.json').read_text())
    plan=json.loads((ROOT/'contracts/v1/execution-plan.json').read_text());fingerprint=product_fingerprint(root)
    gates={g['id']:evaluate_run(root,root/g['evidence'],g['id'],g['requiredAssertions'],g['requiredScenarios'],fingerprint,schema) for g in plan['requiredLiveGates']}
    qualification=evaluate_run(root,root/'artifacts/runtime/QWEN/manifest.json','QWEN',plan['qualificationAssertions'],plan['qualificationAssertions'],fingerprint,schema,plan['codingAssistant']['model'])
    return {'scope':'evidence-record-integrity-only','productFingerprint':fingerprint,'gates':gates,
      'allRuntimeGatesPassed':all(x['status']=='passed' for x in gates.values()),'modelQualification':qualification,
      'modelQualified':qualification['status']=='passed','independentReleaseCertification':'separate-required-evidence',
      'note':'Missing evidence stays not-run. Artifact hashes bind records to bytes; trusted test runners and independent review establish that the recorded tests actually ran.'}
if __name__=='__main__':
    result=report();output=ROOT/'artifacts/implementation/runtime-readiness.json';output.parent.mkdir(parents=True,exist_ok=True)
    output.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
