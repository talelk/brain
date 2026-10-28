#!/usr/bin/env python3
"""Check local coding setup without displaying credentials or contacting a model."""
import argparse,json,os,shutil,subprocess,tempfile
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
MODEL='local-qwen/qwen3.8-flash-next-a5b'
def check(check_loader=False):
    config=json.loads((ROOT/'opencode.json').read_text())
    assert config['model']==MODEL and config['default_agent']=='brain-implementer'
    assert 'steps' not in config['agents']['brain-implementer']
    for entry in config['instructions']:
        path=Path(entry) if entry.startswith('/') else ROOT/entry
        assert path.is_file(),f'Missing instruction: {entry}'
    binary=shutil.which('opencode') or str(Path.home()/'.opencode/bin/opencode')
    with tempfile.TemporaryDirectory(prefix='brain-opencode-check-') as temp:
        env={**os.environ,'XDG_DATA_HOME':temp+'/data','XDG_CACHE_HOME':temp+'/cache','XDG_STATE_HOME':temp+'/state'}
        version=subprocess.run([binary,'--version'],env=env,capture_output=True,text=True,timeout=20)
        assert version.returncode==0,'OpenCode version probe failed'
        assert version.stdout.strip().endswith('2.1.4'),'Expected OpenCode 2.1.4; review native schema before changing pin'
        result={'opencode':'2.1.4','projectModel':MODEL,'instructionFiles':len(config['instructions']),'providerReady':False,'loader':'not-run','modelQualification':'not-run'}
        # Read only the selected provider's allowlisted metadata; never print raw config.
        global_path=Path(os.environ.get('XDG_CONFIG_HOME',str(Path.home()/'.config')))/'opencode/opencode.json'
        if global_path.is_file():
            global_config=json.loads(global_path.read_text());pid,mid=MODEL.split('/',1)
            provider=(global_config.get('providers') or global_config.get('provider') or {}).get(pid,{})
            model=provider.get('models',{}).get(mid)
            result['providerReady']=model is not None
            if model:result['declaredLimits']=model.get('limit',{})
        if check_loader:
            probe=subprocess.run([binary,'debug','config'],cwd=ROOT,env=env,capture_output=True,text=True,timeout=30)
            # No effective config, key, address or stderr enters returned output.
            result['loader']='passed' if probe.returncode==0 and 'opencode.json' in probe.stdout else 'failed'
            assert result['loader']=='passed','Native configuration source check failed (raw output intentionally suppressed)'
        assert result['providerReady'],'Configured local provider/model not found; provision it outside the project, without committing secrets'
        return result
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--check-loader',action='store_true');args=p.parse_args()
    try:print(json.dumps(check(args.check_loader),indent=2))
    except (AssertionError,OSError,ValueError,subprocess.TimeoutExpired) as e:raise SystemExit(str(e))
