// Import/enumeration only. Never opens the microphone. Use to test native coexistence.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const require=createRequire(resolve('.tmp/voice-spike/node/package.json'));
const sherpa=require('sherpa-onnx-node');
console.log(JSON.stringify({sherpaLoaded:typeof sherpa.OfflineRecognizer==='function',node:process.version,arch:process.arch}));
try {
 const capture=require('naudiodon');
 console.log(JSON.stringify({captureLoaded:true,devices:capture.getDevices()}));
} catch(error) { console.error(JSON.stringify({captureLoaded:false,error:error.message}));process.exitCode=1; }
