import AVFoundation
import XCTest
@testable import VoiceListener

final class ListenerTests: XCTestCase {
    func testStereoDeviceConversionSilenceAndFreshSegmentAfterMute() throws {
        let stereo = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 2)!
        let frame = AVAudioPCMBuffer(pcmFormat: stereo, frameCapacity: 960)!
        frame.frameLength = 960
        func fill(_ amplitude: Float) {
            for channel in 0..<2 {
                for i in 0..<Int(frame.frameLength) {
                    frame.floatChannelData![channel][i] = amplitude * sin(Float(i) * 2 * .pi * 400 / 48_000)
                }
            }
        }
        var tap = try InputSegmenter(source: stereo)
        fill(0.1)
        for _ in 0..<15 { XCTAssertNil(tap.consume(frame, now: 2000)) }
        tap = try InputSegmenter(source: stereo) // Discard partial speech and converter history on mute.
        fill(0)
        for _ in 0..<90 { XCTAssertNil(tap.consume(frame, now: 3000)) }
        fill(0.1)
        for _ in 0..<15 { XCTAssertNil(tap.consume(frame, now: 4000)) }
        fill(0)
        let segments = (0..<90).compactMap { _ in tap.consume(frame, now: 5000) }
        XCTAssertEqual(segments.count, 1)
        let segment = try XCTUnwrap(segments.first)
        // 150 ms pre-roll + 300 ms speech + 800 ms hangover at 16 kHz, within one tap callback.
        XCTAssertEqual(Double(segment.samples.count), 20_000, accuracy: 640)
        XCTAssertGreaterThan(segment.capturedAt, 3000)
    }

    func testMultiWordRosterCorrectionAlignsTimingLabelsWithinDecoderSpan() {
        var text = "maryjane,  ask mare tomorrow!"
        var words = [
            TimedWord(text: "maryjane,", startMs: 120, endMs: 375),
            TimedWord(text: "ask", startMs: 410, endMs: 490),
            TimedWord(text: "mare", startMs: 500, endMs: 580),
            TimedWord(text: "tomorrow!", startMs: 600, endMs: 730)
        ]
        let roster = ["Mary Jane", "Mary"]
        Recognizer.applyAddressCorrection("Mary", in: 2..<3, roster: roster, text: &text, words: &words)
        Recognizer.applyAddressCorrection("Mary Jane", in: 0..<1, roster: roster, text: &text, words: &words)
        XCTAssertEqual(text, "Mary Jane,  ask mare tomorrow!")
        XCTAssertEqual(words.map(\.text), ["Mary", "Jane,", "ask", "mare", "tomorrow!"])
        XCTAssertEqual(words.map(\.startMs), [120, 247.5, 410, 500, 600])
        XCTAssertEqual(words.map(\.endMs), [247.5, 375, 490, 580, 730])
    }

    func testRosterCorrectionCannotCrossTheAddressCommaOrAnExactFirstName() {
        for original in ["Will, smith can help", "Will smith, can help", "Wyl smith can help"] {
            var text = original
            var words = text.split(separator: " ").map { TimedWord(text: String($0), startMs: 0, endMs: 10) }
            Recognizer.applyAddressCorrection("Will Smith", in: 0..<2, roster: ["Will", "Will Smith"], text: &text, words: &words)
            XCTAssertEqual(text, original)
            XCTAssertEqual(words.map(\.text).joined(separator: " "), original)
        }
    }

    func testOverlongSpeechIsDiscardedUntilACompleteSilenceBoundary() throws {
        var gate = SpeechGate()
        let speech = Array(repeating: Float(0.1), count: 320)
        let quiet = Array(repeating: Float(0), count: 320)
        var now: Int64 = 0
        func feed(_ frame: [Float]) -> Segment? {
            now += 20
            return gate.feed(frame, now: now)
        }
        for _ in 0..<1500 { XCTAssertTrue(feed(speech) == nil) } // 30 seconds
        for _ in 0..<39 { XCTAssertTrue(feed(quiet) == nil) } // 780 ms is still inside the utterance.
        for _ in 0..<1510 { XCTAssertTrue(feed(speech) == nil) }
        for _ in 0..<40 { XCTAssertTrue(feed(quiet) == nil) }

        let freshStart = now
        let fresh = Array(repeating: Float(0.2), count: 320)
        XCTAssertTrue(feed(fresh) == nil)
        for _ in 0..<39 { XCTAssertTrue(feed(quiet) == nil) }
        let segment = try XCTUnwrap(feed(quiet))
        XCTAssertEqual(segment.capturedAt, freshStart)
        XCTAssertEqual(segment.samples, fresh + Array(repeating: 0, count: 12_800))
    }

    func testSilenceMustCompleteWithinTheSegmentLimit() {
        let limit = 16_000 * 30
        let silence = Array(repeating: Float(0), count: 12_801)
        for extra in [0, 1] {
            var gate = SpeechGate()
            XCTAssertTrue(gate.feed(Array(repeating: 0.1, count: limit - 12_800 + extra), now: 29_200) == nil)
            let segment = gate.feed(silence, now: 30_000)
            XCTAssertEqual(segment?.samples.count, extra == 0 ? limit : nil)
            XCTAssertTrue(gate.feed([0.2], now: 31_000) == nil)
            XCTAssertNotNil(gate.feed(silence, now: 31_800), "This frame already supplied a full silence boundary")
        }
    }

    private func fixtureDirectories() throws -> (models: URL, corpus: URL) {
        let env = ProcessInfo.processInfo.environment
        guard let models = env["MISSION_VOICE_MODEL_DIR"], let audio = env["VOICE_TEST_CORPUS"] else {
            throw XCTSkip("Supply the downloaded model revision and the spike corpus directory.")
        }
        return (URL(fileURLWithPath: models), URL(fileURLWithPath: audio))
    }

    private func samples(from url: URL) throws -> [Float] {
        let file = try AVAudioFile(forReading: url)
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)))
        try file.read(into: buffer)
        return Array(UnsafeBufferPointer(start: buffer.floatChannelData![0], count: Int(buffer.frameLength)))
    }

    func testMissingCTCDisablesPrimingAndStillTranscribes() async throws {
        let (models, corpus) = try fixtureDirectories()
        let files = FileManager.default
        let plain = files.temporaryDirectory.appending(path: UUID().uuidString)
        try files.createDirectory(at: plain, withIntermediateDirectories: false)
        defer { try? files.removeItem(at: plain) }
        let tdt = "parakeet-tdt-0.6b-v2-coreml"
        try files.createSymbolicLink(at: plain.appending(path: tdt), withDestinationURL: models.appending(path: tdt))

        let recognizer = try await Recognizer(directory: plain)
        XCTAssertNil(recognizer.ctc)
        let boosting = try await recognizer.prime(["Steve"])
        XCTAssertNil(boosting)
        let segment = Segment(samples: try samples(from: corpus.appending(path: "Steve-0.wav")), capturedAt: 1000)
        let utterance = try await recognizer.transcribe(segment, boosting: boosting)
        let result = try XCTUnwrap(utterance)
        XCTAssertEqual(result.text.lowercased().split(whereSeparator: { !$0.isLetter }), ["steve", "check", "the", "build"])
        XCTAssertFalse(result.words.isEmpty)
    }

    func testGeneratedFirstWordsPlainAndPrimed() async throws {
        let (models, corpus) = try fixtureDirectories()
        let recognizer = try await Recognizer(directory: models)
        let names = ["Steve", "Will", "Luna", "Atlas", "Nova", "Jordan", "Quinn", "Sage", "Phoenix", "Rowan"]
        let primed = try await recognizer.prime(names)
        XCTAssertNotNil(primed)
        struct Clip: Decodable { let id: String; let text: String }
        let clips = try JSONDecoder().decode([Clip].self, from: Data(contentsOf: corpus.appending(path: "corpus.json")))
        XCTAssertEqual(clips.count, 57)
        for boosting in [nil, primed] {
            for clip in clips {
                let name = clip.text.split(whereSeparator: { !$0.isLetter }).first.map(String.init)
                let url = corpus.appending(path: clip.id + ".wav")
                var samples = try self.samples(from: url)
                samples += Array(repeating: 0, count: 16_000)
                var gate = SpeechGate()
                var segments: [Segment] = []
                for i in stride(from: 0, to: samples.count, by: 320) {
                    if let segment = gate.feed(Array(samples[i..<min(i+320, samples.count)]), now: 1000 + Int64(i/16)) {
                        segments.append(segment)
                    }
                }
                XCTAssertEqual(segments.count, 1, clip.id)
                let segment = try XCTUnwrap(segments.first)
                let utterance = try await recognizer.transcribe(segment, boosting: boosting)
                let result = try XCTUnwrap(utterance)
                XCTAssertEqual(result.text.split(whereSeparator: { !$0.isLetter }).first.map(String.init), name, clip.id)
                XCTAssertFalse(result.words.isEmpty)
                XCTAssertTrue(result.words.allSatisfy { $0.startMs >= 0 && $0.endMs >= $0.startMs })
            }
        }
    }
}
