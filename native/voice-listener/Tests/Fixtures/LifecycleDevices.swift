// Compiled alongside the production Listener.swift for the subprocess lifecycle
// tests. The parent drives its real long poll and receives its real HTTP posts.
import Foundation

private func observe(_ event: String) {
    FileHandle.standardOutput.write(Data((event + "\n").utf8))
}

func permission() -> String { ProcessInfo.processInfo.environment["VOICE_FIXTURE_PERMISSION"] ?? "granted" }

struct Device: Encodable {
    static func inputs() -> [Device] { [] }
}

final class Segment {
    let label: String
    let endedAt: Int64
    let startedAtHostUs: Int64 = 125
    let speechStartHostUs: Int64
    init(_ label: String, endedAt: Int64 = 1, onset: Int64 = 625) {
        self.label = label
        self.endedAt = endedAt
        speechStartHostUs = onset
    }
    func through(_ release: Int64) -> Segment? {
        endedAt > release ? Segment(label + "-clipped", endedAt: release, onset: speechStartHostUs) : self
    }
    deinit { observe("released " + label) }
}

@MainActor final class Microphone {
    static var openings = 0
    private static weak var exclusiveOwner: Microphone?
    private let exclusive: Bool
    let opening: Int
    let segments: AsyncStream<Segment>
    private(set) var isRunning = true
    private var disruption: DispatchSourceSignal?
    private var heldPhrases: [Segment] = []
    private let source: AsyncStream<Segment>.Continuation

    init(selection: String, held: Bool, endOfSpeechMs: Int, onSpeechStart: @escaping (Int64) -> Void,
         onSegmentDropped: @escaping (Int64) -> Void, onStopped: @escaping @MainActor (Microphone) -> Void) throws {
        exclusive = selection == "exclusive"
        if exclusive, Self.exclusiveOwner?.isRunning == true {
            observe("overlapping microphones")
            throw CaptureError.device
        }
        Self.openings += 1
        opening = Self.openings
        if selection == "unplugged" && opening > 1 { throw CaptureError.device }
        (segments, source) = AsyncStream.makeStream()
        if exclusive { Self.exclusiveOwner = self }
        observe("silence interval \(endOfSpeechMs) ms")
        observe("opened \(opening)")
        if ["reconfigured", "unplugged"].contains(selection) && opening == 1 {
            signal(SIGUSR1, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .main)
            source.setEventHandler { [weak self] in
                guard let self else { return }
                self.isRunning = false
                onStopped(self)
            }
            disruption = source
            source.resume()
        }
        if held {
            if selection == "partial-hold" {
                let complete = Segment("completed hold")
                heldPhrases = [complete]
                onSpeechStart(complete.speechStartHostUs)
                onSpeechStart(complete.speechStartHostUs + 1)
            } else if (selection == "rapid-press" || exclusive) && opening == 1 {
                heldPhrases = [Segment("first hold")]
            } else {
                heldPhrases = (1...4).map { Segment("phrase \($0)") }
            }
            if opening > 1 {
                Recognizer.pendingDecode?.resume()
                Recognizer.pendingDecode = nil
            }
            observe("holding audio")
        } else if selection == "stalled-onset" {
            for segment in [Segment("Cancel."), Segment("next", endedAt: 2, onset: 1625)] {
                onSpeechStart(segment.speechStartHostUs)
                source.yield(segment)
            }
        } else if selection == "dropped-segment" {
            onSpeechStart(123_456)
            onSegmentDropped(123_456)
        } else if selection == "unfinished-segment" {
            onSpeechStart(123_456)
        } else if selection == "two-segments" {
            source.yield(Segment("undecodable"))
            source.yield(Segment("next"))
        } else if selection == "two-utterances" {
            source.yield(Segment("first", endedAt: 2000))
            source.yield(Segment("second"))
        } else if opening == 1 {
            source.yield(Segment("in-flight", endedAt: 2000))
            source.yield(Segment("buffered"))
        } else {
            source.yield(Segment("fresh"))
            Recognizer.pendingDecode?.resume()
            Recognizer.pendingDecode = nil
        }
    }

    func updateEndOfSpeechMs(_ duration: Int) {
        observe("silence interval \(duration) ms")
        Recognizer.pendingDecode?.resume()
        Recognizer.pendingDecode = nil
    }

    func whenCaptured(through release: Int64, finish: @escaping @MainActor () -> Void) {
        guard exclusive && opening == 1 else { finish(); return }
        signal(SIGUSR2, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: SIGUSR2, queue: .main)
        source.setEventHandler { finish() }
        disruption = source
        source.resume()
    }

    @discardableResult func stop(releasedAt: Int64? = nil) -> [Segment] {
        disruption?.cancel()
        isRunning = false
        observe("stopped \(opening)")
        source.finish()
        if releasedAt != nil {
            Recognizer.pendingDecode?.resume()
            Recognizer.pendingDecode = nil
            return heldPhrases + [Segment("final phrase")]
        }
        return []
    }

    deinit { observe("released microphone \(opening)") }
}

struct FixtureUtterance: Encodable { let text: String }

@MainActor struct Recognizer {
    static var pendingDecode: CheckedContinuation<Void, Never>?
    let ctc: Bool? = nil

    init(directory: URL) async throws {
        if directory.lastPathComponent == "slow-load" {
            while !FileManager.default.fileExists(atPath: directory.appending(path: "ready").path) {
                try await Task.sleep(for: .milliseconds(10))
            }
            observe("model loaded")
        }
    }
    func prime(_ roster: [String]) async throws -> Bool? {
        let names = try JSONEncoder().encode(roster)
        observe("prime " + String(decoding: names, as: UTF8.self))
        return nil
    }

    func transcribe(_ segment: Segment, boosting: Bool?) async throws -> FixtureUtterance? {
        observe("decode " + segment.label)
        if segment.label == "undecodable" { throw CocoaError(.coderReadCorrupt) }
        if segment.label == "in-flight" || segment.label == "first hold" {
            // Model inference can complete after its task is cancelled. Return
            // the old result only once the second capture is already active.
            await withCheckedContinuation { Self.pendingDecode = $0 }
        }
        return FixtureUtterance(text: segment.label)
    }
}
