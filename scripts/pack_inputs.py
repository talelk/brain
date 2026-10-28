from pathlib import Path
import hashlib

ROOT=Path(__file__).resolve().parents[1]
def input_paths():
    paths=[ROOT/'IMPLEMENTATION.md', ROOT/'IMPLEMENTATION_PROMPT.md', ROOT/'AGENTS.md', ROOT/'opencode.json']
    paths += [ROOT/'artifacts/implementation'/name for name in ['execution-environment.json','dependency-resolution.json'] if (ROOT/'artifacts/implementation'/name).is_file()]
    for directory in ['docs/implementation','contracts','examples/v1','sql/reference','scripts','deploy/reference']:
        paths.extend(p for p in (ROOT/directory).rglob('*') if p.is_file() and '__pycache__' not in p.parts)
    return sorted(set(paths))
def input_fingerprint():
    digest=hashlib.sha256()
    for p in input_paths():
        digest.update(str(p.relative_to(ROOT)).encode()+b'\0'+hashlib.sha256(p.read_bytes()).digest())
    return digest.hexdigest()
