import Darwin
import Foundation
import Security

enum CaptureError: Error { case device, format, listenerInUse }

enum SpeechDrop { case interrupted, queueFull, captureLimit }
typealias SegmentDropped = (Int64, SpeechDrop) -> Void

struct Directive: Decodable {
    static let defaultEndOfSpeechMs = 2000
    let revision: String
    let captureRevision: String?
    let capture: Bool
    let endOfSpeechMs: Int?
    let inputDevice: String
    let speak: Speak?
    let roster: [String]
}

struct Hello: Encodable {
    var speech: SpeechHello?
    let version = "4.1"
    let reportsSpeechOnset = true
    let backend = "fluidaudio"
    let devices = Array(Device.inputs().prefix(64))
    let modelLoaded: Bool
    let primingAvailable: Bool
    let microphone: String
}

final class Daemon: NSObject, URLSessionTaskDelegate {
    typealias Response = (data: Data, http: HTTPURLResponse)
    typealias CaptureTimes = (startUs: Int64, speechStartUs: Int64, endMs: Int64)
    struct Acknowledgement: Decodable { let accepted: Bool }
    let base: URL
    let pinnedCertificate: Data?
    let token: String
    let directory: URL
    private let listenerID: String
    let speechInstance: String?
    private let captureLockPath: String
    private var captureOffset: Int64?
    private var captureLock: Int32 = -1
    private let configuration: URLSessionConfiguration
    private lazy var session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)

    init(environment env: [String: String] = ProcessInfo.processInfo.environment,
         configuration: URLSessionConfiguration = .ephemeral) {
        self.configuration = configuration
        let pin = env["MISSION_VOICE_DAEMON_CERT"]
        let owner = pin == nil ? nil : env["MISSION_VOICE_SUPERVISOR_ID"].flatMap(UUID.init(uuidString:))
        listenerID = (owner ?? UUID()).uuidString
        pinnedCertificate = pin.flatMap { Data(base64Encoded: $0) }
        guard let base = env["MISSION_VOICE_DAEMON_URL"].flatMap(URL.init(string:)),
              (pin == nil && base.scheme == "http") || (pinnedCertificate?.isEmpty == false && base.scheme == "https"),
              ["localhost", "127.0.0.1", "[::1]"].contains(base.host?.lowercased() ?? ""),
              let file = env["MISSION_VOICE_TOKEN_FILE"], let token = try? String(contentsOfFile: file, encoding: .utf8),
              let models = env["MISSION_VOICE_MODEL_DIR"] else {
            fputs("Expected a loopback daemon URL, readable token file and model directory.\n", stderr)
            exit(1)
        }
        speechInstance = env["MISSION_VOICE_LISTENER_INSTANCE"]
        captureLockPath = URL(fileURLWithPath: file).deletingLastPathComponent().appendingPathComponent("voice-capture.lock").path
        self.base = base
        self.token = token.trimmingCharacters(in: .whitespacesAndNewlines)
        directory = URL(fileURLWithPath: models)
    }

    func applyCaptureChallenge(_ challenge: String?) throws {
        guard speechInstance == nil, let challenge else { return }
        guard let offset = Int64(challenge), offset > 0, offset < (1 << 48) else { throw CaptureError.format }
        if offset == captureOffset { return }
        if captureLock >= 0 { Darwin.close(captureLock) }
        captureOffset = nil
        captureLock = open(captureLockPath, O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK, 0o600)
        var info = stat()
        var lock = flock()
        lock.l_type = Int16(F_WRLCK)
        lock.l_whence = Int16(SEEK_SET)
        lock.l_start = offset
        lock.l_len = 1
        guard captureLock >= 0, fstat(captureLock, &info) == 0,
              info.st_mode & S_IFMT == S_IFREG, fcntl(captureLock, F_SETLK, &lock) == 0 else {
            throw CaptureError.device
        }
        captureOffset = offset
    }

    deinit { if captureLock >= 0 { Darwin.close(captureLock) } }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard let pin = pinnedCertificate,
              challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust,
              let certificates = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
              let leaf = certificates.first, SecCertificateCopyData(leaf) as Data == pin else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    enum ServiceError: Error { case http(Int) }

    func request(_ route: String, revision: String? = nil, capture: CaptureTimes? = nil, body: Data? = nil, allowObsolete: Bool = false) async throws -> Response {
        var url = base.appending(path: route)
        if let revision { url.append(queryItems: [URLQueryItem(name: "revision", value: revision)]) }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: body == nil || capture != nil ? 30 : 5)
        req.setValue(token, forHTTPHeaderField: "x-harness-token")
        req.setValue(listenerID, forHTTPHeaderField: "x-voice-listener-id")
        if let speechInstance {
            req.setValue(speechInstance, forHTTPHeaderField: "x-mission-voice-instance")
        } else {
            req.setValue(String(getpid()), forHTTPHeaderField: "x-voice-capture-pid")
        }
        if let capture {
            req.setValue(String(capture.startUs), forHTTPHeaderField: "x-voice-capture-start-host-us")
            req.setValue(String(capture.speechStartUs), forHTTPHeaderField: "x-voice-speech-start-host-us")
            req.setValue(String(capture.endMs), forHTTPHeaderField: "x-voice-capture-end-host-ms")
        }
        if let body {
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = body
        }
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        if http.statusCode == 409,
           (try? JSONDecoder().decode([String: String].self, from: data))?["error"] == "listener_in_use" {
            throw CaptureError.listenerInUse
        }
        guard http.statusCode == 200 || (allowObsolete && http.statusCode == 409) else {
            throw ServiceError.http(http.statusCode)
        }
        return (data, http)
    }

    private struct SpeechKey: Hashable {
        let revision: String
        let onset: Int64
    }
    private let speechLock = NSLock()
    private var starts: [SpeechKey: Task<Void, Never>] = [:]
    private var dictating = Set<SpeechKey>()

    func isDictating(_ onset: Int64, revision: String) -> Bool {
        speechLock.withLock { dictating.contains(SpeechKey(revision: revision, onset: onset)) }
    }

    func shouldPreview(_ onset: Int64, revision: String) async -> Bool {
        let key = SpeechKey(revision: revision, onset: onset)
        if isDictating(onset, revision: revision) { return true }
        guard speechLock.withLock({ starts[key] != nil }) else { return false }
        await sendSpeech(key, phase: "focus")
        return isDictating(onset, revision: revision)
    }

    func preview(_ text: String, onset: Int64, revision: String) async throws {
        struct Preview: Encodable { let phase = "preview"; let text: String; let speechStartUs: Int64 }
        let body = try JSONEncoder().encode(Preview(text: text, speechStartUs: onset))
        let (_, response) = try await request("voice/listener/speech", revision: revision, body: body)
        if response.value(forHTTPHeaderField: "x-voice-dictation") != "1" {
            let key = SpeechKey(revision: revision, onset: onset)
            _ = speechLock.withLock { dictating.remove(key) }
        }
    }

    private var finishes: [SpeechKey: Task<Void, Never>] = [:]

    private func sendSpeech(_ key: SpeechKey, phase: String) async {
        struct Event: Encodable { let speechStartUs: Int64; let phase: String }
        do {
            let body = try JSONEncoder().encode(Event(speechStartUs: key.onset, phase: phase))
            let (_, response) = try await request("voice/listener/speech", revision: key.revision, body: body)
            if response.value(forHTTPHeaderField: "x-voice-dictation") == "1" {
                speechLock.withLock { if starts[key] != nil { dictating.insert(key) } }
            }
        } catch {
            fputs("Voice listener could not report a speech boundary.\n", stderr)
        }
    }

    func reportPreview(_ phase: String, revision: String, onset: Int64? = nil, text: String? = nil) async -> Bool {
        struct Sample: Encodable { let phase: String; let onset: Int64?; let text: String? }
        do {
            let body = try JSONEncoder().encode(Sample(phase: phase, onset: onset, text: text))
            let (data, _) = try await request("voice/listener/transcript", revision: revision, body: body)
            return try JSONDecoder().decode(Acknowledgement.self, from: data).accepted
        } catch { return false }
    }

    func pendingOnset(revision: String) -> Int64? {
        speechLock.withLock { starts.keys.filter { $0.revision == revision }.map(\.onset).max() }
    }

    // Register synchronously on the tap. Each segment waits only for its own onset POST.
    func startSpeech(_ onset: Int64, revision: String) {
        let key = SpeechKey(revision: revision, onset: onset)
        speechLock.withLock {
            guard starts[key] == nil, finishes[key] == nil else { return }
            // A loopback request may reach the router even if its acknowledgment stalls.
            // Cancel and join the request at the deadline before sending a result or finish.
            let deadline = ContinuousClock.now + .seconds(1)
            starts[key] = Task {
                await withTaskGroup(of: Void.self) { group in
                    group.addTask { await self.sendSpeech(key, phase: "start") }
                    group.addTask { try? await Task.sleep(until: deadline, clock: .continuous) }
                    await group.next()
                    group.cancelAll()
                }
            }
        }
    }

    func settleSpeech(_ onset: Int64, revision: String, accepted: Bool = false, drop: SpeechDrop? = nil) {
        let key = SpeechKey(revision: revision, onset: onset)
        speechLock.withLock {
            dictating.remove(key)
            guard let start = starts.removeValue(forKey: key), !accepted else { return }
            finishes[key] = Task {
                await start.value
                await sendSpeech(key, phase: drop == .captureLimit ? "capture-limit" : "finish")
                speechLock.withLock { finishes[key] = nil }
            }
        }
    }

    // stop() has synchronously closed the tap. A released hold can still yield
    // clipped segments for decoding; keep exactly those reservations alive.
    func closeSpeech(revision: String, keeping segments: [Segment] = []) {
        let keep = Set(segments.map(\.speechStartHostUs))
        let discarded = speechLock.withLock { starts.keys.filter { $0.revision == revision && !keep.contains($0.onset) } }
        for key in discarded { settleSpeech(key.onset, revision: revision) }
    }

    func drainSpeechFinishes() async {
        let pending = speechLock.withLock { Array(finishes.values) }
        for finish in pending { await finish.value }
    }

    func directive(revision: String?, microphonePaused: Bool) async throws -> Response {
        var backoff = 100
        while true {
            try Task.checkCancellation()
            do { return try await request("voice/listener/directive", revision: revision) }
            catch ServiceError.http(503) where microphonePaused {
                try await Task.sleep(for: .milliseconds(backoff))
                backoff = min(2000, backoff * 2)
            }
        }
    }

    func postUtterance(revision: String, capture: CaptureTimes, body: Data) async throws -> Response {
        let key = SpeechKey(revision: revision, onset: capture.speechStartUs)
        let start = speechLock.withLock { starts[key] }
        await start?.value
        try Task.checkCancellation()
        return try await Self.postWithHeldRetries(revision: revision) {
            try await self.request("voice/utterances", revision: revision, capture: capture, body: body)
        }
    }

    static func postWithHeldRetries(revision: String, budget: Duration = .seconds(55),
                                    send: @escaping @Sendable () async throws -> Response) async throws -> Response {
        // Allow two normal 25-second long polls. Bound even a stalled request
        // and pace an alternate daemon that answers immediately.
        let deadline = ContinuousClock.now + budget
        return try await withThrowingTaskGroup(of: Response.self) { group in
            group.addTask {
                try await Task.sleep(until: deadline, clock: .continuous)
                throw URLError(.timedOut)
            }
            group.addTask {
                for attempt in 1...3 {
                    try Task.checkCancellation()
                    let response = try await send()
                    if response.http.value(forHTTPHeaderField: "x-voice-held-revision") != revision { return response }
                    if attempt < 3 { try await Task.sleep(for: .milliseconds(250)) }
                }
                throw URLError(.timedOut)
            }
            defer { group.cancelAll() }
            guard let response = try await group.next() else { throw CancellationError() }
            return response
        }
    }
}

@MainActor func runTranscriptPreview(
    isRunning: @escaping () -> Bool, snapshot: @escaping () -> Segment?, pendingOnset: () -> Int64?,
    decode: @escaping (Segment) async throws -> String?,
    report: @escaping (String, Int64?, String?) async -> Bool,
    editorFocused: @escaping (Int64) async -> Bool = { _ in false },
    updateEditor: @escaping (Int64, String) async throws -> Void = { _, _ in },
    pause: () async -> Void = { try? await Task.sleep(for: .milliseconds(800)) }
) async {
    var decoding: Task<Void, Never>?
    defer { decoding?.cancel() }
    while !Task.isCancelled && isRunning() {
        if let segment = snapshot() {
            let onset = segment.speechStartHostUs
            // Renew capture independently of recognition, even while a slow decode is in flight.
            let overlay = await report("audio", onset, nil)
            if decoding == nil, !Task.isCancelled {
                decoding = Task { @MainActor in
                    defer { decoding = nil }
                    let editor = await editorFocused(onset)
                    guard (editor || overlay), !Task.isCancelled, let words = try? await decode(segment), !Task.isCancelled, isRunning(),
                          snapshot()?.speechStartHostUs == onset else { return }
                    if editor {
                        do {
                            try await updateEditor(onset, words)
                        } catch {
                            guard !Task.isCancelled, !(error is CancellationError), (error as? URLError)?.code != .cancelled else { return }
                            fputs("Voice listener could not deliver a dictation preview.\n", stderr)
                        }
                    }
                    guard overlay else { return }
                    let tail = words.split(whereSeparator: { $0.isWhitespace }).suffix(100).joined(separator: " ")
                    if !tail.isEmpty { _ = await report("words", onset, tail) }
                }
            }
        } else if let onset = pendingOnset() {
            _ = await report("audio", onset, nil)
        } else {
            _ = await report("ready", nil, nil)
        }
        await pause()
    }
}

@MainActor private final class Capture {
    let revision: String
    var mic: Microphone?
    var previewTask: Task<Void, Never>?
    var decoding: Task<Void, Never>?
    var releasedAt: Int64?
    var releasedSegments: [Segment] = []
    var onInputClosed: (() -> Void)?

    let daemon: Daemon

    init(_ revision: String, daemon: Daemon) {
        self.revision = revision
        self.daemon = daemon
    }

    func release(at time: Int64) {
        guard releasedAt == nil else { return }
        previewTask?.cancel()
        releasedAt = time
        mic?.whenCaptured(through: time) { [weak self] in
            guard let self, let mic else { return }
            releasedSegments = mic.stop(releasedAt: time)
            daemon.closeSpeech(revision: revision, keeping: releasedSegments)
            self.mic = nil
            onInputClosed?()
            onInputClosed = nil
        }
    }

    func cancel() {
        onInputClosed = nil
        previewTask?.cancel()
        decoding?.cancel()
        mic?.stop()
        daemon.closeSpeech(revision: revision)
        mic = nil
        releasedSegments.removeAll()
    }
}

@MainActor final class Listener {
    typealias OpenInput = @MainActor (String, Bool, Int, @escaping (Int64) -> Void, @escaping SegmentDropped,
                           @escaping @MainActor (Microphone) -> Void) throws -> Microphone
    let daemon: Daemon
    private let microphonePermission: () -> String
    private let openInput: OpenInput

    init(daemon: Daemon = Daemon(), microphonePermission: @escaping () -> String = permission,
         openInput: @escaping OpenInput = { selection, held, delay, start, drop, stop in
             try Microphone(selection: selection, held: held, endOfSpeechMs: delay, onSpeechStart: start,
                            onSegmentDropped: drop, onStopped: stop)
         }) {
        self.daemon = daemon
        self.microphonePermission = microphonePermission
        self.openInput = openInput
    }
    var recognizer: Recognizer?
    private var current: Capture?
    private var draining: [Capture] = []
    private var directivePoll: Task<Daemon.Response, Error>?
    private var pendingHello: Task<Void, Error>?

    private lazy var playback = Playback(player: MacSpeechPlayer(), fetch: { [daemon] id in
        try await daemon.request("voice/speech/jobs/\(id)/audio").data
    }, report: { [daemon] id, type, outcome in
        var body = ["type": type]
        body["outcome"] = outcome
        _ = try await daemon.request("voice/speech/jobs/\(id)/events", body: JSONEncoder().encode(body), allowObsolete: type == "ended")
    })
    private var speech: SpeechHello? { daemon.speechInstance.map { _ in SpeechHello() } }

    func hello() async throws {
        let previous = pendingHello
        let send = Task {
            try await previous?.value
            try await sendHello(first: previous == nil)
        }
        pendingHello = send
        try await send.value
    }

    private func sendHello(first: Bool) async throws {
        let status = microphonePermission()
        if status != "granted" { close(); await daemon.drainSpeechFinishes() }
        if first && status == "not-determined" {
            fputs("Microphone access is undetermined for the launching app. Run the listener from a terminal app that already has microphone access.\n", stderr)
        }
        let body = Hello(speech: speech, modelLoaded: recognizer != nil, primingAvailable: recognizer?.ctc != nil, microphone: status)
        defer {
            if status == "denied" {
                fputs("Microphone access denied by macOS.\n", stderr)
                exit(2)
            }
        }
        let (_, response) = try await daemon.request("voice/listener/hello", body: JSONEncoder().encode(body))
        try daemon.applyCaptureChallenge(response.value(forHTTPHeaderField: "x-voice-capture-lock"))
    }

    func close() {
        current?.cancel()
        current = nil
        for previous in draining { previous.cancel() }
        draining.removeAll()
    }

    func run() async throws {
        playback.changed = { [weak self] in self?.directivePoll?.cancel() }
        // A pipe inherited across the confined startup gate closes on supervisor death.
        if daemon.speechInstance != nil {
            DispatchQueue.global().async {
                var byte: UInt8 = 0
                while read(STDIN_FILENO, &byte, 1) > 0 {}
                exit(0)
            }
        }
        try await hello()
        let heartbeat = Task {
            while !Task.isCancelled {
                try await Task.sleep(for: .seconds(10))
                do { try await hello() }
                catch { close(); await daemon.drainSpeechFinishes(); exit(1) }
            }
        }
        defer { heartbeat.cancel(); close() }
        let recognizer = try await Recognizer(directory: daemon.directory)
        self.recognizer = recognizer
        try await hello()
        var revision: String?
        while true {
            // A pause acknowledgement may retry while storage recovers. An active
            // microphone must close on failure, including a tap draining its last frames.
            let paused = current?.mic == nil && !draining.contains { $0.mic != nil }
            let poll = Task { [revision] in try await daemon.directive(revision: revision, microphonePaused: paused) }
            directivePoll = poll
            let response = await poll.result
            directivePoll = nil
            if poll.isCancelled {
                // The input changed while the poll was pending. Recheck capture before opening.
                revision = nil
                continue
            }
            let (data, http) = try response.get()
            let next = try JSONDecoder().decode(Directive.self, from: data)
            if next.speak != nil && daemon.speechInstance == nil { throw URLError(.badServerResponse) }
            if next.speak != nil || playback.busy { close() }
            try await playback.apply(next.speak)
            let capture = next.speak == nil && !playback.busy && next.capture && microphonePermission() == "granted"
            if next.revision != revision || capture != (current?.mic?.isRunning == true) {
                let releasedRevision = http.value(forHTTPHeaderField: "x-voice-release-revision")
                var allowed = Set((http.value(forHTTPHeaderField: "x-voice-draining-revisions") ?? "")
                    .split(separator: ",").map(String.init))
                if let releasedRevision { allowed.insert(releasedRevision) }
                draining.removeAll { previous in
                    if allowed.contains(previous.revision) && microphonePermission() == "granted" { return false }
                    previous.cancel()
                    return true
                }
                let held = http.value(forHTTPHeaderField: "x-voice-held-revision") == next.revision
                let duration = next.endOfSpeechMs ?? (held ? 800 : Directive.defaultEndOfSpeechMs)
                if capture {
                    guard (1...30_000).contains(duration) else { throw CaptureError.format }
                    if !held, let authorization = next.captureRevision, current?.revision == authorization,
                       let mic = current?.mic, mic.isRunning {
                        mic.updateEndOfSpeechMs(duration)
                        revision = next.revision
                        continue
                    }
                }
                if let current, microphonePermission() == "granted", releasedRevision == current.revision,
                   let time = http.value(forHTTPHeaderField: "x-voice-release-host-ms").flatMap(Int64.init) {
                    current.release(at: time)
                    draining.append(current)
                } else {
                    current?.cancel()
                }
                current = nil
                if capture, let closing = draining.first(where: { $0.mic != nil }) {
                    // The next press can arrive before the released tap supplies
                    // its final frames. Keep polling so a mute can still cancel it.
                    closing.onInputClosed = { [weak self] in self?.directivePoll?.cancel() }
                } else if capture {
                    let captureRevision = held ? next.revision : next.captureRevision ?? next.revision
                    let batch = Capture(captureRevision, daemon: daemon)
                    current = batch
                    let microphone = try openInput(next.inputDevice, held, duration, { [daemon] onset in
                        daemon.startSpeech(onset, revision: captureRevision)
                    }, { [daemon] onset, reason in
                        daemon.settleSpeech(onset, revision: captureRevision, drop: reason)
                    }, { [weak self] stopped in
                        guard let self, self.current?.mic === stopped else { return }
                        self.current?.cancel()
                        self.current = nil
                        self.directivePoll?.cancel()
                    })
                    batch.mic = microphone
                    batch.previewTask = Task { [daemon] in
                        await runTranscriptPreview(isRunning: { microphone.isRunning }, snapshot: { microphone.preview },
                            pendingOnset: { daemon.pendingOnset(revision: captureRevision) },
                            decode: { try await recognizer.transcribe($0, boosting: nil)?.text },
                            report: { phase, onset, text in
                                await daemon.reportPreview(phase, revision: captureRevision, onset: onset, text: text)
                            }, editorFocused: { await daemon.shouldPreview($0, revision: captureRevision) },
                            updateEditor: { onset, words in
                                try await daemon.preview(words, onset: onset, revision: captureRevision)
                            })
                    }
                    let previous = draining.last?.decoding
                    batch.decoding = Task { [segments = microphone.segments] in
                        defer {
                            draining.removeAll { $0 === batch }
                            batch.decoding = nil
                        }
                        await previous?.value
                        guard !Task.isCancelled else { return }
                        let boosting = try? await recognizer.prime(next.roster)
                        @MainActor func deliver(_ buffered: Segment) async {
                            var accepted = false
                            defer {
                                daemon.settleSpeech(buffered.speechStartHostUs, revision: batch.revision, accepted: accepted)
                            }
                            do {
                                var segment = buffered
                                var daemonCutoff: Int64?
                                while !Task.isCancelled {
                                    if let cutoff = daemonCutoff ?? batch.releasedAt, segment.endedAt > cutoff {
                                        guard let clipped = segment.through(cutoff) else { return }
                                        segment = clipped
                                    }
                                    let words = try await recognizer.transcribe(segment, boosting: daemon.isDictating(segment.speechStartHostUs, revision: batch.revision) ? nil : boosting)
                                    try Task.checkCancellation()
                                    // Key-up may have arrived during this very decode.
                                    if let releasedAt = batch.releasedAt, segment.endedAt > releasedAt { continue }
                                    guard let words else { return }
                                    let (data, http) = try await daemon.postUtterance(revision: batch.revision,
                                        capture: (segment.startedAtHostUs, segment.speechStartHostUs, segment.endedAt),
                                        body: JSONEncoder().encode(words))
                                    try Task.checkCancellation()
                                    // The POST can also beat the key-up directive back to the helper.
                                    if http.value(forHTTPHeaderField: "x-voice-release-revision") == batch.revision,
                                       let cutoff = http.value(forHTTPHeaderField: "x-voice-release-host-ms").flatMap(Int64.init),
                                       segment.endedAt > cutoff {
                                        daemonCutoff = cutoff
                                        continue
                                    }
                                    accepted = try JSONDecoder().decode(Daemon.Acknowledgement.self, from: data).accepted
                                    if !accepted {
                                        fputs("Voice daemon declined an utterance.\n", stderr)
                                    }
                                    return
                                }
                            } catch {
                                if Task.isCancelled { return }
                                fputs("Voice listener dropped one segment.\n", stderr)
                            }
                        }
                        for await segment in segments {
                            if Task.isCancelled { return }
                            await deliver(segment)
                        }
                        guard !Task.isCancelled else { return }
                        let pending = batch.releasedSegments
                        batch.releasedSegments.removeAll()
                        for segment in pending {
                            if Task.isCancelled { return }
                            await deliver(segment)
                        }
                    }
                }
            }
            revision = next.revision
        }
    }
}

@main struct VoiceListener {
    @MainActor static func main() async {
        let listener = Listener()
        do { try await listener.run() }
        catch {
            await listener.daemon.drainSpeechFinishes()
            switch error {
            case CaptureError.listenerInUse: fputs("Another voice listener is active.\n", stderr)
            case CaptureError.device: fputs("The selected microphone input is unavailable.\n", stderr)
            default: fputs("Voice listener stopped. Check the daemon, local models and selected input.\n", stderr)
            }
            exit(1)
        }
    }
}
