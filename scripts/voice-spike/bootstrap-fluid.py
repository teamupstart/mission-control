"""Fetch pinned source and binary dependency; substitute only the download transport."""
import pathlib, subprocess, hashlib, tarfile, zipfile
root = pathlib.Path('.tmp/voice-spike'); root.mkdir(parents=True, exist_ok=True)
revision = 'eb280cede001a9a35f2187d4a117537777eca756'
def fetch(url, path):
    subprocess.run(['curl', '-fsSL', '--retry', '2', '--max-time', '180', url, '-o', str(path)], check=True)
archive = root / 'fluid-source.tar.gz'
fetch(f'https://github.com/FluidInference/FluidAudio/archive/{revision}.tar.gz', archive)
with tarfile.open(archive) as tar: tar.extractall(root, filter='data')
artifact = root / 'NemoTextProcessing.xcframework.zip'
fetch('https://github.com/FluidInference/text-processing-rs/releases/download/v0.3.4/NemoTextProcessing.xcframework.zip', artifact)
assert hashlib.file_digest(artifact.open('rb'), 'sha256').hexdigest() == 'fdfebc5ce0938624435aa217d5425394f0b946cc0dd47bd01b66917e671be851'
with zipfile.ZipFile(artifact) as archive: archive.extractall(root / 'nemo-local')
for path in (root / ('FluidAudio-' + revision)).glob('Package*.swift'):
    source = path.read_text()
    old = 'url:\n                "https://github.com/FluidInference/text-processing-rs/releases/download/v0.3.4/NemoTextProcessing.xcframework.zip",\n            checksum: "fdfebc5ce0938624435aa217d5425394f0b946cc0dd47bd01b66917e671be851"'
    assert old in source
    path.write_text(source.replace(old, 'path: "../nemo-local/NemoTextProcessing.xcframework"'))
print('Pinned FluidAudio source and checksum-verified dependency ready; no library source changed.')
