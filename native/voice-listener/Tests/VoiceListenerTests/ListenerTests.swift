import AVFoundation
import XCTest
@testable import VoiceListener

// The test drives tap callbacks explicitly so it can release between two buffers.
private final class TapFixtureEngine: AVAudioEngine, @unchecked Sendable {
    private var started = false
    override var isRunning: Bool { started }
    override func start() throws { started = true }
    override func stop() { started = false }
}

final class ListenerTests: XCTestCase {
    func testHeldPostDeadlineCancelsAnUnansweredRequest() async throws {
        let cancelled = expectation(description: "pending send cancelled")
        do {
            _ = try await Daemon.postWithHeldRetries(revision: "held", budget: .milliseconds(100)) {
                do { try await Task.sleep(for: .seconds(60)) }
                catch { cancelled.fulfill(); throw error }
                throw URLError(.badServerResponse)
            }
            XCTFail("A stalled send must expire")
        } catch let error as URLError {
            XCTAssertEqual(error.code, .timedOut)
        }
        await fulfillment(of: [cancelled], timeout: 1)
    }

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
        var start = 2000
        func consume() -> [Segment] {
            defer { start += 20 }
            return tap.consume(frame, at: AVAudioTime(hostTime: AVAudioTime.hostTime(forSeconds: Double(start) / 1000)))
        }
        fill(0.1)
        for _ in 0..<15 { XCTAssertTrue(consume().isEmpty) }
        tap = try InputSegmenter(source: stereo) // Discard partial speech and converter history on mute.
        fill(0)
        for _ in 0..<90 { XCTAssertTrue(consume().isEmpty) }
        fill(0.1)
        for _ in 0..<15 { XCTAssertTrue(consume().isEmpty) }
        fill(0)
        let segments = (0..<110).flatMap { _ in consume() }
        XCTAssertEqual(segments.count, 1)
        let segment = try XCTUnwrap(segments.first)
        // The 300 ms stereo tone spans 4,800 output samples, regardless of when
        // the detector starts treating the steady part of the tone as background.
        let firstTone = try XCTUnwrap(segment.samples.firstIndex { abs($0) > 0.05 })
        let lastTone = try XCTUnwrap(segment.samples.lastIndex { abs($0) > 0.05 })
        XCTAssertEqual(Double(lastTone - firstTone + 1), 4_800, accuracy: 40)
        XCTAssertGreaterThan(segment.startedAtHostMs, 3000)
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

    func testExactMultiWordAddressWinsOverCompetingRosterCorrection() {
        for range in [0..<2, 0..<1] {
            var text = "Mary   Jane, check the build"
            let original = text
            let decoded = ["Mary", "Jane,", "check", "the", "build"]
            var words = decoded.enumerated().map {
                TimedWord(text: $0.element, startMs: Double($0.offset * 100), endMs: Double($0.offset * 100 + 80))
            }
            Recognizer.applyAddressCorrection("Mary Jean", in: range, roster: ["Mary Jean", "mary jane"],
                                              text: &text, words: &words)
            XCTAssertEqual(text, original)
            XCTAssertEqual(words.map(\.text), decoded)
            XCTAssertEqual(words.map(\.endMs), [80, 180, 280, 380, 480])
        }
    }

    func testShortRosterEntryAllowsCorrectionOfExplicitLongerAddress() {
        var text = "Will Smyth, check the build"
        var words = text.split(separator: " ").enumerated().map {
            TimedWord(text: String($0.element), startMs: Double($0.offset * 100), endMs: Double($0.offset * 100 + 80))
        }
        Recognizer.applyAddressCorrection("Will Smith", in: 0..<2, roster: ["Will", "Will Smith"], text: &text, words: &words)
        XCTAssertEqual(text, "Will Smith, check the build")
        XCTAssertEqual(words.map(\.text), ["Will", "Smith,", "check", "the", "build"])
        XCTAssertEqual(words.map(\.startMs), [0, 100, 200, 300, 400])
    }

    func testPartialRosterMatchCannotRewriteACommaDelimitedAddress() {
        let original = "Wyl Smyth, check the build"
        let decoded = original.split(separator: " ").enumerated().map {
            TimedWord(text: String($0.element), startMs: Double($0.offset * 100), endMs: Double($0.offset * 100 + 80))
        }
        var text = original
        var words = decoded
        Recognizer.applyAddressCorrection("Will Smith", in: 0..<1, roster: ["Will Smith"], text: &text, words: &words)
        XCTAssertEqual(text, original)
        XCTAssertEqual(words.map(\.text), decoded.map(\.text))
        XCTAssertEqual(words.map(\.startMs), decoded.map(\.startMs))
        XCTAssertEqual(words.map(\.endMs), decoded.map(\.endMs))
    }

    func testMessageCommaPreservesFirstWordAddressCorrection() {
        for original in ["Wyl check the build, please", "Wyl stop, please"] {
            var text = original
            let decoded = original.split(separator: " ").enumerated().map {
                TimedWord(text: String($0.element), startMs: Double($0.offset * 100), endMs: Double($0.offset * 100 + 80))
            }
            var words = decoded
            Recognizer.applyAddressCorrection("Will", in: 0..<1, roster: ["Will"], text: &text, words: &words)
            XCTAssertEqual(text, "Will" + original.dropFirst(3))
            XCTAssertEqual(words.map(\.text), ["Will"] + decoded.dropFirst().map(\.text))
            XCTAssertEqual(words.map(\.startMs), decoded.map(\.startMs))
            XCTAssertEqual(words.map(\.endMs), decoded.map(\.endMs))
        }
    }

    func testFirstVoicedSampleOrdersSpeechIndependentlyOfThePCMLeadIn() throws {
        var gate = SpeechGate(held: true)
        let quiet = Array(repeating: Float(0), count: 2400)
        XCTAssertNil(gate.feed(quiet, active: false, endNs: 1_150_000_000))
        let frame = Array(quiet.prefix(16)) + Array(repeating: Float(0.2), count: 304)
        XCTAssertNil(gate.feed(frame, active: true, endNs: 1_170_000_000))
        let released = try XCTUnwrap(gate.finish(at: 1160))
        XCTAssertEqual(released.startedAtHostUs, 1_000_000)
        XCTAssertEqual(released.speechStartHostUs, 1_151_000)
        XCTAssertEqual(released.endedAt, 1160)
    }

    func testAutomaticSpeechResumingBeforeSelectedBoundaryStaysInOneUtterance() throws {
        for duration in [500, 2000, 5000] {
            var gate = duration == 2000 ? SpeechGate() : SpeechGate(endOfSpeechMs: duration)
            let pause = Array(repeating: Float(0), count: duration * 16 - 1)
            var now: Int64 = 0
            func feed(_ frame: [Float], voiced: Bool) -> Segment? {
                now += Int64(frame.count) * Segment.sampleNs
                return gate.feed(frame, active: voiced, endNs: now)
            }
            XCTAssertNil(feed([0.1], voiced: true))
            XCTAssertNil(feed(pause, voiced: false))
            XCTAssertNil(feed([0.2], voiced: true))
            XCTAssertNil(feed(pause, voiced: false))
            let complete = try XCTUnwrap(feed([0], voiced: false))
            XCTAssertEqual(complete.samples, [0.1] + pause + [0.2] + pause + [0])
            XCTAssertNil(feed([0], voiced: false))
        }
    }

    func testLiveDelayChangeCountsSilenceAlreadyRecorded() throws {
        var gate = SpeechGate(endOfSpeechMs: 2000)
        let speech: [Float] = [0.25, 0.5]
        let quiet = Array(repeating: Float(0), count: 16_000)
        XCTAssertNil(gate.feed(speech, active: true, endNs: Int64(speech.count) * Segment.sampleNs))
        XCTAssertNil(gate.feed(quiet, active: false, endNs: Int64(speech.count + quiet.count) * Segment.sampleNs))

        var shortened = gate
        let early = try XCTUnwrap(shortened.updateEndOfSpeechMs(500))
        XCTAssertEqual(early.samples, speech + Array(quiet.prefix(8000)))
        XCTAssertNil(shortened.updateEndOfSpeechMs(500))

        XCTAssertNil(gate.updateEndOfSpeechMs(3000))
        XCTAssertNil(gate.feed(quiet, active: false, endNs: 2_000_125_000))
        let later = try XCTUnwrap(gate.feed(quiet, active: false, endNs: 3_000_125_000))
        XCTAssertEqual(later.samples, speech + Array(repeating: 0, count: 48_000))
    }

    func testShorteningAnElapsedPauseCarriesOnlyItsBoundedTailIntoTheNextPhrase() throws {
        for extra in [0, 320, 3200] {
            var gate = SpeechGate(endOfSpeechMs: 2000)
            var now: Int64 = 0
            func feed(_ pcm: [Float], active: Bool) -> Segment? {
                now += Int64(pcm.count) * Segment.sampleNs
                return gate.feed(pcm, active: active, endNs: now)
            }
            let quiet = Array(repeating: Float(0), count: 8000)
            let soft = (0..<extra).map { Float($0 + 1) / 2_000_000 }
            XCTAssertNil(feed([0.2], active: true))
            XCTAssertNil(feed(quiet + soft, active: false))
            let first = try XCTUnwrap(gate.updateEndOfSpeechMs(500))
            XCTAssertEqual(first.samples, [0.2] + quiet)
            let onset = now
            XCTAssertNil(feed([0.3], active: true))
            let second = try XCTUnwrap(feed(quiet, active: false))
            let retained = Array(soft.suffix(2400))
            XCTAssertEqual(second.samples, retained + [0.3] + quiet)
            XCTAssertEqual(second.firstVoicedSample, retained.count)
            XCTAssertEqual(second.startNs, onset - Int64(retained.count) * Segment.sampleNs)
        }
    }

    func testLiveMicrophoneDelayEditsPreserveBothCommandsAndCompleteAnElapsedPause() async throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appending(path: "../../../..")
        let speech = try samples(from: root.appending(path: "test/fixtures/voice/steve-check-the-build.wav"))
        let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1))
        let engine = TapFixtureEngine()
        try engine.enableManualRenderingMode(.offline, format: format, maximumFrameCount: 1024)
        XCTAssertTrue(engine.inputNode.setManualRenderingInputPCMFormat(format) { _ in nil })
        engine.connect(engine.inputNode, to: engine.mainMixerNode, format: format)
        let mic = try Microphone(selection: "system-default", endOfSpeechMs: 500, devices: [], engine: engine)
        var offset = 0
        func feed(_ pcm: [Float]) throws {
            let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(pcm.count)))
            buffer.frameLength = buffer.frameCapacity
            buffer.floatChannelData![0].update(from: pcm, count: pcm.count)
            let time = AVAudioTime(hostTime: AVAudioTime.hostTime(forSeconds: 1 + Double(offset) / 16_000),
                                   sampleTime: Int64(offset), atRate: 16_000)
            mic.consume(buffer, at: time)
            offset += pcm.count
        }

        let split = 12_005 // Inside the first command and partway through a 320-sample VAD frame.
        try feed(Array(speech.prefix(split)))
        mic.updateEndOfSpeechMs(5000)
        try feed(Array(speech.dropFirst(split)))
        try feed(Array(repeating: 0, count: 32_000))
        try feed(speech)
        try feed(Array(repeating: 0, count: 16_000))
        mic.updateEndOfSpeechMs(500)
        mic.stop() // No more tap frames. Shortening the elapsed pause must already have yielded the segment.
        var completed: [Segment] = []
        for await segment in mic.segments { completed.append(segment) }
        XCTAssertEqual(completed.count, 1)
        let joined = try XCTUnwrap(completed.first)
        let voiced = speech.filter { abs($0) > 0.02 }
        XCTAssertFalse(voiced.isEmpty)
        XCTAssertTrue(joined.samples.filter { abs($0) > 0.02 }.elementsEqual(voiced + voiced),
                      "Both commands, including the partial frame at the edit, must survive in capture order")
    }

    func testOverlongSpeechIsDiscardedUntilACompleteSilenceBoundary() throws {
        var dropped: [Int64] = []
        var gate = SpeechGate(endOfSpeechMs: 800, onSegmentDropped: { dropped.append($0) })
        let speech = Array(repeating: Float(0.1), count: 320)
        let quiet = Array(repeating: Float(0), count: 320)
        var now: Int64 = 0
        func feed(_ frame: [Float]) -> Segment? {
            now += 20
            return gate.feed(frame, active: frame[0] != 0, endNs: now * 1_000_000)
        }
        for _ in 0..<1500 { XCTAssertTrue(feed(speech) == nil) } // 30 seconds
        XCTAssertEqual(dropped, [0])
        for _ in 0..<39 { XCTAssertTrue(feed(quiet) == nil) } // 780 ms is still inside the utterance.
        for _ in 0..<1510 { XCTAssertTrue(feed(speech) == nil) }
        for _ in 0..<40 { XCTAssertTrue(feed(quiet) == nil) }

        let freshStart = now
        let fresh = Array(repeating: Float(0.2), count: 320)
        XCTAssertTrue(feed(fresh) == nil)
        for _ in 0..<39 { XCTAssertTrue(feed(quiet) == nil) }
        let segment = try XCTUnwrap(feed(quiet))
        XCTAssertEqual(segment.startedAtHostMs, freshStart)
        XCTAssertEqual(segment.samples, fresh + Array(repeating: 0, count: 12_800))
        XCTAssertEqual(dropped, [0])
    }

    func testSilenceMustCompleteWithinTheSegmentLimit() {
        let limit = 16_000 * 30
        let silence = Array(repeating: Float(0), count: 12_801)
        for extra in [0, 1] {
            var gate = SpeechGate(endOfSpeechMs: 800)
            XCTAssertTrue(gate.feed(Array(repeating: 0.1, count: limit - 12_800 + extra), active: true, endNs: 29_200 * 1_000_000) == nil)
            let segment = gate.feed(silence, active: false, endNs: 30_000 * 1_000_000)
            XCTAssertEqual(segment?.samples.count, extra == 0 ? limit : nil)
            XCTAssertTrue(gate.feed([0.2], active: true, endNs: 31_000 * 1_000_000) == nil)
            XCTAssertNotNil(gate.feed(silence, active: false, endNs: 31_800 * 1_000_000), "This frame already supplied a full silence boundary")
        }
    }

    func testDelayedKeyUpCanRecoverOnlyThePreReleasePartOfAnOverflowedHold() throws {
        let limit = 30 * 16_000
        let start: Int64 = 1_000_000_000
        let samples = Array(repeating: Float(0.3), count: limit - 160)
        let crossing = Array(repeating: Float(0.8), count: 320)
        var dropped: [Int64] = []
        func overflow() -> SpeechGate {
            var gate = SpeechGate(held: true, onSegmentDropped: { dropped.append($0) })
            XCTAssertNil(gate.feed(samples, active: true, endNs: start + Int64(samples.count) * Segment.sampleNs))
            XCTAssertNil(gate.feed(crossing, active: true, endNs: 31_010_000_000))
            return gate
        }
        // The final callback crossed the cap by 10 ms. Key-up was 5 ms before the cap.
        var gate = overflow()
        let recovered = try XCTUnwrap(gate.finish(at: 30_995))
        XCTAssertEqual(recovered.samples.count, limit - 80)
        XCTAssertEqual(recovered.samples.suffix(80), crossing.prefix(80))
        XCTAssertEqual(recovered.endedAt, 30_995)
        XCTAssertTrue(dropped.isEmpty)
        gate = overflow()
        XCTAssertNil(gate.finish(at: 31_001))
        gate = overflow()
        let quiet = Array(repeating: Float(0), count: 320)
        for i in 1...100 {
            XCTAssertNil(gate.feed(quiet, active: false, endNs: 31_010_000_000 + Int64(i) * 20_000_000))
        }
        XCTAssertEqual(dropped, [start / 1000])
        XCTAssertNil(gate.finish(at: 30_995))
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
        let length = onset + speech.count + 3 * 16_000
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
            segments += detector.consume(frame, endNs: Int64(end) * Segment.sampleNs)
        }
        let commands = segments.filter { $0.startedAtHostMs > 31_000 }
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
        XCTAssertTrue(capture.consume(held, endNs: 1_000_000_000 + Int64(held.count) * Segment.sampleNs).isEmpty)
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
        XCTAssertNil(gate.finish(at: 1000))
        let frame = Array(repeating: Float(0.5), count: 320)
        XCTAssertNil(gate.feed(frame, active: true, endNs: 1020 * 1_000_000))
        XCTAssertEqual(gate.finish(at: 1010)?.samples, Array(frame.prefix(160)))
        XCTAssertNil(gate.feed(Array(repeating: 0.5, count: 30 * 16_000), active: true, endNs: 31_000 * 1_000_000))
        XCTAssertNil(gate.finish(at: 31_000))
    }

    func testKeyUpClassifiesOnlyRecordedSamplesOfTheFinalPartialFrame() throws {
        let tone = (0..<304).map { Float(0.5) * sin(Float($0) * 2 * .pi * 400 / 16_000) }
        let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1))
        func release(_ recorded: [Float], known: Bool) throws -> Segment? {
            let tap = try InputSegmenter(source: format, held: true)
            // The last eight samples arrive in the same tap and fall beyond key-up.
            let pcm = recorded + Array(tone.prefix(8))
            let frame = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(pcm.count)))
            frame.frameLength = frame.frameCapacity
            frame.floatChannelData![0].update(from: pcm, count: pcm.count)
            let when = AVAudioTime(hostTime: AVAudioTime.hostTime(forSeconds: 1))
            XCTAssertTrue(tap.consume(frame, at: when, cutoff: known ? 1019 : nil).isEmpty)
            return tap.finish(at: 1019)
        }
        for known in [true, false] {
            let phrase = try XCTUnwrap(release(tone, known: known))
            XCTAssertEqual(phrase.samples, tone)
            XCTAssertEqual(phrase.startNs, 1_000_000_000)
            XCTAssertEqual(phrase.endedAt, 1019)
            XCTAssertNil(try release(Array(repeating: 0, count: 304), known: known))
        }
    }

    func testFractionalMillisecondStartClipsOnlyCompleteSamplesBeforeRelease() throws {
        // 0.49 ms into a millisecond leaves room for eight complete 16 kHz samples.
        var gate = SpeechGate()
        let frame = (0..<320).map(Float.init)
        let startNs: Int64 = 1_000_490_000
        XCTAssertNil(gate.feed(frame, active: true, endNs: startNs + Int64(frame.count) * Segment.sampleNs))
        let clipped = try XCTUnwrap(gate.finish(at: 1001))
        XCTAssertEqual(clipped.samples, Array(frame.prefix(8)))
        XCTAssertEqual(clipped.startNs, startNs)
        XCTAssertEqual(clipped.startedAtHostMs, 1000)
        XCTAssertEqual(clipped.endedAt, 1001)
    }

    func testKeyUpInsideQuietLeadInCannotDeliverPostReleaseSpeech() throws {
        let quiet = Array(repeating: Float(0), count: 2400)
        let voiced = Array(repeating: Float(0), count: 80) + Array(repeating: Float(0.1), count: 240)
        var gate = SpeechGate(held: true)
        XCTAssertNil(gate.feed(quiet, active: false, endNs: 150_000_000))
        XCTAssertNil(gate.feed(voiced, active: true, endNs: 170_000_000))
        let full = try XCTUnwrap(gate.finish(at: 170))
        for cutoff: Int64 in [140, 150, 155] {
            XCTAssertTrue(full.through(cutoff) == nil, "release retained only quiet samples")
        }
        XCTAssertEqual(full.through(156)?.samples.count, 2496)
    }

    func testDelayedTapUsesCaptureTimeToKeepTheLastWordAndExcludeAudioAfterKeyUp() async throws {
        let (models, corpus) = try fixtureDirectories()
        let speech = try samples(from: corpus.appending(path: "Steve-0.wav"))
        let lastWordEnd = try XCTUnwrap(speech.lastIndex { abs($0) > 0.004 }) + 1
        let heldLength = (lastWordEnd + 15) / 16 * 16 // key-up on the shared millisecond clock
        let held = Array(speech.prefix(heldLength))
        let input = held + Array(repeating: Float(0.6), count: 1600)
        let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1))
        let tap = try InputSegmenter(source: format)
        for i in stride(from: 0, to: input.count, by: 341) {
            let end = min(i + 341, input.count)
            let frame = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(end - i)))
            frame.frameLength = frame.frameCapacity
            for j in i..<end { frame.floatChannelData![0][j - i] = input[j] }
            let when = i == 0
                ? AVAudioTime(hostTime: AVAudioTime.hostTime(forSeconds: 10), sampleTime: 0, atRate: 16_000)
                : AVAudioTime(sampleTime: AVAudioFramePosition(i), atRate: 16_000)
            XCTAssertTrue(tap.consume(frame, at: when).isEmpty)
        }
        let final = try XCTUnwrap(tap.finish(at: Int64(10_000 + heldLength / 16)))
        XCTAssertEqual(final.samples.suffix(320), held.suffix(320))
        let recognizer = try await Recognizer(directory: models)
        let result = try await recognizer.transcribe(final, boosting: nil)
        XCTAssertEqual(result?.text.lowercased().split(whereSeparator: { !$0.isLetter }), ["steve", "check", "the", "build"])
    }

    func test48kReleaseIsIndependentOfPostReleaseInput() throws {
        let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 2))
        let release: Int64 = 205
        func released(afterKeyUp: Float, held: Bool, cutoffKnown: Bool) throws -> Segment {
            let tap = try InputSegmenter(source: format, held: held)
            let frame = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 960))
            frame.frameLength = frame.frameCapacity
            for start in stride(from: 0, through: 9600, by: 960) {
                for i in 0..<960 {
                    let n = start + i
                    let value = n < 9840 ? 0.3 * sin(Float(n) * 2 * .pi * 400 / 48_000) : afterKeyUp
                    for channel in 0..<2 { frame.floatChannelData![channel][i] = value }
                }
                let when = AVAudioTime(hostTime: AVAudioTime.hostTime(forSeconds: Double(start) / 48_000),
                                       sampleTime: Int64(start), atRate: 48_000)
                XCTAssertTrue(tap.consume(frame, at: when, cutoff: cutoffKnown && start == 9600 ? release : nil).isEmpty)
            }
            return try XCTUnwrap(tap.finish(at: release))
        }
        // An explicit cutoff protects either conversion mode. Held capture also
        // has to protect a boundary reported after the whole callback was read.
        for (held, cutoffKnown) in [(false, true), (true, true), (true, false)] {
            let positive = try released(afterKeyUp: 0.9, held: held, cutoffKnown: cutoffKnown)
            let negative = try released(afterKeyUp: -0.9, held: held, cutoffKnown: cutoffKnown)
            XCTAssertEqual(positive.endedAt, release)
            XCTAssertGreaterThan(positive.samples.count, 1600)
            XCTAssertEqual(positive.samples.count, negative.samples.count)
            XCTAssertTrue(positive.samples.elementsEqual(negative.samples), "Post-release audio affected the resampled command (known cutoff: \(cutoffKnown))")
        }
    }

    func testContiguousSamplePositionsSurviveHostJitter() throws {
        let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1))
        let frame = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 960))
        frame.frameLength = frame.frameCapacity
        for i in 0..<960 { frame.floatChannelData![0][i] = 0.3 * sin(Float(i) * 2 * .pi * 400 / 48_000) }
        let tap = try InputSegmenter(source: format, held: true)
        for i in 0..<12 {
            let jitter = i.isMultiple(of: 2) ? 0.0 : 0.0004
            let when = AVAudioTime(hostTime: AVAudioTime.hostTime(forSeconds: Double(i) * 0.02 + jitter),
                                   sampleTime: Int64(i * 960), atRate: 48_000)
            XCTAssertTrue(tap.consume(frame, at: when).isEmpty)
        }
        let phrase = try XCTUnwrap(tap.finish(at: 230))
        XCTAssertEqual(phrase.startNs, 0)
        XCTAssertEqual(phrase.samples.count, 230 * 16)
    }

    func testKnownCutoffInsideJitteredTapUsesAnchoredSampleTime() throws {
        let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1))
        let frame = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 960))
        frame.frameLength = frame.frameCapacity
        for i in 0..<960 { frame.floatChannelData![0][i] = 0.3 * sin(Float(i) * 2 * .pi * 400 / 48_000) }
        let release: Int64 = 205
        func capture(jitter: Double) throws -> Segment {
            let tap = try InputSegmenter(source: format, held: true)
            for i in 0...10 {
                let host = Double(i) * 0.02 + (i == 10 ? jitter : 0)
                let when = AVAudioTime(hostTime: AVAudioTime.hostTime(forSeconds: host),
                                       sampleTime: Int64(i * 960), atRate: 48_000)
                XCTAssertTrue(tap.consume(frame, at: when,
                                          cutoff: i == 10 ? release : nil).isEmpty)
            }
            XCTAssertEqual(tap.deliveredThrough, release)
            return try XCTUnwrap(tap.finish(at: release))
        }
        let expected = try capture(jitter: 0)
        XCTAssertEqual(expected.endedAt, release)
        for jitter in [0.0004, -0.0004] {
            let actual = try capture(jitter: jitter)
            XCTAssertEqual(actual.samples.count, expected.samples.count)
            XCTAssertTrue(actual.samples.elementsEqual(expected.samples))
        }
    }

    func testSampleClockResetWaitsForANewPairedAnchor() throws {
        let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1))
        let tap = try InputSegmenter(source: format, held: true, endOfSpeechMs: 800)
        func feed(_ time: AVAudioTime, frames: Int = 320, tone: Bool = false) throws {
            let frame = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)))
            frame.frameLength = frame.frameCapacity
            for i in 0..<frames { frame.floatChannelData![0][i] = tone ? 0.3 * sin(Float(i) * 2 * .pi * 400 / 16_000) : 0 }
            XCTAssertTrue(tap.consume(frame, at: time).isEmpty)
        }
        try feed(AVAudioTime(hostTime: AVAudioTime.hostTime(forSeconds: 10), sampleTime: 32_000, atRate: 16_000), tone: true)
        for position: Int64 in [0, 320] {
            try feed(AVAudioTime(sampleTime: position, atRate: 16_000), tone: true)
            XCTAssertNil(tap.deliveredThrough, "A reset counter alone cannot date audio")
        }
        // The first paired callback on the new timeline supplies the silence boundary.
        try feed(AVAudioTime(hostTime: AVAudioTime.hostTime(forSeconds: 20), sampleTime: 640, atRate: 16_000), frames: 16_000)
        try feed(AVAudioTime(sampleTime: 16_640, atRate: 16_000), frames: 3200, tone: true)
        XCTAssertEqual(tap.deliveredThrough, 21_200)
        let final = try XCTUnwrap(tap.finish(at: 21_150))
        XCTAssertEqual(final.endedAt, 21_150)
    }

    func testTapGapDiscardsInterruptedSpeechThroughSilenceAndKeepsTheNextCommand() throws {
        let (_, corpus) = try fixtureDirectories()
        let speech = try samples(from: corpus.appending(path: "Steve-0.wav"))
        let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1))
        for hostOnly in [true, false] {
            let input = try InputSegmenter(source: format, endOfSpeechMs: 800)
            func callback(_ pcm: [Float], start: Int) throws -> [Segment] {
                let frame = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(pcm.count)))
                frame.frameLength = frame.frameCapacity
                frame.floatChannelData![0].update(from: pcm, count: pcm.count)
                let host = AVAudioTime.hostTime(forSeconds: Double(start) / 16_000)
                let time = hostOnly ? AVAudioTime(hostTime: host) :
                    AVAudioTime(hostTime: host, sampleTime: Int64(start), atRate: 16_000)
                return input.consume(frame, at: time)
            }
            let split = speech.count / 2
            XCTAssertTrue(try callback(Array(speech.prefix(split)), start: 0).isEmpty)
            let gap = 1600
            let end = speech.count + gap
            XCTAssertTrue(try callback(Array(speech.dropFirst(split)), start: split + gap).isEmpty)
            // Key-up inside the gap cannot flush a command stitched from both sides.
            XCTAssertNil(input.finish(at: Int64((split + gap / 2) / 16)))

            // Repeat without releasing, and let ordinary segmentation resume after silence.
            XCTAssertTrue(try callback(Array(speech.prefix(split)), start: end).isEmpty)
            XCTAssertTrue(try callback(Array(speech.dropFirst(split)), start: end + split + gap).isEmpty)
            let silence = Array(repeating: Float(0), count: 16_000)
            XCTAssertTrue(try callback(silence, start: 2 * end).isEmpty)
            let freshStart = 2 * end + silence.count
            let fresh = try callback(speech + silence, start: freshStart)
            XCTAssertEqual(fresh.count, 1)
            let captured = try XCTUnwrap(fresh.first)
            XCTAssertGreaterThanOrEqual(captured.startedAtHostMs, Int64(freshStart / 16) - 150)

            // After a complete phrase and quiet boundary, a gap has no phrase to discard.
            let afterIdleGap = freshStart + speech.count + silence.count + gap
            let next = try callback(speech + silence, start: afterIdleGap)
            XCTAssertEqual(next.count, 1)
            XCTAssertGreaterThanOrEqual(try XCTUnwrap(next.first).startNs, Int64(afterIdleGap) * Segment.sampleNs)
        }
    }

    func testDelayedKeyUpRecoversOnlySpeechCoveredBeforeTheTapGap() throws {
        let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1))
        func record(release: Int64, resumeAt: Int = 1600, timestamped: Bool = true) throws -> Segment? {
            let input = try InputSegmenter(source: format, held: true)
            func callback(from start: Int, count: Int, dated: Bool) throws {
                let frame = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count)))
                frame.frameLength = frame.frameCapacity
                for i in 0..<count { frame.floatChannelData![0][i] = start == 0 ? 0.2 * sin(Float(i) * .pi / 20) : -0.6 }
                let time = dated ? AVAudioTime(hostTime: AVAudioTime.hostTime(forSeconds: Double(start) / 16_000),
                                              sampleTime: Int64(start), atRate: 16_000) :
                    AVAudioTime(sampleTime: Int64(start), atRate: 16_000)
                XCTAssertTrue(input.consume(frame, at: time).isEmpty)
            }
            try callback(from: 0, count: 1536, dated: true) // Speech through 96 ms, including a partial VAD frame.
            try callback(from: resumeAt, count: 320, dated: timestamped)
            if !timestamped { XCTAssertTrue(input.covers(release), "A later undated tap must not block closing the input at key-up") }
            return input.finish(at: release)
        }
        for release in [Int64(90), 96] {
            let phrase = try XCTUnwrap(record(release: release))
            XCTAssertEqual(phrase.endedAt, release)
            XCTAssertEqual(phrase.samples.count, Int(release * 16))
            XCTAssertFalse(phrase.samples.contains(-0.6))
        }
        XCTAssertNotNil(try record(release: 95, timestamped: false))
        XCTAssertNil(try record(release: 98)) // In the missing interval.
        XCTAssertNil(try record(release: 110)) // Would join speech across the gap.
        XCTAssertNil(try record(release: 90, resumeAt: 48_000)) // Recovery period elapsed.
    }

    private func captureFourPhrases(held: Bool, speech: [Float]? = nil,
                                    onSpeechStart: @escaping (Int64) -> Void = { _ in },
                                    onSegmentDropped: @escaping (Int64) -> Void = { _ in },
                                    onQueueFull: @escaping () -> Void) throws -> (Microphone, Int) {
        let speech = try speech ?? samples(from: fixtureDirectories().corpus.appending(path: "Steve-0.wav"))
        let pcm = speech + Array(repeating: Float(0), count: 16_000)
        let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1))
        let engine = TapFixtureEngine()
        try engine.enableManualRenderingMode(.offline, format: format, maximumFrameCount: 1024)
        XCTAssertTrue(engine.inputNode.setManualRenderingInputPCMFormat(format) { _ in nil })
        engine.connect(engine.inputNode, to: engine.mainMixerNode, format: format)
        let input = try Microphone(selection: "system-default", held: held, endOfSpeechMs: 800, devices: [], engine: engine,
                                   onSpeechStart: onSpeechStart, onSegmentDropped: onSegmentDropped, onQueueFull: onQueueFull)
        let frame = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(pcm.count)))
        frame.frameLength = frame.frameCapacity
        frame.floatChannelData![0].update(from: pcm, count: pcm.count)
        for i in 0..<4 {
            let when = AVAudioTime(hostTime: AVAudioTime.hostTime(forSeconds: Double(i * pcm.count) / 16_000))
            input.consume(frame, at: when)
        }
        return (input, pcm.count)
    }

    func testHeldMicrophoneKeepsFourPhrasesInOrderUntilRelease() throws {
        let (input, length) = try captureFourPhrases(held: true) { XCTFail("The normal listening queue overflowed") }
        let held = input.stop(releasedAt: Int64((4 * length + 15) / 16))
        XCTAssertEqual(held.count, 4)
        for (i, phrase) in held.enumerated() {
            XCTAssertEqual(Double(phrase.startedAtHostMs), Double(i * length) / 16, accuracy: 200)
        }
    }

    @MainActor func testStalledReleaseClosesCaptureAndDeliversOnlyCompletedPhrases() async throws {
        let (input, length) = try captureFourPhrases(held: true) { XCTFail("Unexpected queue overflow") }
        let (_, corpus) = try fixtureDirectories()
        let speech = try samples(from: corpus.appending(path: "Steve-0.wav"))
        let start = 4 * length
        let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1))
        let frame = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(speech.count / 2)))
        frame.frameLength = frame.frameCapacity
        frame.floatChannelData![0].update(from: speech, count: Int(frame.frameLength))
        input.consume(frame, at: AVAudioTime(hostTime: AVAudioTime.hostTime(forSeconds: Double(start) / 16_000)))
        let release = Int64((start + Int(frame.frameLength)) / 16 + 100)
        let closed = expectation(description: "stalled input closed at timeout")
        var phrases: [Segment] = []
        input.whenCaptured(through: release) {
            phrases = input.stop(releasedAt: release)
            closed.fulfill()
        }
        await fulfillment(of: [closed], timeout: 2)
        XCTAssertFalse(input.isRunning)
        XCTAssertEqual(phrases.count, 4)
        XCTAssertTrue(phrases.allSatisfy { $0.endedAt <= Int64((start + 15) / 16) })
    }

    func testOpenMicrophoneReportsEachOverlongSegmentAsDropped() async throws {
        var onsets: [Int64] = []
        var dropped: [Int64] = []
        let tone = (0..<(31 * 16_000)).map { 0.2 * sin(Float($0) * .pi / 20) }
        let (input, _) = try captureFourPhrases(held: false, speech: tone, onSpeechStart: { onsets.append($0) },
                                              onSegmentDropped: { dropped.append($0) }) { XCTFail("Overlong segments reached the decoder queue") }
        XCTAssertEqual(onsets.count, 4)
        XCTAssertFalse(dropped.isEmpty, "Overlong speech must be released while capture is open")
        input.stop()
        // The adaptive detector can end a tone early. Only segments it actually
        // yields to the decoder may keep their reservations.
        var queued: [Int64] = []
        for await segment in input.segments { queued.append(segment.speechStartHostUs) }
        XCTAssertEqual(dropped, onsets.filter { !queued.contains($0) })
    }

    func testBackloggedMicrophoneKeepsOldestPhrasesAndReportsDrops() async throws {
        var warnings = 0
        var onsets: [Int64] = []
        var dropped: [Int64] = []
        let tone = (0..<4800).map { 0.2 * sin(Float($0) * .pi / 20) }
        let (input, length) = try captureFourPhrases(held: false, speech: tone, onSpeechStart: { onsets.append($0) },
                                                     onSegmentDropped: { dropped.append($0) }) { warnings += 1 }
        input.stop()
        var starts: [Int64] = []
        var queued: [Int64] = []
        for await segment in input.segments {
            starts.append(segment.startedAtHostMs)
            queued.append(segment.speechStartHostUs)
        }
        XCTAssertEqual(onsets.count, 4)
        XCTAssertEqual(queued, Array(onsets.prefix(2)))
        XCTAssertEqual(dropped, Array(onsets.suffix(2)))
        XCTAssertEqual(warnings, 1)
        XCTAssertEqual(starts.count, 2)
        for (i, start) in starts.enumerated() {
            XCTAssertEqual(Double(start), Double(i * length) / 16, accuracy: 200)
        }
    }

    func testHeldAudioOverflowDiscardsTheWholeHoldIncludingLaterSpeech() {
        let pcm = Array(repeating: Float(0.5), count: 32)
        var hold = HeldSpeech(limit: 48)
        for i in 0..<4 { hold.append(Segment(samples: pcm, startNs: Int64(i) * 2_000_000, capturedAt: 1000 + Int64(i) * 2, firstVoicedSample: 0)) }
        XCTAssertEqual(hold.finish(at: 2)?.map { $0.samples.count }, [32])
        XCTAssertEqual(hold.finish(at: 3)?.map { $0.samples.count }, [32, 16])
        XCTAssertEqual(hold.finish(at: 3)?.map(\.capturedAt), [1000, 1002])
        XCTAssertNil(hold.finish(at: 4))
        XCTAssertNil(hold.finish(at: 8))
    }

    @MainActor func testKeyUpBeforeFinalTapCallbackCollectsTheLastWord() async throws {
        let (models, corpus) = try fixtureDirectories()
        let speech = try samples(from: corpus.appending(path: "Steve-0.wav"))
        let last = try XCTUnwrap(speech.lastIndex { abs($0) > 0.004 }) + 1
        let held = Array(speech.prefix((last + 15) / 16 * 16))
        let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1))
        let engine = TapFixtureEngine()
        try engine.enableManualRenderingMode(.offline, format: format, maximumFrameCount: 1024)
        XCTAssertTrue(engine.inputNode.setManualRenderingInputPCMFormat(format) { _ in nil })
        engine.connect(engine.inputNode, to: engine.mainMixerNode, format: format)
        XCTAssertEqual(engine.inputNode.outputFormat(forBus: 0), format)
        let input = try Microphone(selection: "system-default", devices: [], engine: engine)
        func callback(_ pcm: [Float], start: Int) throws {
            let frame = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(pcm.count)))
            frame.frameLength = frame.frameCapacity
            for i in pcm.indices { frame.floatChannelData![0][i] = pcm[i] }
            let time = AVAudioTime(hostTime: AVAudioTime.hostTime(forSeconds: Double(start) / 16_000))
            input.consume(frame, at: time)
        }
        let split = held.count - 1600
        try callback(Array(held[..<split]), start: 0)
        let release = Int64(held.count / 16)
        var final: Segment?
        let closed = expectation(description: "the callback through key-up releases the input")
        input.whenCaptured(through: release) {
            final = input.stop(releasedAt: release).first
            closed.fulfill()
        }
        XCTAssertTrue(input.isRunning)
        try callback(Array(held[split...]) + Array(repeating: 0.7, count: 1600), start: split)
        await fulfillment(of: [closed], timeout: 1)
        XCTAssertFalse(input.isRunning)
        let command = try XCTUnwrap(final)
        XCTAssertEqual(command.samples.suffix(1600), held.suffix(1600))
        let recognizer = try await Recognizer(directory: models)
        let result = try await recognizer.transcribe(command, boosting: nil)
        XCTAssertEqual(result?.text.lowercased().split(whereSeparator: { !$0.isLetter }), ["steve", "check", "the", "build"])
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
        let segment = Segment(samples: try samples(from: corpus.appending(path: "Steve-0.wav")), startNs: 1_000_000_000, capturedAt: 1000, firstVoicedSample: 0)
        let utterance = try await recognizer.transcribe(segment, boosting: boosting)
        let result = try XCTUnwrap(utterance)
        XCTAssertEqual(result.text.lowercased().split(whereSeparator: { !$0.isLetter }), ["steve", "check", "the", "build"])
        XCTAssertFalse(result.words.isEmpty)
    }

    func testClockStepAfterSpeechOnsetPreservesCaptureTimeThroughDecoding() async throws {
        let (models, corpus) = try fixtureDirectories()
        let pcm = try samples(from: corpus.appending(path: "Steve-0.wav"))
        let onset: Int64 = 1_000_000_000
        var unixAtHostZero: Int64 = 1_700_000_000_000
        func toUnixMs(_ ns: Int64) -> Int64 { unixAtHostZero + ns / 1_000_000 }
        var gate = SpeechGate(held: true)
        let end = onset + Int64(pcm.count) * Segment.sampleNs
        XCTAssertNil(gate.feed(pcm, active: true, endNs: end, toUnixMs: toUnixMs))
        unixAtHostZero += 60_000
        let silence = Array(repeating: Float(0), count: 32_000)
        let segment = try XCTUnwrap(gate.feed(silence, active: false, endNs: end + 2_000_000_000, toUnixMs: toUnixMs))
        let clipped = try XCTUnwrap(segment.through((end + 999_999) / 1_000_000))
        let recognizer = try await Recognizer(directory: models)
        let words = try await recognizer.transcribe(clipped, boosting: nil)
        XCTAssertEqual(words?.capturedAt, 1_700_000_001_000)
        XCTAssertEqual(clipped.endedAt, (end + 999_999) / 1_000_000)
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
                samples += Array(repeating: 0, count: 36_000)
                let detector = try SpeechSegmenter()
                let segments = detector.consume(samples, endNs: 1_000_000_000 + Int64(samples.count) * Segment.sampleNs)
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
