"""Download and verify every file against the committed model manifest."""
import json, pathlib, hashlib, subprocess
root = pathlib.Path('.tmp/voice-spike')
pins = json.loads(pathlib.Path(__file__).with_name('models.json').read_text())
manifest = []
for item in pins:
    backend, repo, revision, name = (item[key] for key in ['backend', 'repository', 'revision', 'file'])
    dest = root / backend / name
    dest.parent.mkdir(parents=True, exist_ok=True)
    if not dest.exists():
        subprocess.run(['curl', '-fsSL', '--retry', '2', '--max-time', '600', f'https://huggingface.co/{repo}/resolve/{revision}/{name}', '-o', str(dest)], check=True)
    size = dest.stat().st_size
    with dest.open('rb') as source:
        digest = hashlib.file_digest(source, 'sha256').hexdigest()
    if size != item['bytes'] or digest != item['sha256']:
        raise ValueError(
            f'{dest}: models.json mismatch; expected {item["bytes"]} bytes / {item["sha256"]}, '
            f'got {size} bytes / {digest}. Remove the invalid file and rerun to download it again.'
        )
    manifest.append(dict(backend=backend, repository=repo, revision=revision, file=name, bytes=size, sha256=digest))
    print(backend, name, size, 'SHA-256 verified', flush=True)
(root / 'model-manifest.json').write_text(json.dumps(manifest, indent=2)+'\n')
