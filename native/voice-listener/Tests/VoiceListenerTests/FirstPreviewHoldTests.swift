import AVFoundation
import XCTest
@testable import VoiceListener

/// The first-preview hold: an Always-on utterance shows no live words until it holds enough voiced
/// audio, counted per utterance. Final decoding and delivery never read it.
final class FirstPreviewHoldTests: XCTestCase {
    private let voiced = Array(repeating: Float(0.25), count: 320)
    private let quiet = Array(repeating: Float(0), count: 320)

    func testVoicedAudioIsCountedPerUtteranceAndResetsAtEveryBoundary() throws {
        var gate = SpeechGate(endOfSpeechMs: 100)
        var endNs: Int64 = 1_000_000_000
        func feed(_ frame: [Float], active: Bool) -> Segment? {
            endNs += 20_000_000
            return gate.feed(frame, active: active, endNs: endNs, toUnixMs: { $0 / 1_000_000 })
        }
        // Lead-in quiet never counts, only frames the classifier marked voiced.
        XCTAssertNil(feed(quiet, active: false))
        for _ in 0..<3 { XCTAssertNil(feed(voiced, active: true)) }
        XCTAssertEqual(gate.preview?.voicedSamples, 960)
        // A quiet frame inside the phrase grows the snapshot but not the voiced count.
        XCTAssertNil(feed(quiet, active: false))
        XCTAssertEqual(gate.preview?.samples.count, 320 + 960 + 320)
        XCTAssertEqual(gate.preview?.voicedSamples, 960)
        XCTAssertNil(feed(voiced, active: true))
        XCTAssertEqual(gate.preview?.voicedSamples, 1280)

        // Closing at the end-of-speech boundary ends this utterance's count.
        var completed: Segment?
        for _ in 0..<5 where completed == nil { completed = feed(quiet, active: false) }
        XCTAssertEqual(try XCTUnwrap(completed).voicedSamples, 1280)
        XCTAssertNil(gate.preview)
        XCTAssertNil(feed(voiced, active: true))
        XCTAssertEqual(gate.preview?.voicedSamples, 320, "the next utterance starts its own count")

        // An interruption discards the utterance and its count.
        gate.interrupt()
        for _ in 0..<5 { _ = feed(quiet, active: false) }
        XCTAssertNil(feed(voiced, active: true))
        XCTAssertEqual(gate.preview?.voicedSamples, 320)

        // A live end-of-speech edit that closes the phrase also resets the count.
        var edited = SpeechGate(endOfSpeechMs: 2000)
        for frame in [voiced, voiced, quiet, quiet, quiet] {
            endNs += 20_000_000
            _ = edited.feed(frame, active: frame == voiced, endNs: endNs, toUnixMs: { $0 / 1_000_000 })
        }
        XCTAssertEqual(try XCTUnwrap(edited.updateEndOfSpeechMs(40)).voicedSamples, 640)
        endNs += 20_000_000
        XCTAssertNil(edited.feed(voiced, active: true, endNs: endNs, toUnixMs: { $0 / 1_000_000 }))
        XCTAssertEqual(edited.preview?.voicedSamples, 320)

        // A clipped prefix never claims more voiced audio than it keeps.
        let segment = Segment(samples: voiced + voiced, startNs: 0, capturedAt: 0, firstVoicedSample: 0, voicedSamples: 640)
        XCTAssertEqual(segment.prefix(100).voicedSamples, 100)
    }

    /// Runs the production preview loop over one snapshot per pass and records what it published.
    /// `decoded` replaces a pass's recognized words; returning nil or throwing stands for a decode that found none.
    @MainActor private func publish(_ passes: [Segment], ready: ((Segment) -> Bool)? = nil,
                                    decoded: ((Segment, Int) throws -> String?)? = nil)
        async -> (words: [String], editor: [String], audio: Int, focusChecks: Int) {
        var tick = 0
        var settled = 0
        var words: [String] = []
        var editor: [String] = []
        var audio = 0
        var focusChecks = 0
        let snapshot = { tick < passes.count ? passes[tick] : nil }
        let decide: (Segment) -> Bool = { phrase in
            let shown = ready?(phrase) ?? true
            if !shown { settled += 1 }
            return shown
        }
        let decode: (Segment) async throws -> String? = { segment in
            do {
                let words: String? = try decoded.map { try $0(segment, tick) } ?? "\(segment.onset):\(segment.voicedSamples)"
                // A pass that publishes no words is settled here rather than by a words report.
                if words?.isEmpty != false { settled += 1 }
                return words
            } catch {
                settled += 1
                throw error
            }
        }
        let report: (String, Int64?, String?) async -> Bool = { phase, _, text in
            if phase == "audio" { audio += 1 }
            if phase == "words", let text { words.append(text); settled += 1 }
            return true
        }
        let focused: (Int64) async -> Bool = { _ in focusChecks += 1; return true }
        let update: (Int64, String) async throws -> Void = { _, text in editor.append(text) }
        if let ready {
            await runTranscriptPreview(isRunning: { tick < passes.count }, snapshot: snapshot, pendingOnset: { nil },
                decode: decode, report: report, editorFocused: focused, updateEditor: update,
                firstPreviewReady: decide, pause: {
                    while settled <= tick { await Task.yield() }
                    tick += 1
                })
        } else {
            // The flag-off call: exactly the arguments the loop took before the hold existed.
            await runTranscriptPreview(isRunning: { tick < passes.count }, snapshot: snapshot, pendingOnset: { nil },
                decode: decode, report: report, editorFocused: focused, updateEditor: update, pause: {
                    while settled <= tick { await Task.yield() }
                    tick += 1
                })
        }
        return (words, editor, audio, focusChecks)
    }

    private func phrase(onset: Int64, voicedMs: Int) -> Segment {
        Segment(samples: Array(repeating: 0.25, count: max(voicedMs, 1) * 16), startNs: onset * 1000, capturedAt: 0,
                firstVoicedSample: 0, voicedSamples: voicedMs * 16)
    }

    @MainActor func testHoldWithholdsEachUtterancesFirstWordsUntilItHoldsEnoughVoicedAudio() async {
        let passes = [phrase(onset: 1, voicedMs: 100), phrase(onset: 1, voicedMs: 200), phrase(onset: 1, voicedMs: 300),
                      phrase(onset: 1, voicedMs: 400), phrase(onset: 2, voicedMs: 20), phrase(onset: 2, voicedMs: 300)]
        let held = await publish(passes, ready: { $0.voicedSamples >= 300 * 16 })
        // Each utterance's first words wait for 300 ms of voiced audio; the second starts again from zero.
        XCTAssertEqual(held.words, ["1:4800", "1:6400", "2:4800"])
        XCTAssertEqual(held.editor, held.words, "a focused editor is held exactly like the overlay")
        // The capture heartbeat and the dictation focus check run on every pass, held or not.
        XCTAssertEqual(held.audio, passes.count)
        XCTAssertEqual(held.focusChecks, passes.count)

        // Flag off: every pass publishes, exactly as before the hold existed.
        let unheld = await publish(passes)
        XCTAssertEqual(unheld.words, ["1:1600", "1:3200", "1:4800", "1:6400", "2:320", "2:4800"])
        XCTAssertEqual(unheld.editor, unheld.words)
        XCTAssertEqual(unheld.audio, passes.count)
        XCTAssertEqual(unheld.focusChecks, passes.count)
    }

    @MainActor func testAnUtteranceThatHasShownWordsKeepsShowingThemWhenTheHoldTurnsOn() async {
        // The hold is off for the first pass and on afterwards: words already shown stay live.
        var on = false
        let passes = [phrase(onset: 1, voicedMs: 100), phrase(onset: 1, voicedMs: 120), phrase(onset: 2, voicedMs: 100)]
        let result = await publish(passes, ready: { phrase in
            defer { on = true }
            return !on || phrase.voicedSamples >= 300 * 16
        })
        XCTAssertEqual(result.words, ["1:1600", "1:1920"], "a new utterance is held again from its own start")
    }

    @MainActor func testAFirstDecodeThatShowedNothingLeavesTheUtteranceHeldWhenTheHoldTurnsOn() async {
        // The hold is off for the first pass, whose decode finds no words or fails; it is on from the next pass.
        // Nothing was shown, so the same utterance must still wait for 300 ms of voiced audio.
        let passes = [phrase(onset: 1, voicedMs: 100), phrase(onset: 1, voicedMs: 120), phrase(onset: 1, voicedMs: 200),
                      phrase(onset: 1, voicedMs: 300)]
        for failure in ["no words", "a decode error"] {
            var on = false
            let result = await publish(passes, ready: { phrase in
                defer { on = true }
                return !on || phrase.voicedSamples >= 300 * 16
            }, decoded: { segment, pass in
                guard pass == 0 else { return "\(segment.onset):\(segment.voicedSamples)" }
                if failure == "no words" { return nil }
                throw URLError(.cannotDecodeContentData)
            })
            XCTAssertEqual(result.words, ["1:4800"], "after \(failure), no words reach the overlay before 300 ms")
            XCTAssertEqual(result.editor, ["1:4800"], "after \(failure), no words reach a focused editor before 300 ms")
            XCTAssertEqual(result.audio, passes.count)
        }
    }

    @MainActor func testWordsThatReachedNoSurfaceLeaveTheUtteranceHeldWhenTheHoldTurnsOn() async {
        // The overlay is not accepting words and the focused editor's first update fails, with the hold off.
        // Nothing appeared anywhere, so once the hold turns on the same utterance still waits for 300 ms.
        let passes = [phrase(onset: 1, voicedMs: 100), phrase(onset: 1, voicedMs: 120), phrase(onset: 1, voicedMs: 300)]
        var tick = 0
        var settled = 0
        var on = false
        var editor: [String] = []
        var spoken: [String] = []
        await runTranscriptPreview(isRunning: { tick < passes.count }, snapshot: { tick < passes.count ? passes[tick] : nil },
            pendingOnset: { nil }, decode: { "\($0.onset):\($0.voicedSamples)" },
            report: { phase, _, text in
                if phase == "words", let text { spoken.append(text) }
                return false
            }, editorFocused: { _ in true },
            updateEditor: { _, text in
                defer { settled += 1 }
                if tick == 0 { throw URLError(.cannotConnectToHost) }
                editor.append(text)
            }, firstPreviewReady: { phrase in
                defer { on = true }
                let ready = !on || phrase.voicedSamples >= 300 * 16
                if !ready { settled += 1 }
                return ready
            }, pause: {
                while settled <= tick { await Task.yield() }
                tick += 1
            })
        XCTAssertEqual(editor, ["1:4800"], "no words reach the editor before 300 ms after a failed first update")
        XCTAssertEqual(spoken, [], "an overlay that accepts no words is never sent any")
    }

    @MainActor func testAWordsReportTheOverlayRejectsLeavesTheUtteranceHeldWhenTheHoldTurnsOn() async {
        // The overlay accepts the audio heartbeat but rejects the first words report, and no editor is focused,
        // with the hold off. The rejected words were not shown, so once the hold turns on the same utterance waits
        // for 300 ms of voiced audio, and its words are shown once it has them.
        let passes = [phrase(onset: 1, voicedMs: 100), phrase(onset: 1, voicedMs: 120), phrase(onset: 1, voicedMs: 300)]
        var tick = 0
        var settled = 0
        var on = false
        var attempted: [String] = []
        var accepted: [String] = []
        var focusChecks = 0
        await runTranscriptPreview(isRunning: { tick < passes.count }, snapshot: { tick < passes.count ? passes[tick] : nil },
            pendingOnset: { nil }, decode: { "\($0.onset):\($0.voicedSamples)" },
            report: { phase, _, text in
                guard phase == "words", let text else { return true }
                defer { settled += 1 }
                attempted.append(text)
                guard attempted.count > 1 else { return false }
                accepted.append(text)
                return true
            }, editorFocused: { _ in focusChecks += 1; return false },
            updateEditor: { _, _ in XCTFail("no editor is focused") },
            firstPreviewReady: { phrase in
                defer { on = true }
                let ready = !on || phrase.voicedSamples >= 300 * 16
                if !ready { settled += 1 }
                return ready
            }, pause: {
                while settled <= tick { await Task.yield() }
                tick += 1
            })
        XCTAssertEqual(attempted, ["1:1600", "1:4800"], "no words are offered to the overlay below 300 ms after the rejection")
        XCTAssertEqual(accepted, ["1:4800"], "the words are shown at 300 ms")
        XCTAssertEqual(focusChecks, passes.count)
    }

    @MainActor func testCaptureHoldFollowsLiveDirectiveEditsWithoutReopeningTheMicrophone() throws {
        let token = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try Data("test".utf8).write(to: token)
        defer { try? FileManager.default.removeItem(at: token) }
        let daemon = Daemon(environment: ["MISSION_VOICE_DAEMON_URL": "http://127.0.0.1",
                                          "MISSION_VOICE_TOKEN_FILE": token.path, "MISSION_VOICE_MODEL_DIR": token.deletingLastPathComponent().path])
        let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1))
        let engine = TapFixtureEngine()
        try engine.enableManualRenderingMode(.offline, format: format, maximumFrameCount: 1024)
        XCTAssertTrue(engine.inputNode.setManualRenderingInputPCMFormat(format) { _ in nil })
        engine.connect(engine.inputNode, to: engine.mainMixerNode, format: format)
        let mic = try Microphone(selection: "system-default", endOfSpeechMs: 500, devices: [], engine: engine)
        defer { mic.stop() }
        let capture = Capture("capture-1", daemon: daemon)
        capture.mic = mic

        XCTAssertTrue(capture.firstPreviewReady(phrase(onset: 1, voicedMs: 0)), "no hold: every preview is ready")
        XCTAssertTrue(capture.applyLiveEdit(captureRevision: "capture-1", held: false, endOfSpeechMs: 2000, separator: "bagel",
                                            firstPreviewVoicedMs: 300))
        XCTAssertTrue(mic.isRunning)
        XCTAssertFalse(capture.firstPreviewReady(phrase(onset: 1, voicedMs: 299)))
        XCTAssertTrue(capture.firstPreviewReady(phrase(onset: 1, voicedMs: 300)))
        XCTAssertEqual(capture.separator, "bagel", "the separator still follows the same edit")
        XCTAssertTrue(capture.applyLiveEdit(captureRevision: "capture-1", held: false, endOfSpeechMs: 2000, separator: "bagel",
                                            firstPreviewVoicedMs: nil))
        XCTAssertTrue(capture.firstPreviewReady(phrase(onset: 1, voicedMs: 0)), "turning the preview off releases the hold")
        XCTAssertFalse(capture.applyLiveEdit(captureRevision: "capture-1", held: true, endOfSpeechMs: 800, separator: nil,
                                             firstPreviewVoicedMs: 300), "a held capture is never given the hold")
        XCTAssertTrue(capture.firstPreviewReady(phrase(onset: 1, voicedMs: 0)))
    }

    func testDirectiveCarriesTheHoldOnlyWhenTheDaemonSendsIt() throws {
        let base = #"{"revision":"r","capture":true,"inputDevice":"system-default","roster":[]"#
        XCTAssertNil(try JSONDecoder().decode(Directive.self, from: Data((base + "}").utf8)).firstPreviewVoicedMs)
        XCTAssertEqual(try JSONDecoder().decode(Directive.self, from: Data((base + #","firstPreviewVoicedMs":300}"#).utf8))
            .firstPreviewVoicedMs, 300)
    }
}
