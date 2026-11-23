"""Download exact public model revisions. Hash actual bytes, not Git/LFS pointer text."""
import json, pathlib, hashlib, subprocess
root = pathlib.Path('.tmp/voice-spike')
specs = [('fluid', 'FluidInference/parakeet-tdt-0.6b-v2-coreml', 'ee09c569f73759e6d44c9bd16766f477b2b36d39'), ('sherpa', 'csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8', '84b478d541cdbf0c296a7ab5f1e20a6f8f998114'), ('small-tdt', 'csukuangfj/sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000', 'e9bea5a06247dc3f55319ff23d34b0328f2f5ddf'), ('ctc', 'FluidInference/parakeet-ctc-110m-coreml', 'accdafd8cf8a2ff1cabe3c11e54416b405d409aa')]
manifest = []
for backend, repo, revision in specs:
    metadata = root / (backend + '-pinned.json')
    subprocess.run(['curl', '-fsSL', '--retry', '2', '--max-time', '60', f'https://huggingface.co/api/models/{repo}/revision/{revision}?blobs=true', '-o', str(metadata)], check=True)
    meta = json.loads(metadata.read_text())
    for item in meta['siblings']:
        name = item['rfilename']
        if backend == 'fluid':
            if not (name.split('/')[0] in ['Encoder.mlmodelc', 'Decoder.mlmodelc', 'JointDecision.mlmodelc', 'Preprocessor.mlmodelc'] or name == 'parakeet_vocab.json'): continue
        elif backend == 'ctc':
            if not (name.split('/')[0] in ['MelSpectrogram.mlmodelc', 'AudioEncoder.mlmodelc', 'CtcHead.mlmodelc'] or name in ['vocab.json', 'tokenizer.json']): continue
        elif backend == 'small-tdt':
            if name not in ['encoder.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt', 'test_wavs/0.wav']: continue
        elif name not in ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt']: continue
        dest = root / backend / name; dest.parent.mkdir(parents=True, exist_ok=True)
        if not dest.exists() or dest.stat().st_size != item['size']:
            subprocess.run(['curl', '-fsSL', '--retry', '2', '--max-time', '600', f'https://huggingface.co/{repo}/resolve/{revision}/{name}', '-o', str(dest)], check=True)
        digest = hashlib.file_digest(dest.open('rb'), 'sha256').hexdigest()
        assert dest.stat().st_size == item['size']
        if item.get('lfs'): assert digest == item['lfs']['sha256']
        manifest.append(dict(backend=backend, repository=repo, revision=revision, file=name, bytes=dest.stat().st_size, sha256=digest))
        print(backend, name, dest.stat().st_size, flush=True)
(root / 'model-manifest.json').write_text(json.dumps(manifest, indent=2)+'\n')
