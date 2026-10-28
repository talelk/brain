#!/usr/bin/env python3
"""Build standalone specification and ZIP from freshly verified pack inputs."""
from pathlib import Path
import hashlib
import json
import os
import re
import zipfile
from pack_inputs import ROOT,input_paths,input_fingerprint

report_path=ROOT/'artifacts/implementation/verification.json'
report=json.loads(report_path.read_text())
assert report['status']=='passed','Run verify_implementation_pack.py first'
assert report.get('inputFingerprint')==input_fingerprint(),'Verification is stale; rerun verify_implementation_pack.py'
combined=ROOT/'Keyrus_Brain_v4_2_Implementation_Spec.md'
parts=['# Keyrus Brain v4.2 — Consolidated implementation specification\n\nPrepared 27 October 2026. This archive contains the documentation and contract pack. Runtime code exists in the repository under development; implementation completeness and production readiness are not certified. Read doc 23 for the current audit and remaining work.\n\nImplementation policy: build the target directly; no compatibility, historical migration or incremental-change constraints until the user explicitly changes that instruction. See IMPLEMENTATION_PROMPT.md and AGENTS.md.\n\nUse IMPLEMENTATION.md for navigable source documents and contract links.\n']
for p in sorted((ROOT/'docs/implementation').glob('*.md')):
    def rebase(match):
        target=match.group(2)
        if '://' in target or target.startswith('#'):return match.group(0)
        path,sep,fragment=target.partition('#')
        return match.group(1)+'('+os.path.relpath((p.parent/path).resolve(),ROOT)+(sep+fragment if sep else '')+')'
    content=re.sub(r'(\[[^\]]*\])\(([^)]+)\)',rebase,p.read_text())
    parts.append('\n\n---\n\n<!-- Source: '+p.name+' -->\n\n'+content)
combined.write_text(''.join(parts))
paths=input_paths()+[report_path,combined,ROOT/'artifacts/implementation/runtime-readiness.json']
source_manifest=json.loads((ROOT/'contracts/v1/source-inputs.json').read_text())
paths += [ROOT/x['path'] for x in source_manifest['inputs'] if (ROOT/x['path']).is_file()]
paths=sorted(set(paths))
manifest={'format':'brain.implementation-pack/v1','verificationFingerprint':report['inputFingerprint'],'files':[{'path':str(p.relative_to(ROOT)),'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in paths]}
manifest_path=ROOT/'artifacts/implementation/package-manifest.json'
manifest_path.write_text(json.dumps(manifest,indent=2)+'\n')
zip_path=ROOT/'Keyrus_Brain_v4_2_Implementation_Pack.zip'
with zipfile.ZipFile(zip_path,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
    for p in paths+[manifest_path]:
        info=zipfile.ZipInfo(str(p.relative_to(ROOT)),date_time=(2026,10,27,0,0,0))
        info.compress_type=zipfile.ZIP_DEFLATED
        info.external_attr=((0o100755 if p.suffix=='.sh' else 0o100644)<<16)
        z.writestr(info,p.read_bytes())
with zipfile.ZipFile(zip_path) as z:
    assert z.testzip() is None
    for item in manifest['files']:assert hashlib.sha256(z.read(item['path'])).hexdigest()==item['sha256']
summary={'archive':zip_path.name,'bytes':zip_path.stat().st_size,'sha256':hashlib.sha256(zip_path.read_bytes()).hexdigest(),'entries':len(paths)+1,'specification':combined.name,'specBytes':combined.stat().st_size,'specWords':len(combined.read_text().split()),'sourceInputsIncluded':len(source_manifest['inputs']),'verificationScope':report['scope']}
(ROOT/'artifacts/implementation/package-summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps(summary,indent=2))
