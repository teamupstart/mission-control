"""Synthetic speech only. Strip say's padding, then insert exact 16 kHz PCM silence."""
import subprocess, wave, array, pathlib, json, hashlib
out = pathlib.Path('.tmp/voice-spike/audio'); out.mkdir(parents=True, exist_ok=True)
names = ['Steve', 'Will', 'Luna', 'Atlas', 'Nova', 'Jordan', 'Quinn', 'Sage', 'Phoenix', 'Rowan']
def speech(text):
    path = out / 'scratch.wav'
    subprocess.run(['say', '-v', 'Samantha', '-r', '180', '-o', str(path), '--file-format=WAVE', '--data-format=LEI16@16000', text], check=True)
    with wave.open(str(path)) as f:
        assert f.getnchannels() == 1 and f.getframerate() == 16000
        samples = array.array('h', f.readframes(f.getnframes()))
    audible = [i for i,x in enumerate(samples) if abs(x) > 100]
    assert audible, 'say produced silence'
    return samples[audible[0]:audible[-1]+1]
rows = []
def save(id, samples, **meta):
    path = out / (id + '.wav')
    with wave.open(str(path), 'wb') as f:
        f.setnchannels(1); f.setsampwidth(2); f.setframerate(16000); f.writeframes(samples.tobytes())
    rows.append(dict(id=id, file=str(path), seconds=len(samples)/16000, sha256=hashlib.sha256(path.read_bytes()).hexdigest(), **meta))
for name in names:
    for i, tail in enumerate(['check the build', 'check the build and tell me what failed', 'check the build and tell me which tests failed before you change any files']):
        first, last = speech(name), speech(tail)
        samples = first+array.array('h',[0]*4000)+last
        samples += array.array('h', [0]*max(0, (i+1)*32000-len(samples)))
        save(f'{name}-{i}', samples, name=name, text=f'{name}, {tail}', insertedGapMs=250)
for gap in [0, 100, 150, 200, 250, 300, 400, 500]:
    for repeat in range(3):
        first, last = speech('Will'), speech('grab the door')
        save(f'gap-{gap}-{repeat}',first+array.array('h',[0]*(gap*16))+last,name='Will',text='Will, grab the door',insertedGapMs=gap)
for i in range(3): save(f'continuous-{i}', speech('Will you grab the door'), text='Will you grab the door', insertedGapMs=None)
(out/'corpus.json').write_text(json.dumps(rows,indent=2)+'\n')
print(json.dumps({'clips':len(rows),'minSeconds':min(r['seconds'] for r in rows),'maxSeconds':max(r['seconds'] for r in rows)}))
