import Foundation
import FluidAudio
import AVFoundation
struct Clip: Decodable { let id: String; let file: String }
struct MemoryClip: Decodable { let id: String; let sampleRate: Double; let samples: [Float] }
@main struct Probe {
    static func main() async throws {
        let args = CommandLine.arguments
        let start = Date()
        let models = try AsrModels.loadLocal(from: URL(fileURLWithPath: args[1]), version: .v2)
        let manager = AsrManager(); try await manager.loadModels(models)
        print("{\"loadMs\":\(Date().timeIntervalSince(start)*1000)}")
        var boosting: VocabularyBoostingSession? = nil
        if args.count > 3 {
            let ctc = try await CtcModels.loadDirect(from: URL(fileURLWithPath: args[3]))
            let vocabulary = CustomVocabularyContext(terms: ["Steve", "Will", "Luna", "Atlas", "Nova", "Jordan", "Quinn", "Sage", "Phoenix", "Rowan"].map { CustomVocabularyTerm(text: $0) })
            boosting = try await VocabularyBoostingSession(vocabulary: vocabulary, ctcModels: ctc)
        }
        print("{\"readyMs\":\(Date().timeIntervalSince(start)*1000)}")
        if args[2] == "--stdin-samples" {
            while let line = readLine() {
                let clip = try JSONDecoder().decode(MemoryClip.self, from: Data(line.utf8))
                guard !clip.samples.isEmpty else {
                    print("{\"feedbackError\":\"no captured samples\"}")
                    throw NSError(domain: "VoiceSpike", code: 1)
                }
                let format = AVAudioFormat(standardFormatWithSampleRate: clip.sampleRate, channels: 1)!
                let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(clip.samples.count))!
                buffer.frameLength = buffer.frameCapacity
                clip.samples.withUnsafeBufferPointer { buffer.floatChannelData![0].update(from: $0.baseAddress!, count: $0.count) }
                var state = TdtDecoderState.make(decoderLayers: await manager.decoderLayerCount)
                let result = try await manager.transcribe(buffer, decoderState: &state)
                let row: [String: Any] = ["feedbackTranscript": clip.id, "text": result.text]
                print(String(data: try JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]), encoding: .utf8)!)
                fflush(stdout)
            }
            return
        }
        let clips = try JSONDecoder().decode([Clip].self, from: Data(contentsOf: URL(fileURLWithPath: args[2])))
        for clip in clips {
            var state = TdtDecoderState.make(decoderLayers: await manager.decoderLayerCount)
            let t = Date()
            let result = try await manager.transcribe(URL(fileURLWithPath: clip.file), decoderState: &state)
            var text = result.text
            if let boosting {
                let file = try AVAudioFile(forReading: URL(fileURLWithPath: clip.file))
                let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length))!
                try file.read(into: buffer)
                let samples = Array(UnsafeBufferPointer(start: buffer.floatChannelData![0], count: Int(buffer.frameLength)))
                let rescored = await boosting.rescore(text: result.text, tokenTimings: result.tokenTimings ?? [], audioSamples: samples)
                text = rescored?.text ?? result.text
            }
            let words = buildWordTimings(from: result.tokenTimings ?? [])
            let wordData = try JSONEncoder().encode(words)
            let row: [String: Any] = ["id": clip.id, "ms": Date().timeIntervalSince(t)*1000, "text": text, "words": try JSONSerialization.jsonObject(with: wordData)]
            print(String(data: try JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]), encoding: .utf8)!)
            fflush(stdout)
        }
    }
}
