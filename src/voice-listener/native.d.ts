// sherpa-onnx-node@2.0.3 ships JSDoc but no TypeScript declarations.
declare module "sherpa-onnx-node" {
  interface Waveform {
    sampleRate: number;
    samples: Float32Array;
  }

  export class OfflineTts {
    constructor(config: {
      model: {
        supertonic: Record<"durationPredictor" | "textEncoder" | "vectorEstimator" | "vocoder" | "ttsJson" | "unicodeIndexer" | "voiceStyle", string>;
        numThreads: number; provider: "cpu"; debug: number;
      };
      maxNumSentences: number;
    });
    generate(request: { text: string; generationConfig: { sid: number; speed: number; numSteps: number; extra: { lang: string } } }): Waveform;
  }

  interface OfflineStream {
    acceptWaveform(wave: Waveform): void;
  }

  export class OfflineRecognizer {
    constructor(config: {
      featConfig: { sampleRate: number; featureDim: number };
      modelConfig: {
        transducer: { encoder: string; decoder: string; joiner: string };
        modelType: "nemo_transducer";
        tokens: string;
        numThreads: number;
        provider: "cpu";
      };
      decodingMethod: "modified_beam_search";
    });
    createStream(hotwords?: string): OfflineStream;
    decodeAsync(stream: OfflineStream): Promise<import("./words.ts").Recognition>;
  }

  export class Vad {
    constructor(config: {
      sileroVad: { model: string; windowSize: number; minSilenceDuration: number; minSpeechDuration: number };
      numThreads: number;
      sampleRate: number;
    }, bufferSeconds: number);
    acceptWaveform(samples: Float32Array): void;
    flush(): void;
    isEmpty(): boolean;
    front(): { start: number; samples: Float32Array };
    pop(): void;
    reset(): void;
  }
}
