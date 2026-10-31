#!/usr/bin/env python3
"""Validate this specification pack. Does not certify a running Brain product."""
from pathlib import Path
import concurrent.futures
import copy
import hashlib
import importlib.metadata
import json
import re
import sqlite3
import subprocess
import sys
import tempfile
import threading
from datetime import datetime, timezone
import yaml
from jsonschema import Draft202012Validator, FormatChecker
from generate_contract_types import render, OUTPUT
from pack_inputs import input_fingerprint, input_paths
from verify_readiness_additions import check as readiness_checks
from generate_implementation_indexes import render as render_indexes
from verify_runtime_evidence import report as runtime_report

ROOT=Path(__file__).resolve().parents[1]
checks=[]
def checked(name, fn):
    result=fn()
    checks.append({'name':name,'status':'passed','detail':result})
    print('PASS',name, result if isinstance(result,(str,int)) else '')
    return result
def load_json(path):
    def unique(pairs):
        result={}
        for k,v in pairs:
            if k in result:raise ValueError(f'Duplicate JSON key: {k}')
            result[k]=v
        return result
    return json.loads(path.read_text(),object_pairs_hook=unique)
class StrictLoader(yaml.SafeLoader):pass
def unique_mapping(loader,node,deep=False):
    result={}
    for key,value in node.value:
        k=loader.construct_object(key,deep=deep)
        if k in result:raise ValueError(f'Duplicate YAML key: {k}')
        result[k]=loader.construct_object(value,deep=deep)
    return result
StrictLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG,unique_mapping)
def load_yaml(path):
    text=path.read_text()
    if any(isinstance(tok,(yaml.tokens.AliasToken,yaml.tokens.AnchorToken,yaml.tokens.TagToken)) for tok in yaml.scan(text)):
        raise ValueError(f'Forbidden YAML alias/anchor/tag: {path}')
    return yaml.load(text,Loader=StrictLoader)

def main():
    schema=load_json(ROOT/'contracts/v1/brain.schema.json')
    definitions=schema['$defs']
    checked('schema-meta',lambda:(Draft202012Validator.check_schema(schema),len(definitions))[1])
    def refs(node):
        if isinstance(node,dict):
            if '$ref' in node:
                assert node['$ref'].startswith('#/$defs/'),node['$ref']
                assert node['$ref'].split('/')[-1] in definitions,node['$ref']
            for v in node.values():refs(v)
        elif isinstance(node,list):
            for v in node:refs(v)
    checked('schema-local-references',lambda:(refs(schema),'all references resolve offline')[1])
    validators={n:Draft202012Validator({**schema,'$ref':'#/$defs/'+n},format_checker=FormatChecker()) for n in definitions}
    manifest=load_json(ROOT/'examples/v1/manifest.json')
    def fixtures():
        for case in manifest['valid']+manifest['invalid']:
            p=ROOT/'examples/v1'/case['path']
            value=load_yaml(p) if p.suffix=='.yaml' else load_json(p)
            errors=list(validators[case['schema']].iter_errors(value))
            expected=case in manifest['valid']
            assert bool(errors)!=expected, f'{p}: expected valid={expected}, errors={[e.message for e in errors[:2]]}'
        return f"{len(manifest['valid'])} valid; {len(manifest['invalid'])} correctly rejected"
    checked('schema-fixtures',fixtures)
    checked('generated-types-fresh',lambda: 'current' if OUTPUT.read_text()==render() else (_ for _ in ()).throw(AssertionError('TypeScript stale')))
    def workflow_semantics():
        count=0
        for case in manifest['valid']:
            if case['schema']!='Workflow':continue
            v=load_yaml(ROOT/'examples/v1'/case['path']);jobs=v['spec']['jobs'];done=set();visiting=set()
            def walk(id):
                assert id in jobs,'unknown dependency '+id
                assert id not in visiting,'cycle '+id
                if id in done:return
                visiting.add(id)
                for dep in jobs[id]['needs']:walk(dep)
                visiting.remove(id);done.add(id)
            for id in jobs:walk(id)
            def ancestors(id):
                result=set()
                for dep in jobs[id]['needs']:result|={dep}|ancestors(dep)
                return result
            for id,job in jobs.items():
                assert (ROOT/'examples/v1'/job['outputSchemaRef']).is_file()
                for binding in list(job['input'].values())+[job[k] for k in ['proposalFrom','sessionFrom','messageFrom'] if k in job]:
                    if binding['source']=='job':assert binding['jobId'] in ancestors(id),(id,binding)
                if job['kind'] in ['merge'] or job.get('effectClass')=='privileged':
                    assert any(jobs[a]['kind']=='gate' for a in ancestors(id)),id
                count+=1
            for b in v['spec']['outputs'].values():
                if b['source']=='job':assert b['jobId'] in jobs
        return f'{count} example jobs; dependency/binding/gate/path checks (not a production compiler)'
    checked('example-workflow-semantics',workflow_semantics)
    def local_schemas():
        for p in manifest['configSchemas']:Draft202012Validator.check_schema(load_json(ROOT/'examples/v1'/p))
        return len(manifest['configSchemas'])
    checked('example-output-schema-meta',local_schemas)
    def yaml_guards():
        with tempfile.TemporaryDirectory(prefix='brain-yaml-') as temp:
            p=Path(temp)/'bad.yaml'
            for text in ['id: one\nid: two\n','a: &x hi\nb: *x\n','a: !custom hi\n','---\na: 1\n---\nb: 2\n']:
                p.write_text(text)
                try:load_yaml(p)
                except (ValueError,yaml.YAMLError):pass
                else:raise AssertionError('Unsafe YAML accepted')
        p=ROOT/'examples/v1/tool/TOOL.md'
        front=p.read_text().split('---',2)[1]
        value=yaml.load(front,Loader=StrictLoader)
        validators['Tool'].validate(value)
        assert value==load_yaml(ROOT/'examples/v1/config/tool.yaml')
        return 'four unsafe YAML cases rejected; canonical TOOL.md frontmatter matches'
    checked('restricted-yaml-and-tool-metadata',yaml_guards)
    def registry_check():
        registry=load_json(ROOT/'contracts/v1/registry.json')
        assert len({c['type'] for c in registry['commands']})==len(registry['commands'])
        for c in registry['commands']:
            assert c['schema'] in definitions
            command_type=definitions[c['schema']]['properties']['commandType']
            if 'const' in command_type: assert command_type['const']==c['type']
            else: assert c['type'] in command_type.get('enum',[])
        assert all(e['payloadContract'] in definitions for e in registry['events'])
        variants=[definitions[x['$ref'].split('/')[-1]] if '$ref' in x else x for x in definitions['EventEnvelope']['oneOf']]
        for e in registry['events']:
            assert any(e['type'] in x['properties']['eventType']['enum'] for x in variants)
        return f"{len(registry['commands'])} commands, {len(registry['events'])} typed lifecycle events"
    checked('registry-parity',registry_check)
    def openapi_check():
        api=load_json(ROOT/'contracts/v1/openapi.json');assert api['openapi']=='3.1.0'
        operations=[]
        for path,methods in api['paths'].items():
            for method,op in methods.items():
                operations.append(op['operationId']);assert 'responses' in op
                assert set(re.findall(r'\{([^}]+)\}',path))=={p['name'] for p in op.get('parameters',[]) if p['in']=='path'}
                for scheme in op.get('security',[]):assert set(scheme)<=set(api['components']['securitySchemes'])
                def walk(n):
                    if isinstance(n,dict):
                        if '$ref'in n:assert n['$ref'].startswith('./brain.schema.json#/$defs/') and n['$ref'].split('/')[-1] in definitions
                        for v in n.values():walk(v)
                    elif isinstance(n,list):
                        for v in n:walk(v)
                walk(op)
        assert len(operations)==len(set(operations))
        return f'{len(operations)} operations; structural/reference checks (not full OpenAPI certification)'
    checked('openapi-structure-and-refs',openapi_check)
    def states_check():
        machines=load_json(ROOT/'contracts/v1/state-machines.json')['machines']
        for name,states in machines.items():
            for state,targets in states.items():assert all(t in states for t in targets),(name,state)
            assert all(not states[s] for s in ['succeeded','failed','cancelled'] if s in states)
        assert set(definitions['JobState']['enum'])==set(machines['job'])
        assert set(definitions['AttemptState']['enum'])==set(machines['attempt'])
        return len(machines)
    checked('state-machine-parity',states_check)
    checked('reference-sql-and-invariants',sql_checks)
    def shell():
        for p in (ROOT/'examples/v1/tool').glob('*.sh'):subprocess.run(['bash','-n',str(p)],check=True,capture_output=True,text=True)
        return subprocess.run(['bash',str(ROOT/'examples/v1/tool/test.sh')],check=True,capture_output=True,text=True,timeout=20).stdout.strip()
    checked('bash-example-syntax-and-behavior',shell)
    def source_inputs():
        for x in load_json(ROOT/'contracts/v1/source-inputs.json')['inputs']:
            p=ROOT/x['path'];assert hashlib.sha256(p.read_bytes()).hexdigest()==x['sha256'] and p.stat().st_size==x['bytes']
        return 'original inputs unchanged'
    checked('source-input-fingerprints',source_inputs)
    def documentation_inventory():
        scenarios=(ROOT/'docs/implementation/11-acceptance-and-edge-cases.md').read_text()
        tasks=(ROOT/'docs/implementation/12-implementation-tasks.md').read_text()
        assert set(re.findall(r'^\| (E\d{3}) \|',scenarios,re.M))=={f'E{i:03}' for i in range(1,111)}
        assert set(re.findall(r'^\| (T\d{2}) /',tasks,re.M))=={f'T{i:02}' for i in range(1,59)}
        libraries=load_json(ROOT/'contracts/v1/library-register.json')['dependencies']
        assert all(x['exactProductVersion'] is None or (isinstance(x['exactProductVersion'],str) and x['exactProductVersion'].strip()) for x in libraries)
        return f'{len(libraries)} dependency decisions; 110 scenarios; 58 work cards'
    checked('documentation-inventory',documentation_inventory)
    def implementation_policy():
        policy=load_json(ROOT/'contracts/v1/implementation-policy.json')
        assert policy['mode']=='direct-target-implementation'
        assert policy['effectiveUntil']=='explicit-user-change'
        for key in ['backwardCompatibilityRequired','forwardCompatibilityRequired','historicalMigrationWorkRequired','rollingUpgradeCoexistenceRequired','compatibilityShimsAllowed','parallelLegacyImplementationAllowed','incrementalChangeConstraint','singleTaskRestriction','preserveDeployableIntermediateStates','nonDisposableDataResetAuthorized']:
            assert policy[key] is False,key
        for key in ['breakingChangesAllowed','coordinatedCrossModuleChangesAllowed','updateContractsCallersAndTestsTogether','freshCurrentSchemaInitializationRequired','sameVersionRecoveryRequired','dependencyIntegrationValidationRequired','productPortsAndReplaceableAdaptersRequired','authorizationAndEvidenceRequirementsUnchanged','preserveUnrelatedUserWork']:
            assert policy[key] is True,key
        assert policy['taskCardsRole']=='coverage-and-dependency-checklist'
        prompt=ROOT/policy['prompt']
        assert prompt.is_file() and prompt in input_paths()
        assert ROOT/'AGENTS.md' in input_paths()
        assert 'until they explicitly say otherwise' in prompt.read_text()
        guide=(ROOT/'IMPLEMENTATION.md').read_text()
        tasks=(ROOT/'docs/implementation/12-implementation-tasks.md').read_text()
        assert 'IMPLEMENTATION_PROMPT.md' in guide and 'IMPLEMENTATION_PROMPT.md' in tasks
        assert 'Implement Txx only.' not in tasks
        assert 'one bounded increment' not in tasks
        sql=(ROOT/'sql/reference/control.sql').read_text()
        assert 'CREATE TABLE schema_metadata' in sql and 'CREATE TABLE schema_migrations' not in sql
        return 'direct-target policy, persistent workspace instructions and packaged prompt agree; target safety/recovery retained'
    checked('implementation-policy-and-prompt',implementation_policy)
    def newui_integration_contract():
        value=load_json(ROOT/'contracts/v1/ui-foundation.json')
        assert value['library']=='NewUI'
        assert value['docsUrl']=='https://talelk.github.io/newui/'
        assert re.fullmatch(r'[0-9a-f]{40}',value['source']['commit'])
        assert set(value['templates'])=={'AppShell','PaneLayout','AuthLayout'}
        assert value['styling']['entrypoint']=='@talelk/newui-tailwind/style.css'
        assert value['styling']['defaultControlHeightPx']==28
        assert isinstance(value['productPackageLockCreated'],bool)
        packages={p['name']:p for p in value['packages']}
        assert all(p['name'].startswith('@talelk/newui-') and isinstance(p['installationVerified'],bool) for p in packages.values())
        for symbol,owner in value['componentOwners'].items():assert owner in packages,(symbol,owner)
        for source in value['source']['evidence']:
            assert '/'+value['source']['commit']+'/' in source['url']
            assert re.fullmatch(r'[0-9a-f]{64}',source['sha256'])
        assert '@talelk/newui-data/resource' in value['forbiddenEntrypoints']
        docs=(ROOT/'docs/implementation/09-ux-and-ui.md').read_text()
        assert 'Build a local Solid kit' not in docs and 'Proposed light colors:' not in docs
        assert '@talelk/newui-templates' in docs and '@talelk/newui-tailwind/style.css' in docs
        tasks=(ROOT/'docs/implementation/12-implementation-tasks.md').read_text()
        assert 'Integrate pinned NewUI' in tasks
        library=load_json(ROOT/'contracts/v1/library-register.json')
        assert any(p['component']=='NewUI' for p in library['dependencies'])
        return f"{len(packages)} source package observations and UI documentation consistent; installed/browser compatibility remains pending"
    checked('newui-integration-contract',newui_integration_contract)
    def configuration_and_architecture():
        architecture=load_json(ROOT/'contracts/v1/architecture.json')
        validators['ArchitectureModel'].validate(architecture)
        bindings=architecture['configBindings']
        assert all((ROOT/p).is_file() for p in bindings.values())
        foundation_path=ROOT/bindings['foundationManifest']
        foundation=load_json(foundation_path)
        foundation_digest='sha256:'+hashlib.sha256(foundation_path.read_bytes()).hexdigest()
        brain=load_yaml(ROOT/bindings['brainConfig'])
        build=load_json(ROOT/bindings['webBuildConfig'])
        validators['BrainConfig'].validate(brain)
        validators['WebBuildConfig'].validate(build)
        ui=brain['spec']['ui']
        def semantic_errors(value):
            errors=[]
            if value['foundationManifestDigest']!=foundation_digest:errors.append('foundation-manifest')
            if value['defaultLocale'] not in value['supportedLocales']:errors.append('default-locale')
            return errors
        assert not semantic_errors(ui)
        context=load_json(ROOT/'examples/v1/transport/WorkspaceContext.json')
        validators['WorkspaceContext'].validate(context)
        assert context['ui']==ui
        assert ui['foundationManifestDigest']==build['foundationManifestDigest']
        assert build['sourceCommit']==foundation['source']['commit']
        assert build['foundationBinding']=='image-build-only'
        required={p['name']:p['observedSourceVersion'] for p in foundation['packages'] if p['disposition']=='required'}
        assert {p['name']:p['observedSourceVersion'] for p in build['packageCandidates']}==required
        assert ui['enabledChannels']==['web'],'PWA/TV need their own implementation gates before changing reference defaults'
        semantic_cases=manifest.get('semanticInvalid',[])
        assert len(semantic_cases)>=2
        for case in semantic_cases:
            value=load_json(ROOT/'examples/v1'/case['path'])
            validators[case['schema']].validate(value)
            assert case['rule'] in semantic_errors(value),case
        assert set(architecture['logicalPlanes'])=={'control','data','runtime'}
        components=architecture['components']
        assert {c['plane'] for c in components.values()}==set(architecture['logicalPlanes'])
        assert 'newui' not in components,'NewUI is a build dependency, not another service'
        endpoints=set(components)|{'experience','reviewed-build-input'}
        for boundary in architecture['boundaries']:
            assert boundary['from'] in endpoints and boundary['to'] in endpoints,boundary
            assert boundary['authorizationOwner']=='governor'
        expected_boundaries={'interface-governor','git-compiler','governor-mastra','governor-runner','runner-harness','governor-memory','newui-consumer'}
        assert {b['id'] for b in architecture['boundaries']}==expected_boundaries
        assert architecture['uiDependencyRules']['forbiddenEntrypoints']==foundation['forbiddenEntrypoints']
        compose=load_yaml(ROOT/bindings['composeReference'])
        environment=compose['services']['governor']['environment']
        assert environment['BRAIN_WEB_DIST_DIR']==build['artifactLayout']['webDistDir']
        assert environment['BRAIN_UI_FOUNDATION_MANIFEST_FILE']==build['artifactLayout']['foundationManifestFile']
        css=(ROOT/'examples/v1/web/index.css').read_text()
        assert css.count('@import "'+build['styling']['entrypoint']+'"')==1
        sources=set(re.findall(r'@source\s+"([^"]+)"',css))
        assert sources=={'../index.html',build['styling']['applicationSource']}
        vite=(ROOT/'examples/v1/web/vite.config.ts').read_text()
        proxies=set(re.findall(r"^\s*'(/[^']+)':\s*\{",vite,re.M))
        assert proxies==set(build['routing']['developmentProxyPrefixes'])=={'/v1','/api/auth'}
        assert 'frappe' not in vite.lower() and '127.0.0.1' in vite
        return f"{len(expected_boundaries)} boundaries, three planes, matching config/build/image references and {len(semantic_cases)} semantic rejections; consumer build not run"
    checked('configuration-and-architecture-parity',configuration_and_architecture)
    checked('implementation-readiness-contracts-and-fixtures',readiness_checks)
    def generated_indexes():
        for name,content in render_indexes().items():assert (ROOT/name).read_text()==content,'Stale generated index: '+name
        return 'layout, task table/packets, scenario catalog and routes match canonical sources'
    checked('generated-implementation-indexes-fresh',generated_indexes)
    def deployment_references():
        files=list((ROOT/'deploy/reference').glob('*.yaml'))
        for p in files:
            value=load_yaml(p)
            for service in value['services'].values():
                assert service['read_only'] and service['cap_drop']==['ALL']
                assert 'no-new-privileges:true' in service['security_opt']
                assert '${' in service['image'] and 'latest' not in service['image']
                assert not service.get('privileged',False)
                assert all('docker.sock' not in v for v in service.get('volumes',[]))
        return f'{len(files)} topology references; YAML/security structure only, Docker render not run'
    checked('deployment-reference-structure',deployment_references)
    runtime=runtime_report()
    (ROOT/'artifacts/implementation/runtime-readiness.json').write_text(json.dumps(runtime,indent=2)+'\n')
    checked('documentation-local-links',link_checks)
    def typecheck():
        result=subprocess.run(['tsc','-p',str(ROOT/'contracts/tsconfig.json')],capture_output=True,text=True,timeout=30)
        assert result.returncode==0,result.stdout+result.stderr
        return subprocess.run(['tsc','--version'],capture_output=True,text=True,check=True).stdout.strip()
    checked('typescript-strict-typecheck',typecheck)
    report={'status':'passed','scope':'documentation-contract-pack-only','inputFingerprint':input_fingerprint(),'checkedAt':datetime.now(timezone.utc).isoformat(),'checks':checks,'versions':{'python':sys.version.split()[0],'sqliteForReferenceChecks':sqlite3.sqlite_version,'PyYAML':importlib.metadata.version('PyYAML'),'jsonschema':importlib.metadata.version('jsonschema')},'runtimeIntegrationGates':{id:v['status'] for id,v in runtime['gates'].items()},'runtimeScenarios':'Use runtime evidence for execution status; pack checks validate inventory/fixtures only','limitations':['Documentation checks do not execute vendor services or performance workloads','Candidate metadata is distinct from the installed/frozen cohort checked by G01','Current reference SQL is separate from vendor initial schema generation and actual application handlers','OpenAPI checked structurally, not with external full validator','NewUI browser/API acceptance needs actual installed artifacts; approval controller has independent reference checks','Runtime and model readiness derive from current evidence, not hard-coded planning flags']}
    p=ROOT/'artifacts/implementation/verification.json';p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(report,indent=2)+'\n')
    print('All pack checks passed. Runtime status is recorded separately in runtime-readiness.json.')

def link_checks():
    count=0
    paths=[ROOT/'IMPLEMENTATION.md',ROOT/'IMPLEMENTATION_PROMPT.md',ROOT/'AGENTS.md',*(ROOT/'docs/implementation').glob('*.md')]
    for p in paths:
        for target in re.findall(r'\[[^\]]*\]\(([^)]+)\)',p.read_text()):
            if '://' in target or target.startswith('#'):continue
            path=target.split('#')[0]
            if path:assert (p.parent/path).resolve().exists(),f'{p}: broken link {target}'
            count+=1
    return count

def sql_checks():
    with tempfile.TemporaryDirectory(prefix='brain-pack-') as temp:
        path=Path(temp)/'control.db';db=sqlite3.connect(path)
        db.executescript((ROOT/'sql/reference/control.sql').read_text())
        workspace=sqlite3.connect(Path(temp)/'workspace.db');workspace.executescript((ROOT/'sql/reference/workspace.sql').read_text())
        db.execute("INSERT INTO organizations VALUES ('o1','auth1',1)")
        db.execute("INSERT INTO organizations VALUES ('o2','auth2',1)")
        db.execute("INSERT INTO workspaces VALUES ('w1','o1','one','active',1)")
        db.execute("INSERT INTO workspaces VALUES ('w2','o2','two','active',1)")
        db.execute("INSERT INTO config_releases VALUES ('d1','o1','sha1:fixture','compiler','{}',0)")
        db.execute("INSERT INTO runners(id,organization_id,group_id,identity_key_digest,admin_state,session_epoch,health,config_digest,cpu_capacity,memory_capacity,disk_capacity,slot_capacity) VALUES ('r1','o1','agents','key','enabled',1,'healthy','d1',2000,4096,4096,1)")
        def job(id,org='o1',ws='w1'):
            db.execute("INSERT INTO jobs(id,organization_id,workspace_id,execution_key,workflow_run_id,step_id,state,config_digest,placement_json,execution_digest,effect_class,created_at_ms,ready_at_ms,deadline_ms) VALUES (?,?,?,?, 'wf','step','queued','d1','{}','artifact','read',0,0,100000)",(id,org,ws,id))
        job('j1');db.commit()
        assertions=0
        def denied(fn):
            nonlocal assertions
            db.execute('SAVEPOINT denied')
            try:fn()
            except sqlite3.IntegrityError:assertions+=1
            else:raise AssertionError('Expected SQL invariant rejection')
            finally:db.execute('ROLLBACK TO denied');db.execute('RELEASE denied')
        denied(lambda:job('cross','o1','w2'))
        denied(lambda:db.execute("UPDATE runners SET slots_reserved=2 WHERE id='r1'"))
        db.commit()
        barrier=threading.Barrier(2)
        def race(n):
            con=sqlite3.connect(path,timeout=3);con.execute('PRAGMA foreign_keys=ON');barrier.wait()
            try:
                con.execute('BEGIN IMMEDIATE')
                result=con.execute("UPDATE jobs SET state='offered',attempt_counter=1,job_fence=1 WHERE id='j1' AND state='queued'")
                if result.rowcount!=1:con.rollback();return False
                con.execute("INSERT INTO job_attempts VALUES (?,?, 'r1',1,1,?,1,'offered',10000,60000,0,NULL,0)",('a'+str(n),'j1','l'+str(n)))
                con.commit();return True
            finally:con.close()
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:outcomes=list(pool.map(race,[1,2]))
        assert outcomes.count(True)==1;assertions+=1
        attempt=db.execute('SELECT id FROM job_attempts').fetchone()[0]
        denied(lambda:db.execute("INSERT INTO job_attempts VALUES ('second','j1','r1',1,2,'secondlease',2,'offered',10000,60000,0,NULL,0)"))
        db.execute("INSERT INTO approval_requests VALUES ('ap','o1','w1','user','subject','{}','approved',2,10000,0)")
        db.execute('INSERT INTO approval_consumptions VALUES (?,?,?,?,0)',('ap','inv1',attempt,'subject'))
        denied(lambda:db.execute('INSERT INTO approval_consumptions VALUES (?,?,?,?,0)',('ap','inv2',attempt,'subject')))
        db.execute("INSERT INTO resource_fences VALUES ('target/one','o1',1)")
        db.execute('INSERT INTO resource_leases VALUES (?,?,?,?,?,?)',('target/one',attempt,'inv1',1,10000,1))
        db.execute("DELETE FROM resource_leases WHERE resource_key='target/one'")
        db.execute("UPDATE resource_fences SET counter=counter+1 WHERE resource_key='target/one'")
        assert db.execute("SELECT counter FROM resource_fences WHERE resource_key='target/one'").fetchone()[0]==2;assertions+=1
        db.execute("INSERT INTO inbox VALUES ('source','event','digest',0)")
        denied(lambda:db.execute("INSERT INTO inbox VALUES ('source','event','digest',0)"))
        db.commit()
        try:workspace.execute("INSERT INTO cards VALUES ('card','title','done','[]',1,NULL,0)")
        except sqlite3.IntegrityError:assertions+=1
        else:raise AssertionError('Done without evidence reference accepted')
        assert db.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
        assert not db.execute('PRAGMA foreign_key_check').fetchall()
        workspace.close();db.close()
        return f'{assertions} selected reference invariants, including two-connection claim race; not production handler tests'

if __name__=='__main__':
    try:main()
    except Exception as error:
        p=ROOT/'artifacts/implementation/verification.json';p.parent.mkdir(parents=True,exist_ok=True)
        p.write_text(json.dumps({'status':'failed','scope':'documentation-contract-pack-only','checks':checks,'error':str(error)},indent=2)+'\n')
        raise
