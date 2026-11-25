import AVFoundation
import XCTest
@testable import VoiceListener

@MainActor private final class Output: SpeechPlayer {
    var played: [SpeechContent] = []
    var stopping = false
    var onStop: (() -> Void)?
    var ended: ((String) -> Void)?
    func play(_ content: SpeechContent, started: @escaping () -> Void, ended: @escaping (String) -> Void) throws {
        played.append(content)
        self.ended = ended
        started()
    }
    func stop() {
        stopping = true
        onStop?()
    }
}

@MainActor final class PlaybackTests: XCTestCase {
    private let systemJob = Speak.system(id: "held", voiceId: "test-voice", text: "Steve or Will?")

    private func decodeSpeak(_ json: String) throws -> Speak? {
        let directive = #"{"revision":"1","capture":false,"inputDevice":"default","roster":[],"speak":\#(json)}"#
        return try JSONDecoder().decode(Directive.self, from: Data(directive.utf8)).speak
    }

    func testDecodesContractLStopAudioSystemAndNull() throws {
        XCTAssertEqual(try decodeSpeak(#"{"id":"held","stop":true}"#), .stop(id: "held"))
        XCTAssertEqual(try decodeSpeak(#"{"id":"held","stop":true,"kind":"future"}"#), .stop(id: "held"))
        XCTAssertEqual(try decodeSpeak(#"{"id":"audio","kind":"audio","durationMs":25.5}"#),
                       .audio(id: "audio", durationMs: 25.5))
        XCTAssertEqual(try decodeSpeak(#"{"id":"held","kind":"system","voiceId":"test-voice","text":"Steve or Will?"}"#), systemJob)
        XCTAssertNil(try decodeSpeak("null"))
    }

    func testRejectsUnknownKindsAndIncompleteSpeechDirectives() {
        for json in [
            #"{"id":"x","kind":"future","voiceId":"v","text":"Hello"}"#,
            #"{"id":"x","stop":false}"#,
            #"{"id":"x","kind":"audio"}"#,
            #"{"id":"x","kind":"audio","durationMs":-1}"#,
            #"{"id":"x","kind":"system","text":"Hello"}"#,
            #"{"id":"x","kind":"system","voiceId":"v"}"#,
        ] {
            XCTAssertThrowsError(try decodeSpeak(json), json) { XCTAssertTrue($0 is DecodingError) }
        }
    }

    private struct Voice: InstalledSpeechVoice {
        let identifier, name, language: String
        let quality: AVSpeechSynthesisVoiceQuality
    }

    func testUnqualifiedOutputAdvertisesNeitherAudioNorSystemVoices() {
        let hello = SpeechHello()
        XCTAssertFalse(hello.audio)
        XCTAssertTrue(hello.systemVoices.isEmpty)
    }

    func testQualifiedHelloListsEnglishVoicesWithDefaultEnhancedAndPremiumQuality() throws {
        let hello = SpeechHello(passedSpeakerCheck: true) {
            [Voice(identifier: "basic", name: "Alex", language: "en", quality: .default),
             Voice(identifier: "french", name: "Thomas", language: "fr-CA", quality: .premium),
             Voice(identifier: "enhanced", name: "Ava", language: "EN-US", quality: .enhanced),
             Voice(identifier: "premium", name: "Ava", language: "en-GB", quality: .premium)]
        }
        let payload = try JSONSerialization.jsonObject(with: JSONEncoder().encode(hello)) as? [String: Any]
        XCTAssertEqual(payload?["audio"] as? Bool, true)
        XCTAssertEqual(payload?["systemVoices"] as? [[String: String]], [
            ["id": "basic", "name": "Alex", "language": "en", "quality": "default"],
            ["id": "enhanced", "name": "Ava", "language": "EN-US", "quality": "enhanced"],
            ["id": "premium", "name": "Ava", "language": "en-GB", "quality": "premium"],
        ])
    }

    func testQualifiedHelloPreservesEnglishVoiceOrderAt256And257Voices() {
        let english = (1...257).map { index in
            Voice(identifier: "voice-\(index)", name: "Voice \(index)", language: "en-US", quality: .default)
        }
        let french = Voice(identifier: "french", name: "Thomas", language: "fr-CA", quality: .premium)
        let expectedIDs = (1...256).map { "voice-\($0)" }
        for count in [256, 257] {
            let hello = SpeechHello(passedSpeakerCheck: true) { [french] + english.prefix(count) }
            XCTAssertEqual(hello.systemVoices.map(\.id), expectedIDs, "\(count) installed English voices")
        }
    }

    func testQualifiedHelloEnumeratesTheMacsInstalledEnglishVoices() {
        let installed = AVSpeechSynthesisVoice.speechVoices().filter {
            let language = $0.language.lowercased()
            return language == "en" || language.hasPrefix("en-")
        }.prefix(256)
        let advertised = SpeechHello(passedSpeakerCheck: true).systemVoices
        XCTAssertEqual(advertised.map(\.id).sorted(), installed.map(\.identifier).sorted())
    }

    func testForeignStopWaitsForRealSilenceAndAcknowledgesBothJobs() async throws {
        let player = Output()
        var events: [String] = []
        let playback = Playback(player: player, fetch: { _ in Data() }, report: { id, type, outcome in
            events.append([id, type, outcome].compactMap { $0 }.joined(separator: " "))
        })
        try await playback.apply(systemJob)
        while events.isEmpty { await Task.yield() }
        let stop = Task { try await playback.apply(.stop(id: "foreign")) }
        while !player.stopping { await Task.yield() }
        XCTAssertTrue(playback.busy)
        XCTAssertEqual(events, ["held started"])
        player.ended?("stopped")
        try await stop.value
        XCTAssertEqual(events, ["held started", "held ended stopped", "foreign ended stopped"])
        XCTAssertFalse(playback.busy)
    }

    func testStopDuringOutputTailConfirmsTheRequestedJobOnce() async throws {
        let player = Output()
        var events: [String] = []
        let playback = Playback(player: player, fetch: { _ in Data() }, report: { _, type, outcome in
            events.append(outcome ?? type)
        })
        try await playback.apply(systemJob)
        while events.isEmpty { await Task.yield() }
        player.ended?("finished")
        XCTAssertTrue(playback.busy)
        try await playback.apply(.stop(id: "held"))
        XCTAssertEqual(events, ["started", "stopped"])
        XCTAssertFalse(playback.busy)
    }

    func testStopWhileFetchingNeverStartsAudioAndUnknownStopStillEnds() async throws {
        let player = Output()
        var fetching = false
        var events: [String] = []
        let playback = Playback(player: player, fetch: { _ in
            fetching = true
            try await Task.sleep(for: .seconds(30))
            return Data()
        }, report: { id, type, outcome in events.append("\(id) \(type) \(outcome ?? "")") })
        try await playback.apply(.audio(id: "audio", durationMs: 500))
        while !fetching { await Task.yield() }
        try await playback.apply(.stop(id: "audio"))
        try await playback.apply(.stop(id: "unknown"))
        XCTAssertEqual(events, ["audio ended stopped", "unknown ended stopped"])
        XCTAssertTrue(player.played.isEmpty)
        XCTAssertFalse(playback.busy)
    }

    func testRejectedStartStopsActivePlayerAndReportsItsEndAfterSilence() async throws {
        let player = Output()
        let stop = expectation(description: "player receives stop after the daemon rejects started")
        player.onStop = { stop.fulfill() }
        var reports: [String] = []
        let playback = Playback(player: player, fetch: { _ in
            XCTFail("System speech must use live text without fetching audio")
            return Data()
        }, report: { id, type, outcome in
            reports.append([id, type, outcome].compactMap { $0 }.joined(separator: " "))
            if type == "started" { throw Daemon.ServiceError.http(409) }
        })
        try await playback.apply(systemJob)
        await fulfillment(of: [stop], timeout: 3)
        XCTAssertEqual(player.played, [.system(voiceId: "test-voice", text: "Steve or Will?")])
        XCTAssertEqual(reports, ["held started"])
        XCTAssertTrue(playback.busy)

        let ended = expectation(description: "job released after the player's terminal callback")
        playback.changed = { ended.fulfill() }
        try XCTUnwrap(player.ended)("stopped")
        await fulfillment(of: [ended], timeout: 3)
        XCTAssertEqual(reports, ["held started", "held ended stopped"])
        XCTAssertFalse(playback.busy)
    }

    func testFailedStopReportRetriesBeforeFreshCapture() async throws {
        let player = Output()
        var attempts: [String] = []
        var acknowledge: CheckedContinuation<Void, Never>?
        let playback = Playback(player: player, fetch: { _ in Data() }, report: { id, type, outcome in
            guard type == "ended" else { return }
            attempts.append("\(id) \(outcome ?? "")")
            if attempts.count == 1 { throw URLError(.networkConnectionLost) }
            await withCheckedContinuation { acknowledge = $0 }
        })
        try await playback.apply(systemJob)
        while player.ended == nil { await Task.yield() }
        let stop = Task { try await playback.apply(.stop(id: "held")) }
        while !player.stopping { await Task.yield() }
        player.ended?("stopped")
        let deadline = ContinuousClock.now + .seconds(3)
        while acknowledge == nil && ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(attempts, ["held stopped", "held stopped"])
        XCTAssertTrue(playback.busy, "capture must remain closed until confirmation succeeds")
        try XCTUnwrap(acknowledge).resume()
        try await stop.value
        try await playback.apply(nil)
        XCTAssertFalse(playback.busy)
        XCTAssertEqual(player.played, [.system(voiceId: "test-voice", text: "Steve or Will?")])
    }

    func testNativePlayerReportsOneFailureWithoutStartingForUnknownVoice() async throws {
        try await assertFailedWithoutStarting(.system(voiceId: "org.example.missing-\(UUID())", text: "Test"))
    }

    func testNativePlayerReportsOneFailureWithoutStartingForMalformedWav() async throws {
        try await assertFailedWithoutStarting(.audio(Data("RIFF".utf8)))
    }

    private func assertFailedWithoutStarting(_ content: SpeechContent) async throws {
        let player = MacSpeechPlayer()
        var callbacks: [String] = []
        let completion = expectation(description: "invalid content reaches a terminal callback")
        try player.play(content, started: { callbacks.append("started") }, ended: { outcome in
            callbacks.append(outcome)
            completion.fulfill()
        })
        await fulfillment(of: [completion], timeout: 3)
        player.stop()
        XCTAssertEqual(callbacks, ["failed"])
    }

    func testQueuedSystemSpeechStopsBeforeStartCallback() async throws {
        let player = MacSpeechPlayer()
        let voice = try XCTUnwrap(AVSpeechSynthesisVoice(language: "en-US"))
        var starts = 0
        var ends: [String] = []
        try player.play(.system(voiceId: voice.identifier, text: "Queued speech."),
                        started: { starts += 1 }, ended: { ends.append($0) })
        XCTAssertEqual(starts, 0)
        player.stop() // Same main-actor turn as speak(), before any queued delegate delivery.
        let deadline = ContinuousClock.now + .seconds(5)
        while ends.isEmpty && ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(10)) }
        // Allow late completion or cancellation delegates to run as well.
        try await Task.sleep(for: .milliseconds(250))
        XCTAssertEqual(starts, 0)
        XCTAssertEqual(ends, ["stopped"])
    }

    func testCompletionWaitsForReportAndStaleDirectiveCannotReplay() async throws {
        let player = Output()
        var reporting: CheckedContinuation<Void, Never>?
        let wav = Data("sample WAV".utf8)
        var fetched: [String] = []
        let playback = Playback(player: player, fetch: { id in
            fetched.append(id)
            return wav
        }, report: { _, type, _ in
            if type == "ended" { await withCheckedContinuation { reporting = $0 } }
        })
        let job = Speak.audio(id: "audio", durationMs: 500)
        try await playback.apply(job)
        while player.ended == nil { await Task.yield() }
        player.ended?("finished")
        while reporting == nil { await Task.yield() }
        XCTAssertTrue(playback.busy)
        reporting?.resume()
        try await playback.apply(job)
        XCTAssertFalse(playback.busy)
        XCTAssertEqual(fetched, ["audio"])
        XCTAssertEqual(player.played, [.audio(wav)])
    }
}
