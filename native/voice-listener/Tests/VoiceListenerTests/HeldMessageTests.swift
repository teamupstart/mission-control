import AVFoundation
import XCTest
@testable import VoiceListener

/// One push-to-talk hold is one message. A pause inside the hold ends a recognition phrase only.
final class HeldMessageTests: XCTestCase {
    private let format = AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1)!

    private func speech() throws -> [Float] {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appending(path: "../../../..")
        let file = try AVAudioFile(forReading: root.appending(path: "test/fixtures/voice/steve-check-the-build.wav"))
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)))
        try file.read(into: buffer)
        return Array(UnsafeBufferPointer(start: buffer.floatChannelData![0], count: Int(buffer.frameLength)))
    }

    private func microphone(held: Bool, onSpeechStart: @escaping (Int64) -> Void,
                            onSegmentDropped: @escaping SegmentDropped = { _, _ in }) throws -> Microphone {
        let engine = TapFixtureEngine()
        try engine.enableManualRenderingMode(.offline, format: format, maximumFrameCount: 1024)
        XCTAssertTrue(engine.inputNode.setManualRenderingInputPCMFormat(format) { _ in nil })
        engine.connect(engine.inputNode, to: engine.mainMixerNode, format: format)
        return try Microphone(selection: "system-default", held: held, endOfSpeechMs: 800, devices: [], engine: engine,
                              onSpeechStart: onSpeechStart, onSegmentDropped: onSegmentDropped, onQueueFull: {})
    }

    /// Feeds PCM in tap-sized callbacks whose sample positions start at `sample`.
    private func feed(_ mic: Microphone, _ pcm: [Float], at sample: Int) throws {
        for offset in stride(from: 0, to: pcm.count, by: 1024) {
            let count = min(1024, pcm.count - offset)
            let frame = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count)))
            frame.frameLength = frame.frameCapacity
            pcm.withUnsafeBufferPointer { frame.floatChannelData![0].update(from: $0.baseAddress! + offset, count: count) }
            let position = sample + offset
            mic.consume(frame, at: AVAudioTime(hostTime: AVAudioTime.hostTime(forSeconds: Double(position) / 16_000),
                                               sampleTime: Int64(position), atRate: 16_000))
        }
    }

    func testHeldSpeechNamesTheHoldByItsFirstOnsetAndDiscardsAHoldThatLostSpeech() {
        let pcm = Array(repeating: Float(0.5), count: 32)
        var hold = HeldSpeech()
        XCTAssertTrue(hold.begin(10))
        XCTAssertFalse(hold.begin(20), "A later phrase of the same hold is not a new message")
        XCTAssertEqual(hold.onset, 10)
        for i in 0..<2 { hold.append(Segment(samples: pcm, startNs: Int64(i) * 4_000_000, capturedAt: 1000, firstVoicedSample: 0)) }
        XCTAssertEqual(hold.finish(at: 100)?.count, 2)
        XCTAssertEqual(hold.drop(), 10, "The first loss settles the hold's one reservation")
        XCTAssertNil(hold.drop(), "Later losses report nothing more")
        XCTAssertNil(hold.finish(at: 100), "A hold missing speech is never delivered in part")
    }

    func testHeldMessageJoinsPhrasesInSpokenOrderWithTimingsFromTheFirstPhrase() throws {
        func phrase(at seconds: Int64, samples: Int) -> Segment {
            Segment(samples: Array(repeating: 0, count: samples), startNs: seconds * 1_000_000_000, capturedAt: 50_000 + seconds * 1000,
                    firstVoicedSample: 2400)
        }
        let first = phrase(at: 1, samples: 32_000), cough = phrase(at: 3, samples: 8000), second = phrase(at: 5, samples: 24_000)
        let before = Utterance(text: "Steve, check the build.", words: [
            TimedWord(text: "Steve,", startMs: 150, endMs: 400), TimedWord(text: "build.", startMs: 1100, endMs: 1400),
        ], capturedAt: first.capturedAt)
        let after = Utterance(text: "Then, bagel, run the tests.", words: [
            TimedWord(text: "Then,", startMs: 150, endMs: 350), TimedWord(text: "tests.", startMs: 1200, endMs: 1500),
        ], capturedAt: second.capturedAt)
        let message = try XCTUnwrap(Utterance.message([(first, before), (cough, nil), (second, after)]))
        XCTAssertEqual(message.text, "Steve, check the build. Then, bagel, run the tests.")
        XCTAssertEqual(message.capturedAt, first.capturedAt)
        XCTAssertEqual(message.words.map(\.text), ["Steve,", "build.", "Then,", "tests."])
        XCTAssertEqual(message.words.map(\.startMs), [150, 1100, 4150, 5200])
        XCTAssertEqual(message.words.map(\.endMs), [400, 1400, 4350, 5500])
        XCTAssertNil(Utterance.message([(first, nil), (cough, nil)]), "A hold that decoded to nothing sends nothing")
        XCTAssertNil(Utterance.message([]))
    }

    @MainActor func testHeldPreviewDecodesEachCompletedPhraseOnceAndKeepsItsWords() async throws {
        // Phrases start at 0, 1 and 2 seconds; the open phrase grows from one sample to two.
        let words: [String: String] = ["0:1": "Steve, check the build.", "1:1": "Then", "1:2": "Then, bagel, run the tests.", "2:1": ""]
        func phrase(_ second: Int64, _ count: Int = 1) -> Segment {
            Segment(samples: Array(repeating: 0.1, count: count), startNs: second * 1_000_000_000, capturedAt: 0, firstVoicedSample: 0)
        }
        var decoded: [String] = []
        let decode: (Segment) async throws -> String? = { segment in
            let key = "\(segment.startNs / 1_000_000_000):\(segment.samples.count)"
            decoded.append(key)
            return words[key]
        }
        let preview = HeldPreviewText()
        // Speaking again after a pause: the earlier phrase stays in front of the open one.
        var text = try await preview.text(HeldPreview(onset: 5, completed: [phrase(0)], open: phrase(1)), decode: decode)
        XCTAssertEqual(text, "Steve, check the build. Then")
        text = try await preview.text(HeldPreview(onset: 5, completed: [phrase(0)], open: phrase(1, 2)), decode: decode)
        XCTAssertEqual(text, "Steve, check the build. Then, bagel, run the tests.")
        // Quiet: every phrase is complete, and the first is still not decoded again.
        text = try await preview.text(HeldPreview(onset: 5, completed: [phrase(0), phrase(1, 2), phrase(2)], open: nil), decode: decode)
        XCTAssertEqual(text, "Steve, check the build. Then, bagel, run the tests.")
        XCTAssertEqual(decoded, ["0:1", "1:1", "1:2", "1:2", "2:1"])
    }

    func testHeldMicrophoneReportsOneOnsetAndReleasesEveryPhraseOfTheHold() throws {
        let speech = try speech()
        let quiet = Array(repeating: Float(0), count: 16_000) // Longer than the 800 ms phrase boundary.
        var onsets: [Int64] = []
        let mic = try microphone(held: true, onSpeechStart: { onsets.append($0) })
        try feed(mic, speech + quiet + speech + quiet, at: 0)
        let paused = try XCTUnwrap(mic.heldPreview)
        XCTAssertEqual(paused.completed.count, 2)
        XCTAssertNil(paused.open)
        // Speaking again, with the key still down mid-phrase.
        let open = Array(speech.prefix(speech.count / 2))
        try feed(mic, open, at: 2 * (speech.count + quiet.count))
        let speaking = try XCTUnwrap(mic.heldPreview)
        XCTAssertEqual(speaking.completed.count, 2)
        XCTAssertNotNil(speaking.open, "The phrase after the pause previews with the ones before it")
        XCTAssertEqual(onsets.count, 1, "Pauses inside a hold start no new message")
        XCTAssertEqual(speaking.onset, onsets.first)

        let release = Int64((2 * (speech.count + quiet.count) + open.count) / 16)
        let phrases = mic.stop(releasedAt: release)
        XCTAssertEqual(phrases.count, 3)
        XCTAssertEqual(phrases.first?.speechStartHostUs, onsets.first, "The message is named by the hold's first onset")
        XCTAssertEqual(phrases.map(\.startNs), phrases.map(\.startNs).sorted())
        XCTAssertLessThanOrEqual(try XCTUnwrap(phrases.last).endedAt, release)
    }

    func testAlwaysOnMicrophoneStillReportsEveryPhrase() throws {
        let speech = try speech()
        let quiet = Array(repeating: Float(0), count: 16_000)
        var onsets: [Int64] = []
        let mic = try microphone(held: false, onSpeechStart: { onsets.append($0) })
        defer { mic.stop() }
        try feed(mic, speech + quiet + speech + quiet, at: 0)
        XCTAssertEqual(onsets.count, 2, "Each automatic utterance keeps its own onset")
        XCTAssertNil(mic.heldPreview)
    }

    /// A valid first phrase, then a second phrase of continuous speech past the one-minute phrase limit.
    private func holdPastThePhraseLimit(seconds: Int, onSpeechStart: @escaping (Int64) -> Void,
                                        onSegmentDropped: @escaping SegmentDropped) throws -> (Microphone, end: Int) {
        let speech = try speech()
        let quiet = Array(repeating: Float(0), count: 16_000)
        // The clip's own voiced span, repeated back to back, never pauses long enough to end the phrase.
        let first = try XCTUnwrap(speech.firstIndex { abs($0) > SpeechGate.activityFloor })
        let last = try XCTUnwrap(speech.lastIndex { abs($0) > SpeechGate.activityFloor })
        let voiced = Array(speech[first...last])
        var long: [Float] = []
        while long.count < seconds * 16_000 { long += voiced }
        let mic = try microphone(held: true, onSpeechStart: onSpeechStart, onSegmentDropped: onSegmentDropped)
        try feed(mic, speech + quiet, at: 0)
        try feed(mic, long, at: speech.count + quiet.count)
        return (mic, speech.count + quiet.count + long.count)
    }

    func testAHeldPhrasePastTheCaptureLimitDiscardsTheWholeHoldAndReportsTheLimitOnce() throws {
        // 64 seconds: the limit is passed and its two-second key-up grace ends while the key is still down.
        var onsets: [Int64] = []
        var dropped: [(Int64, SpeechDrop)] = []
        let (mic, end) = try holdPastThePhraseLimit(seconds: 64, onSpeechStart: { onsets.append($0) },
                                                    onSegmentDropped: { dropped.append(($0, $1)) })
        XCTAssertEqual(onsets.count, 1, "The over-limit phrase belongs to the hold that the first phrase opened")
        XCTAssertEqual(dropped.map(\.0), onsets, "The limit settles the hold's own onset")
        XCTAssertEqual(dropped.map(\.1), [.captureLimit], "and reports the capture limit, once")
        XCTAssertNil(mic.heldPreview, "A hold that lost speech previews nothing more")
        XCTAssertEqual(mic.stop(releasedAt: Int64(end / 16)).count, 0, "Release delivers none of the hold, not even its first phrase")
        XCTAssertEqual(dropped.count, 1)
    }

    func testKeyUpAfterTheCaptureLimitDiscardsTheWholeHoldAndReportsTheLimitOnce() throws {
        // 61 seconds: key-up comes after the first excess sample but inside the grace period, so release decides.
        var onsets: [Int64] = []
        var dropped: [(Int64, SpeechDrop)] = []
        let (mic, end) = try holdPastThePhraseLimit(seconds: 61, onSpeechStart: { onsets.append($0) },
                                                    onSegmentDropped: { dropped.append(($0, $1)) })
        XCTAssertTrue(dropped.isEmpty, "Key-up may still fall inside the limit")
        XCTAssertEqual(mic.stop(releasedAt: Int64(end / 16)).count, 0)
        XCTAssertEqual(onsets.count, 1)
        XCTAssertEqual(dropped.map(\.0), onsets)
        XCTAssertEqual(dropped.map(\.1), [.captureLimit])
    }

    func testSpeechLostToAnInputGapDiscardsTheWholeHoldAndSettlesItsOnsetOnce() throws {
        let speech = try speech()
        let quiet = Array(repeating: Float(0), count: 16_000)
        var onsets: [Int64] = []
        var dropped: [(Int64, SpeechDrop)] = []
        let mic = try microphone(held: true, onSpeechStart: { onsets.append($0) }, onSegmentDropped: { dropped.append(($0, $1)) })
        try feed(mic, speech + quiet, at: 0)
        // The second phrase is interrupted by a jump in the input timeline, and speech continues after it.
        let split = speech.count / 2
        try feed(mic, Array(speech.prefix(split)), at: speech.count + quiet.count)
        let resumed = speech.count + quiet.count + split + 3200
        try feed(mic, Array(speech.dropFirst(split)), at: resumed)
        XCTAssertEqual(onsets.count, 1)
        // Key-up after the gap cannot recover the interrupted speech, so nothing of the hold is delivered.
        let phrases = mic.stop(releasedAt: Int64((resumed + speech.count - split) / 16))
        XCTAssertEqual(phrases.count, 0)
        XCTAssertEqual(dropped.map(\.0), onsets, "The hold's reservation is settled once, under its own onset")
        XCTAssertEqual(dropped.map(\.1), [.interrupted])
    }
}
