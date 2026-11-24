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
        for _ in 0..<15 { XCTAssertTrue(tap.consume(frame, now: 2000).isEmpty) }
        tap = try InputSegmenter(source: stereo) // Discard partial speech and converter history on mute.
        fill(0)
        for _ in 0..<90 { XCTAssertTrue(tap.consume(frame, now: 3000).isEmpty) }
        fill(0.1)
        for _ in 0..<15 { XCTAssertTrue(tap.consume(frame, now: 4000).isEmpty) }
        fill(0)
        let segments = (0..<90).flatMap { _ in tap.consume(frame, now: 5000) }
        XCTAssertEqual(segments.count, 1)
        let segment = try XCTUnwrap(segments.first)
        // The 300 ms stereo tone spans 4,800 output samples, regardless of when
        // the detector starts treating the steady part of the tone as background.
        let firstTone = try XCTUnwrap(segment.samples.firstIndex { abs($0) > 0.05 })
        let lastTone = try XCTUnwrap(segment.samples.lastIndex { abs($0) > 0.05 })
        XCTAssertEqual(Double(lastTone - firstTone + 1), 4_800, accuracy: 40)
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
            return gate.feed(frame, active: frame[0] != 0, now: now)
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
            XCTAssertTrue(gate.feed(Array(repeating: 0.1, count: limit - 12_800 + extra), active: true, now: 29_200) == nil)
            let segment = gate.feed(silence, active: false, now: 30_000)
            XCTAssertEqual(segment?.samples.count, extra == 0 ? limit : nil)
            XCTAssertTrue(gate.feed([0.2], active: true, now: 31_000) == nil)
            XCTAssertNotNil(gate.feed(silence, active: false, now: 31_800), "This frame already supplied a full silence boundary")
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

    func testCommandOverSteadyBackgroundEndsWhileTheNoiseContinues() async throws {
        let (models, corpus) = try fixtureDirectories()
        let speech = try samples(from: corpus.appending(path: "Steve-0.wav"))
        let onset = 32 * 16_000
        let length = onset + speech.count + 2 * 16_000
        let detector = try SpeechSegmenter()
        var segments: [Segment] = []
        var random: UInt32 = 123
        // Fan hum and broadband noise continue through the command and its ending.
        // Use irregular tap sizes so detector frames cross callback boundaries.
        for start in stride(from: 0, to: length, by: 341) {
            let end = min(start + 341, length)
            let frame: [Float] = (start..<end).map { i in
                random = 1_664_525 &* random &+ 1_013_904_223
                let noise = 0.013 * sin(2 * Float.pi * 60 * Float(i) / 16_000)
                    + 0.006 * (Float(random) / Float(UInt32.max) - 0.5)
                return noise + (speech.indices.contains(i - onset) ? speech[i - onset] : 0)
            }
            segments += detector.consume(frame, now: Int64(end / 16))
        }
        let commands = segments.filter { $0.capturedAt > 31_000 }
        XCTAssertEqual(commands.count, 1)
        let command = try XCTUnwrap(commands.first)
        let recognizer = try await Recognizer(directory: models)
        let utterance = try await recognizer.transcribe(command, boosting: nil)
        let result = try XCTUnwrap(utterance)
        XCTAssertEqual(result.text.lowercased().split(whereSeparator: { !$0.isLetter }), ["steve", "check", "the", "build"])
        XCTAssertFalse(result.words.isEmpty)
    }

    func testKeyReleaseTranscribesTheFinalPhraseWithoutWaitingForSilence() async throws {
        let (models, corpus) = try fixtureDirectories()
        let audio = try samples(from: corpus.appending(path: "Steve-0.wav"))
        let end = try XCTUnwrap(audio.lastIndex { abs($0) > 0.004 }) + 1
        let held = Array(audio.prefix(end))
        let capture = try SpeechSegmenter()
        let release = 1000 + Int64((end + 15) / 16)
        XCTAssertTrue(capture.consume(held, now: release).isEmpty)
        let final = try XCTUnwrap(capture.finish(at: release))
        XCTAssertEqual(final.samples.suffix(100), held.suffix(100))
        XCTAssertNil(capture.finish(at: release))
        let recognizer = try await Recognizer(directory: models)
        let result = try await recognizer.transcribe(final, boosting: nil)
        XCTAssertEqual(result?.text.lowercased().split(whereSeparator: { !$0.isLetter }), ["steve", "check", "the", "build"])
        XCTAssertFalse(try XCTUnwrap(result).words.isEmpty)
    }

    func testKeyReleaseClipsAtTheBoundaryAndCannotFlushDiscardedSpeech() {
        var gate = SpeechGate()
        XCTAssertNil(gate.finish(tail: [], at: 1000))
        let frame = Array(repeating: Float(0.5), count: 320)
        XCTAssertNil(gate.feed(frame, active: true, now: 1020))
        XCTAssertEqual(gate.finish(tail: [0.1, 0.2], at: 1010)?.samples, Array(frame.prefix(160)))
        XCTAssertNil(gate.feed(Array(repeating: 0.5, count: 30 * 16_000), active: true, now: 31_000))
        XCTAssertNil(gate.finish(tail: [], at: 31_000))
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
                let detector = try SpeechSegmenter()
                let segments = detector.consume(samples, now: 1000 + Int64(samples.count / 16))
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
