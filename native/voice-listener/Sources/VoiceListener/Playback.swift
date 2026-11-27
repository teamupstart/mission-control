import AVFoundation
import CoreAudio

enum Speak: Decodable, Equatable {
    case stop(id: String)
    case audio(id: String, durationMs: Double)
    case system(id: String, voiceId: String, text: String)

    private enum CodingKeys: CodingKey { case id, stop, kind, durationMs, voiceId, text }
    private enum Kind: String, Decodable { case audio, system }

    init(from decoder: Decoder) throws {
        let fields = try decoder.container(keyedBy: CodingKeys.self)
        let id = try fields.decode(String.self, forKey: .id)
        if try fields.decodeIfPresent(Bool.self, forKey: .stop) == true {
            self = .stop(id: id)
            return
        }
        switch try fields.decode(Kind.self, forKey: .kind) {
        case .audio:
            let duration = try fields.decode(Double.self, forKey: .durationMs)
            guard duration >= 0 else {
                throw DecodingError.dataCorruptedError(forKey: .durationMs, in: fields, debugDescription: "Negative audio duration")
            }
            self = .audio(id: id, durationMs: duration)
        case .system:
            self = .system(id: id, voiceId: try fields.decode(String.self, forKey: .voiceId),
                           text: try fields.decode(String.self, forKey: .text))
        }
    }
}

protocol InstalledSpeechVoice {
    var identifier: String { get }
    var name: String { get }
    var language: String { get }
    var quality: AVSpeechSynthesisVoiceQuality { get }
}

extension AVSpeechSynthesisVoice: InstalledSpeechVoice {}

struct SpeechHello: Encodable {
    struct Voice: Encodable {
        let id, name, language, quality: String
    }
    // A supervised listener always advertises both output paths. Whether anything is spoken
    // is the operator's choice, which the daemon applies through `speech.playback`.
    let audio = true
    let systemVoices: [Voice]

    init() {
        self.init(installedVoices: AVSpeechSynthesisVoice.speechVoices)
    }

    init<V: InstalledSpeechVoice>(installedVoices: () -> [V]) {
        systemVoices = installedVoices().filter {
            $0.language.split(separator: "-").first?.lowercased() == "en"
        }.prefix(256).map {
            Voice(id: $0.identifier, name: $0.name, language: $0.language,
                  quality: $0.quality == .premium ? "premium" : $0.quality == .enhanced ? "enhanced" : "default")
        }
    }
}

enum SpeechContent: Equatable {
    case audio(Data)
    case system(voiceId: String, text: String)
}

@MainActor protocol SpeechPlayer: AnyObject {
    func play(_ content: SpeechContent, started: @escaping () -> Void, ended: @escaping (String) -> Void) throws
    func stop()
}

// AVAudioPlayer consumes a WAV in memory. Its finish delegate follows playout,
// while stop() synchronously undoes play(). Speech cancellation is asynchronous.
@MainActor final class MacSpeechPlayer: NSObject, SpeechPlayer, AVAudioPlayerDelegate, @preconcurrency AVSpeechSynthesizerDelegate {
    private var audio: AVAudioPlayer?
    private let synth = AVSpeechSynthesizer()
    private var utterance: AVSpeechUtterance?
    private var started: (() -> Void)?
    private var ended: ((String) -> Void)?
    private var reason = "finished"
    private var playGeneration = UUID()
    private var routeListener: AudioObjectPropertyListenerBlock?
    private var output = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice,
        mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)

    func play(_ content: SpeechContent, started: @escaping () -> Void, ended: @escaping (String) -> Void) throws {
        playGeneration = UUID()
        let generation = playGeneration
        let listener: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            MainActor.assumeIsolated { if self?.playGeneration == generation { self?.halt("failed") } }
        }
        guard AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &output, .main, listener) == noErr
        else { throw CaptureError.device }
        routeListener = listener
        self.started = started
        self.ended = ended
        reason = "finished"
        do {
            switch content {
            case .audio(let wav):
                let player = try AVAudioPlayer(data: wav, fileTypeHint: AVFileType.wav.rawValue)
                audio = player
                player.delegate = self
                guard player.play() else { throw CaptureError.device }
                started()
            case .system(let voiceId, let text):
                guard let voice = AVSpeechSynthesisVoice(identifier: voiceId) else { throw CaptureError.format }
                let phrase = AVSpeechUtterance(string: text)
                utterance = phrase
                phrase.voice = voice
                synth.delegate = self
                synth.speak(phrase)
            }
        } catch { halt("failed") }
    }

    func stop() { halt("stopped") }

    private func halt(_ outcome: String) {
        reason = outcome
        if utterance != nil {
            // Even an utterance queued before didStart needs a terminal delegate callback.
            _ = synth.stopSpeaking(at: .immediate)
        } else {
            audio?.stop()
            finish(outcome)
        }
    }

    private func finish(_ outcome: String) {
        if let routeListener {
            AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &output, .main, routeListener)
        }
        routeListener = nil
        audio = nil
        utterance = nil
        started = nil
        let callback = ended
        ended = nil
        callback?(outcome)
    }
    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        if player === audio { finish(flag ? reason : "failed") }
    }
    func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        if player === audio { halt("failed") }
    }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart phrase: AVSpeechUtterance) {
        guard phrase === utterance else { return }
        if reason == "finished" { started?() }
        else { _ = synth.stopSpeaking(at: .immediate) }
    }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish phrase: AVSpeechUtterance) {
        if phrase === utterance { finish(reason) }
    }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel phrase: AVSpeechUtterance) {
        if phrase === utterance { finish(reason == "finished" ? "failed" : reason) }
    }
}

@MainActor final class Playback {
    private let player: SpeechPlayer
    private let fetch: (String) async throws -> Data
    private let report: (String, String, String?) async throws -> Void
    private var held: String?
    private var lastEnded: String?
    private var stopRequested = false
    private var endedAsStopped = false
    private var fetching: Task<Void, Never>?
    private var stoppingPlayer = false
    private var playing = false
    private var reporting: Task<Void, Error>?
    private var completion: Task<Void, Error>?
    private var stopped: CheckedContinuation<Void, Never>?
    var changed: (() -> Void)?
    var busy: Bool { held != nil }

    init(player: SpeechPlayer, fetch: @escaping (String) async throws -> Data,
         report: @escaping (String, String, String?) async throws -> Void) {
        self.player = player
        self.fetch = fetch
        self.report = report
    }

    func apply(_ job: Speak?) async throws {
        switch job {
        case .stop(let id):
            let stoppingHeld = held == id
            if stoppingHeld { stopRequested = true }
            try await stopCurrentJob()
            if !stoppingHeld || !endedAsStopped {
                try await confirmEnd(id, "stopped")
                lastEnded = id
            }
        case .audio(let id, _):
            try await play(id) { [fetch] in .audio(try await fetch(id)) }
        case .system(let id, let voiceId, let text):
            try await play(id) { .system(voiceId: voiceId, text: text) }
        case nil:
            try await stopCurrentJob()
            lastEnded = nil
        }
    }

    private func stopCurrentJob(except id: String? = nil) async throws {
        if let held, held != id {
            fetching?.cancel()
            if playing {
                await withCheckedContinuation { continuation in
                    stopped = continuation
                    requestPlayerStop()
                }
            } else if completion == nil { finish(held, "stopped") }
        }
        try await completion?.value
    }

    private func play(_ id: String, prepare: @escaping () async throws -> SpeechContent) async throws {
        try await stopCurrentJob(except: id)
        guard held == nil, id != lastEnded else { return }
        stopRequested = false
        held = id
        fetching = Task {
            do {
                let content = try await prepare()
                try Task.checkCancellation()
                playing = true
                try player.play(content, started: {
                    self.reporting = Task {
                        do { try await self.report(id, "started", nil) }
                        catch {
                            // A late start can receive the stop before the long poll does.
                            if self.held == id && self.playing { self.requestPlayerStop() }
                        }
                    }
                }, ended: { self.finish(id, $0) })
            } catch {
                if !Task.isCancelled { finish(id, "failed") }
            }
        }
    }

    private func confirmEnd(_ id: String, _ outcome: String) async throws {
        var backoff = 100
        while true {
            try Task.checkCancellation()
            do {
                try await report(id, "ended", outcome)
                return
            } catch {
                switch error {
                case Daemon.ServiceError.http(500...599), Daemon.ServiceError.http(408), Daemon.ServiceError.http(429),
                     URLError.timedOut, URLError.cannotConnectToHost,
                     URLError.networkConnectionLost, URLError.notConnectedToInternet:
                    // Even if only the reply was lost, retry the same end with capture closed.
                    try await Task.sleep(for: .milliseconds(backoff))
                    backoff = min(2000, backoff * 2)
                default: throw error
                }
            }
        }
    }

    private func requestPlayerStop() {
        guard !stoppingPlayer else { return }
        stoppingPlayer = true
        player.stop()
    }

    private func finish(_ id: String, _ outcome: String) {
        guard held == id, completion == nil else { return }
        let hadPlayer = playing
        playing = false
        stoppingPlayer = false
        stopped?.resume()
        stopped = nil
        completion = Task {
            // Let speaker output decay before the end report releases capture.
            if hadPlayer { try await Task.sleep(for: .milliseconds(250)) }
            // Once silent, cancel and join any in-flight started POST so ended stays
            // ordered without spending the daemon's stop deadline on the first reply.
            reporting?.cancel()
            _ = await reporting?.result
            reporting = nil
            let terminal = stopRequested ? "stopped" : outcome
            endedAsStopped = terminal == "stopped"
            do { try await confirmEnd(id, terminal) }
            catch { changed?(); throw error }
            held = nil
            lastEnded = id
            fetching = nil
            completion = nil
            changed?()
        }
    }
}
