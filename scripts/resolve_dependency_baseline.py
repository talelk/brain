#!/usr/bin/env python3
"""Resolve exact artifact candidates without installation or executing package code."""
import argparse,base64,concurrent.futures,hashlib,json,re,urllib.parse,urllib.request
from datetime import datetime,timezone
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def resolve_node(metadata_dir):
    def fetch(url,fixture):
        if metadata_dir:return (metadata_dir/fixture).read_bytes()
        with urllib.request.urlopen(url,timeout=15) as response:
            assert response.geturl().startswith('https://nodejs.org/')
            raw=response.read(8*1024*1024+1)
            assert len(raw)<=8*1024*1024
            return raw
    index=json.loads(fetch('https://nodejs.org/dist/index.json','node-index.json'))
    versions=[v for v in index if re.fullmatch(r'v24\.\d+\.\d+',v['version']) and v.get('lts')]
    assert versions,'Supported Node 24 LTS release missing'
    chosen=max(versions,key=lambda v:tuple(int(x) for x in v['version'][1:].split('.')))
    version=chosen['version'];name=f'node-{version}-linux-x64.tar.xz'
    shasums=fetch(f'https://nodejs.org/dist/{version}/SHASUMS256.txt','node-shasums.txt').decode()
    matches=[line.split()[0] for line in shasums.splitlines() if len(line.split())==2 and line.split()[1]==name]
    assert len(matches)==1 and re.fullmatch(r'[0-9a-f]{64}',matches[0])
    return {'version':version,'url':f'https://nodejs.org/dist/{version}/{name}','sha256':matches[0],'installationVerified':False,'metadataVerification':'HTTPS official manifest; verify release signatures and artifact bytes before use'}
def resolve(item,metadata_dir):
    name=item['name'];version=item.get('version') or 'latest'
    url='https://registry.npmjs.org/'+urllib.parse.quote(name,safe='')+'/'+version
    if metadata_dir:
        raw=(metadata_dir/(urllib.parse.quote(name,safe='')+'.json')).read_bytes()
    else:
        req=urllib.request.Request(url,headers={'Accept':'application/json','User-Agent':'brain-dependency-resolver/1'})
        with urllib.request.urlopen(req,timeout=15) as response:
            assert response.geturl().startswith('https://registry.npmjs.org/'),'Unexpected registry redirect'
            raw=response.read(8*1024*1024+1)
    assert len(raw)<=8*1024*1024,'Registry response too large'
    value=json.loads(raw)
    assert value['name']==name
    assert re.fullmatch(r'\d+\.\d+\.\d+',value['version']),'Stable exact release required'
    assert version=='latest' or version==value['version']
    dist=value['dist'];assert dist['tarball'].startswith('https://registry.npmjs.org/')
    assert dist['integrity'].startswith('sha512-')
    assert len(base64.b64decode(dist['integrity'][7:],validate=True))==64
    return {'name':name,'version':value['version'],'tarball':dist['tarball'],'integrity':dist['integrity'],
      'engines':value.get('engines',{}),'peerDependencies':value.get('peerDependencies',{}),'license':value.get('license','REVIEW_REQUIRED'),
      'repository':value.get('repository'),'metadataSha256':hashlib.sha256(raw).hexdigest(),'source':url,'installationVerified':False}
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--metadata-dir',type=Path);parser.add_argument('--output',type=Path,default=ROOT/'artifacts/implementation/dependency-resolution.json');args=parser.parse_args()
    baseline=json.loads((ROOT/'contracts/v1/dependency-baseline.json').read_text())
    items=[v for v in baseline['packages'] if v['disposition']=='required']
    records=[];failures=[];node=None
    try:node=resolve_node(args.metadata_dir)
    except Exception as exc:failures.append({'name':'Node.js 24 LTS','errorClass':type(exc).__name__})
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        pending={pool.submit(resolve,item,args.metadata_dir):item for item in items}
        for f,item in pending.items():
            try:records.append(f.result())
            except Exception as exc:failures.append({'name':item['name'],'errorClass':type(exc).__name__})
    output={'status':'failed' if failures else 'resolved-not-installed','checkedAt':datetime.now(timezone.utc).isoformat(),
      'baselineDigest':'sha256:'+hashlib.sha256((ROOT/'contracts/v1/dependency-baseline.json').read_bytes()).hexdigest(),
      'node':node,'packages':sorted(records,key=lambda x:x['name']),'failures':failures,'productIntegrationPassed':False}
    args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(output,indent=2)+'\n')
    print(f"{output['status']}: {len(records)} exact candidates; {len(failures)} unresolved; installation not run")
    if failures:raise SystemExit(1)
if __name__=='__main__':main()
