import Darwin
import Foundation
import Security

enum CaptureError: Error { case device, format, listenerInUse }

struct Directive: Decodable {
    let revision: String
    let capture: Bool
    let inputDevice: String
    let roster: [String]
}

struct Hello: Encodable {
    let version = "4.0"
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
    private let speechInstance: String?
    private let captureLockPath: String
    private var captureOffset: Int64?
    private var captureLock: Int32 = -1
    private lazy var session = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: nil)

    override init() {
        let env = ProcessInfo.processInfo.environment
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

    private enum ServiceError: Error { case unavailable }

    func request(_ route: String, revision: String? = nil, capture: CaptureTimes? = nil, body: Data? = nil) async throws -> Response {
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
        if (response as? HTTPURLResponse)?.statusCode == 409,
           (try? JSONDecoder().decode([String: String].self, from: data))?["error"] == "listener_in_use" {
            throw CaptureError.listenerInUse
        }
        if (response as? HTTPURLResponse)?.statusCode == 503 { throw ServiceError.unavailable }
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { throw URLError(.badServerResponse) }
        return (data, http)
    }

    func directive(revision: String?, microphonePaused: Bool) async throws -> Response {
        var backoff = 100
        while true {
            try Task.checkCancellation()
            do { return try await request("voice/listener/directive", revision: revision) }
            catch ServiceError.unavailable where microphonePaused {
                try await Task.sleep(for: .milliseconds(backoff))
                backoff = min(2000, backoff * 2)
            }
        }
    }

    func postUtterance(revision: String, capture: CaptureTimes, body: Data) async throws -> Response {
        try await Self.postWithHeldRetries(revision: revision) {
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

@MainActor private final class Capture {
    let revision: String
    var mic: Microphone?
    var decoding: Task<Void, Never>?
    var releasedAt: Int64?
    var releasedSegments: [Segment] = []
    var onInputClosed: (() -> Void)?

    init(_ revision: String) { self.revision = revision }

    func release(at time: Int64) {
        guard releasedAt == nil else { return }
        releasedAt = time
        mic?.whenCaptured(through: time) { [weak self] in
            guard let self, let mic else { return }
            releasedSegments = mic.stop(releasedAt: time)
            self.mic = nil
            onInputClosed?()
            onInputClosed = nil
        }
    }

    func cancel() {
        onInputClosed = nil
        decoding?.cancel()
        mic?.stop()
        mic = nil
        releasedSegments.removeAll()
    }
}

@MainActor final class Listener {
    let daemon = Daemon()
    var recognizer: Recognizer?
    private var current: Capture?
    private var draining: [Capture] = []
    private var directivePoll: Task<Daemon.Response, Error>?
    private var pendingHello: Task<Void, Error>?

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
        let status = permission()
        if status != "granted" { close() }
        if first && status == "not-determined" {
            fputs("Microphone access is undetermined for the launching app. Run the listener from a terminal app that already has microphone access.\n", stderr)
        }
        let body = Hello(modelLoaded: recognizer != nil, primingAvailable: recognizer?.ctc != nil, microphone: status)
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
        try await hello()
        let heartbeat = Task {
            while !Task.isCancelled {
                try await Task.sleep(for: .seconds(10))
                do { try await hello() }
                catch { close(); exit(1) }
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
            let capture = next.capture && permission() == "granted"
            if next.revision != revision || capture != (current?.mic?.isRunning == true) {
                let releasedRevision = http.value(forHTTPHeaderField: "x-voice-release-revision")
                var allowed = Set((http.value(forHTTPHeaderField: "x-voice-draining-revisions") ?? "")
                    .split(separator: ",").map(String.init))
                if let releasedRevision { allowed.insert(releasedRevision) }
                draining.removeAll { previous in
                    if allowed.contains(previous.revision) && permission() == "granted" { return false }
                    previous.cancel()
                    return true
                }
                if let current, permission() == "granted", releasedRevision == current.revision,
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
                    let held = http.value(forHTTPHeaderField: "x-voice-held-revision") == next.revision
                    let batch = Capture(next.revision)
                    let microphone = try Microphone(selection: next.inputDevice, held: held, onStopped: { [weak self] stopped in
                        guard let self, self.current?.mic === stopped else { return }
                        self.current?.cancel()
                        self.current = nil
                        self.directivePoll?.cancel()
                    })
                    batch.mic = microphone
                    current = batch
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
                            do {
                                var segment = buffered
                                var daemonCutoff: Int64?
                                while !Task.isCancelled {
                                    if let cutoff = daemonCutoff ?? batch.releasedAt, segment.endedAt > cutoff {
                                        guard let clipped = segment.through(cutoff) else { return }
                                        segment = clipped
                                    }
                                    let words = try await recognizer.transcribe(segment, boosting: boosting)
                                    try Task.checkCancellation()
                                    // Key-up may have arrived during this very decode.
                                    if let releasedAt = batch.releasedAt, segment.endedAt > releasedAt { continue }
                                    guard let words else { return }
                                    let (data, http) = try await daemon.postUtterance(revision: next.revision,
                                        capture: (segment.startedAtHostUs, segment.speechStartHostUs, segment.endedAt),
                                        body: JSONEncoder().encode(words))
                                    try Task.checkCancellation()
                                    // The POST can also beat the key-up directive back to the helper.
                                    if http.value(forHTTPHeaderField: "x-voice-release-revision") == next.revision,
                                       let cutoff = http.value(forHTTPHeaderField: "x-voice-release-host-ms").flatMap(Int64.init),
                                       segment.endedAt > cutoff {
                                        daemonCutoff = cutoff
                                        continue
                                    }
                                    if try !JSONDecoder().decode(Daemon.Acknowledgement.self, from: data).accepted {
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
        do { try await Listener().run() }
        catch CaptureError.listenerInUse { fputs("Another voice listener is active.\n", stderr); exit(1) }
        catch CaptureError.device { fputs("The selected microphone input is unavailable.\n", stderr); exit(1) }
        catch { fputs("Voice listener stopped. Check the daemon, local models and selected input.\n", stderr); exit(1) }
    }
}
