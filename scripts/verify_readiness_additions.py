#!/usr/bin/env python3
"""Check added planning contracts and literal fixtures; never certify product runtime."""
import hashlib,json,re,sqlite3,stat,subprocess,sys,tempfile,urllib.parse
from pathlib import Path,PurePosixPath
import yaml
from jsonschema import Draft202012Validator,FormatChecker
from verify_runtime_evidence import evaluate_run,sha
ROOT=Path(__file__).resolve().parents[1]
def load(path):return json.loads((ROOT/path).read_text())
def run(*args,**kwargs):return subprocess.run(args,capture_output=True,text=True,timeout=30,**kwargs)
def check():
    schema=load('contracts/v1/brain.schema.json');defs=schema['$defs'];registry=load('contracts/v1/registry.json')
    matrix=load('contracts/v1/authorization-matrix.json')
    assert matrix['commandPolicySource']=='contracts/v1/registry.json' and 'commands' not in matrix
    assert set(matrix['queryRules'])==set(registry['queries'])
    for c in registry['commands']:
        assert any(c['scope'] in role['scopes'] for role in matrix['roles'].values())
    assert matrix['default']=='deny' and not matrix['roleInheritance']
    events=defs['EngineEvent']['oneOf'];assert len(events)==9
    assert len({e['properties']['kind']['const'] for e in events})==9
    assert all(e['properties']['payload'].get('additionalProperties') is False for e in events)
    def resolved_variant(v):return defs[v['$ref'].split('/')[-1]] if '$ref' in v else v
    def query_types(variants):
        result=set()
        for variant in variants:
            shape=resolved_variant(variant)['properties']['queryType']
            result.add(shape['const']) if 'const' in shape else result.update(shape.get('enum',[]))
        return result
    assert query_types(defs['QueryRequest']['oneOf'])==set(registry['queries'])
    assert query_types(defs['QueryResponse']['oneOf'])==set(registry['queries'])
    screens=load('contracts/v1/ui-screen-contracts.json')
    for screen in screens['screens']:
        assert set(screen['queries'])<=set(registry['queries'])
        assert set(screen['actions'])<={c['type'] for c in registry['commands']}|set(screens['specialActions'])
    packets=load('contracts/v1/task-packets.json')['tasks']
    assert set(packets)=={f'T{i:02}' for i in range(1,59)}
    for packet in packets.values():
        assert all((ROOT/p).is_file() for p in packet['read'])
        assert packet['behavior'] and packet['verify'] and packet['targetFiles']
        assert packet['contractDefinitions'] and set(packet['contractDefinitions'])<=set(defs)
    catalog=load('contracts/v1/scenario-catalog.json')['scenarios']
    assert {x['id'] for x in catalog}=={f'E{i:03}' for i in range(1,111)}
    for x in catalog:assert x['owners'] and set(x['owners'])<=set(packets) and 'runtimeStatus' not in x
    oracle=load('contracts/v1/acceptance-oracles.json')
    assert len(oracle['traces'])==15 and len({x['id'] for x in oracle['traces']})==15
    for x in oracle['traces']:
        assert x['initial'] and x['stimuli'] and x['expected']
        assert set(x['scenarios'])<={s['id'] for s in catalog}
    for x in oracle['canonicalVectors']:
        if 'canonical' in x:
            assert x['sha256']=='sha256:'+hashlib.sha256(x['canonical'].encode()).hexdigest()
            json.loads(x['canonical'])
        else:assert x['reject']
    crypto=run('node',str(ROOT/'scripts/check_crypto_vectors.mjs'))
    assert crypto.returncode==0,crypto.stderr
    golden_checks(schema)
    sql_authorization_checks()
    resolver_checks()
    context=run(sys.executable,str(ROOT/'scripts/implementation_context.py'),'T13','T14','T35')
    assert context.returncode==0 and len(json.loads(context.stdout)['tasks'])==3
    config=load('opencode.json');plan=load('contracts/v1/execution-plan.json')
    assert config['model']==plan['codingAssistant']['model']
    assert config['compaction']['auto'] and 'steps' not in config['agents']['brain-implementer']
    assert config['instructions'][0]=='/home/talel/.codex/RTK.md'
    assert all((Path(p) if p.startswith('/') else ROOT/p).is_file() for p in config['instructions'])
    ready=load('contracts/v1/readiness.json')
    assert ready['runtimeEvidenceIsSeparateFromPlan'] and 'allRuntimeGatesPassed' not in ready
    assert all((ROOT/x['artifact']).is_file() for x in ready['gaps'])
    modular_monolith_checks(schema,matrix,registry)
    return f"{len(packets)} generated task packets; 110 scenarios; 15 traces; crypto/golden fixtures; {len(screens['screens'])} screens in six areas; monolith/auth/recovery/evidence checks"
def golden_checks(schema):
    base=ROOT/'examples/v1/golden-release';manifest=load('examples/v1/golden-release/manifest.json')
    fresh=run(sys.executable,str(ROOT/'scripts/build_golden_release.py'),'--check');assert fresh.returncode==0,fresh.stderr
    raw_index=json.dumps(manifest['files'],sort_keys=True,separators=(',',':'),ensure_ascii=True).encode()
    assert manifest['manifestContentDigest']=='sha256:'+hashlib.sha256(raw_index).hexdigest()
    for f in manifest['files']:
        assert not PurePosixPath(f['path']).is_absolute() and '..' not in PurePosixPath(f['path']).parts
        assert 'sha256:'+hashlib.sha256((base/f['path']).read_bytes()).hexdigest()==f['digest']
    definitions={(e['id'],e['digest']):e for e in manifest['entries']}
    def refs(v):
        if isinstance(v,dict):
            if set(v)=={'id','digest'}:assert (v['id'],v['digest']) in definitions,v
            for k,x in v.items():
                if k.endswith('SchemaRef'):assert (base/x).is_file(),x
                refs(x)
        elif isinstance(v,list):
            for x in v:refs(x)
    for e in manifest['entries']:
        v=yaml.safe_load((base/e['path']).read_text())
        Draft202012Validator({**schema,'$ref':'#/$defs/'+e['kind']},format_checker=FormatChecker()).validate(v)
        refs(v)
        if e['kind']=='Tool':
            tool=base/'tools'/e['id'];index=json.loads((tool/'package-index.json').read_text())
            raw=json.dumps(index,sort_keys=True,separators=(',',':'),ensure_ascii=True).encode()
            assert e['digest']=='sha256:'+hashlib.sha256(raw).hexdigest()
            for f in index:
                assert not PurePosixPath(f['path']).is_absolute() and '..' not in PurePosixPath(f['path']).parts
                assert f['digest']=='sha256:'+hashlib.sha256((tool/f['path']).read_bytes()).hexdigest()
                assert f['mode']==stat.S_IMODE((tool/f['path']).stat().st_mode)
            for script in ['run.sh','test.sh']:
                syntax=run('bash','-n',str(tool/script));assert syntax.returncode==0,syntax.stderr
            result=run('bash',str(tool/'test.sh'));assert result.returncode==0,result.stderr
    output=run('bash',str(base/'tools/fixture.echo/run.sh'),input=json.dumps(manifest['input']))
    assert output.returncode==0 and json.loads(output.stdout)=={'message':'Brain fixture'}
    result=run('bash',str(base/'tools/fixture.verify/run.sh'),input=json.dumps({'report':json.loads(output.stdout)}))
    assert result.returncode==0 and json.loads(result.stdout)==manifest['expectedOutput']
def sql_authorization_checks():
    with tempfile.TemporaryDirectory(prefix='brain-authority-') as temp:
        db=sqlite3.connect(Path(temp)/'control.db');db.executescript((ROOT/'sql/reference/control.sql').read_text())
        for n in [1,2]:
            db.execute('INSERT INTO organizations VALUES (?,?,1)',('o'+str(n),'a'+str(n)))
            db.execute("INSERT INTO workspaces VALUES (?,?,'workspace','active',1)",('w'+str(n),'o'+str(n)))
            db.execute("INSERT INTO principals VALUES (?,?,'human',?,NULL)",('p'+str(n),'o'+str(n),'u'+str(n)))
        def denied(sql,args):
            try:db.execute(sql,args)
            except sqlite3.IntegrityError:return
            raise AssertionError('Invalid authorization row accepted')
        denied('INSERT INTO workspace_memberships VALUES (?,?,?,?,1,?,0,NULL)',('w1','o1','p2','operator','admin'))
        denied('INSERT INTO workspace_memberships VALUES (?,?,?,?,1,?,0,NULL)',('w2','o1','p1','operator','admin'))
        db.execute('INSERT INTO workspace_memberships VALUES (?,?,?,?,1,?,0,NULL)',('w1','o1','p1','operator','admin'))
        denied('INSERT INTO workspace_memberships VALUES (?,?,?,?,1,?,0,NULL)',('w1','o1','p1','approver-bypass','admin'))
        denied("INSERT INTO delegated_grants VALUES (?,?,?, ?,NULL,'root','run','[]','policy',3,1000,NULL)",('g','o1','w1','p1'))
        denied("INSERT INTO artifact_associations VALUES (?,?,?,'digest','job','j','internal',0)",('art','o1','w2'))
        assert not db.execute('PRAGMA foreign_key_check').fetchall()
        db.close()
def resolver_checks():
    with tempfile.TemporaryDirectory(prefix='brain-registry-fixture-') as temp:
        base=Path(temp);packages=[v for v in load('contracts/v1/dependency-baseline.json')['packages'] if v['disposition']=='required']
        (base/'node-index.json').write_text(json.dumps([{'version':'v24.1.0','lts':'fixture'}]))
        (base/'node-shasums.txt').write_text(('0'*64)+'  node-v24.1.0-linux-x64.tar.xz\n')
        for p in packages:
            version=p['version'] or '1.0.0';name=p['name']
            raw={'name':name,'version':version,'dist':{'tarball':'https://registry.npmjs.org/fixture.tgz','integrity':'sha512-'+('A'*86)+'=='}}
            (base/(urllib.parse.quote(name,safe='')+'.json')).write_text(json.dumps(raw))
        cmd=[sys.executable,str(ROOT/'scripts/resolve_dependency_baseline.py'),'--metadata-dir',str(base),'--output',str(base/'result.json')]
        good=run(*cmd);assert good.returncode==0,good.stderr
        result=json.loads((base/'result.json').read_text());assert result['status']=='resolved-not-installed' and not result['productIntegrationPassed']
        first=base/(urllib.parse.quote(packages[0]['name'],safe='')+'.json');bad=json.loads(first.read_text());bad['version']='1.0.0-beta.1';first.write_text(json.dumps(bad))
        bad_run=run(*cmd);assert bad_run.returncode!=0
        result=json.loads((base/'result.json').read_text());assert result['status']=='failed' and result['failures']

def modular_monolith_checks(schema,matrix,registry):
    layout=load('contracts/v1/module-layout.json')
    assert layout['architectureStyle']=='modular-monolith' and layout['controlPlaneProcesses']==1 and layout['fullFunctionalScopePreserved']
    assert layout['sharedPackages']==['packages/contracts']
    assert {r['path'] for r in layout['roots']}=={'apps/governor','apps/runner','apps/launcher','apps/web','apps/cli','packages/contracts'}
    assert all(v['path'].startswith('apps/governor/src/modules/') for v in layout['governorModules'].values())
    assert layout['sandboxProfiles']==['agent','privileged-tool','evaluator']
    screens=load('contracts/v1/ui-screen-contracts.json')
    assert [n['label'] for n in screens['primaryNavigation']]==['Today','Work','Activity','Approvals','Knowledge','Administration']
    assert all(s['navigationGroup'] in {'today','work','runs','approvals','knowledge','settings','administration','tv'} for s in screens['screens'])
    assert {n['entryRoute'] for n in screens['primaryNavigation']}<={s['route'] for s in screens['screens']}
    assert 'workspace:read' in matrix['roles']['viewer']['scopes']
    assert 'membership:grant' not in matrix['roles']['security-admin']['scopes']
    commands={c['type']:c for c in registry['commands']}
    for case in load('examples/v1/execution/authorization-cases.json')['cases']:
        facts=case['facts'];kind=case['operationKind'];operation=case['operation']
        rule=commands.get(operation) if kind=='command' else matrix['queryRules'].get(operation) if kind=='query' else matrix['specialEndpoints'].get(operation)
        allowed=bool(rule) and facts['organizationCurrent'] and facts['sameOrganization']
        if rule:
            allowed=allowed and (not rule.get('actors') or facts['actorKind'] in rule['actors'])
            caps={scope for role in case['roles'] for scope in matrix['roles'][role]['scopes'] if matrix['roles'][role]['grantScope']=='organization' or (facts['workspaceCurrent'] and facts['sameWorkspace'])}
            if facts['actorKind']!='human':caps &= set(facts.get('delegatedScopes',[])) & set(facts.get('parentScopes',[]))
            allowed=allowed and rule['scope'] in caps
            if kind=='query' and rule['scopeMode']=='workspace':allowed=allowed and facts['workspaceCurrent'] and facts['sameWorkspace']
            if kind=='endpoint':allowed=allowed and facts['workspaceCurrent'] and facts['sameWorkspace']
            if operation=='approval.decision':allowed=allowed and facts['stepUpFresh'] and not facts['isAuthor']
            if rule.get('originalActorOnly'):allowed=allowed and facts.get('originalActor',False)
        assert bool(allowed)==case['allowed'],case['id']
    controller=run('node',str(ROOT/'scripts/check_approval_controller.mjs'))
    assert controller.returncode==0,controller.stderr
    compile_controller=run('tsc','--noEmit','--strict','--target','ES2022','--module','ESNext','--moduleResolution','bundler',str(ROOT/'examples/v1/web/approval-controller.ts'))
    assert compile_controller.returncode==0,compile_controller.stdout+compile_controller.stderr
    # Positive and negative records prove the checker accepts actual passed status,
    # while rejecting stale bytes/lock/source and missing evidence. Fixture only.
    with tempfile.TemporaryDirectory(prefix='brain-evidence-fixture-') as temp:
        root=Path(temp);lock=root/'pnpm-lock.yaml';lock.write_text('fixture lock\n');raw=root/'raw.log';raw.write_text('fixture execution output\n')
        path=root/'manifest.json';fingerprint='sha256:'+'1'*64
        good={'contractVersion':'brain.verification-run/v1','gateId':'G01','status':'passed','productFingerprint':fingerprint,'lockDigest':sha(lock),
          'startedAt':'2026-10-27T12:00:00Z','finishedAt':'2026-10-27T12:00:01Z',
          'commands':[{'argv':['fixture-only'],'exitCode':0,'durationMs':1}],'checks':[{'id':'fixture-assertion','passed':True}],
          'artifacts':[{'path':'raw.log','digest':sha(raw)}],'selectedScenarios':['fixture-case'],'executedScenarios':['fixture-case'],'skippedScenarios':[]}
        path.write_text(json.dumps(good))
        def evaluate():return evaluate_run(root,path,'G01',['fixture-assertion'],['fixture-case'],fingerprint,schema)['status']
        assert evaluate()=='passed'
        for key,value in [('productFingerprint','sha256:'+'2'*64),('checks',[]),('executedScenarios',[]),('skippedScenarios',['fixture-case'])]:
            changed={**good,key:value};path.write_text(json.dumps(changed));assert evaluate()=='failed'
        path.write_text(json.dumps(good));raw.write_text('tampered');assert evaluate()=='failed'
        path.unlink();assert evaluate()=='not-run'
if __name__=='__main__':print(check())
