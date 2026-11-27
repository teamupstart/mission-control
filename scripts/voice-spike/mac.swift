import Foundation
import AppKit
import AVFoundation
import CoreAudio
import Carbon

func emit(_ row: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: row, options: [.sortedKeys])
    print(String(data: data, encoding: .utf8)!); fflush(stdout)
}
func address(_ selector: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
}
func numbers(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) throws -> [UInt32] {
    var a = address(selector, scope); var size: UInt32 = 0
    var status = AudioObjectGetPropertyDataSize(id, &a, 0, nil, &size)
    guard status == 0 else { throw NSError(domain: "CoreAudio", code: Int(status)) }
    if size == 0 { return [] }
    var result = [UInt32](repeating: 0, count: Int(size) / 4)
    status = result.withUnsafeMutableBytes { AudioObjectGetPropertyData(id, &a, 0, nil, &size, $0.baseAddress!) }
    guard status == 0 else { throw NSError(domain: "CoreAudio", code: Int(status)) }
    return result
}
func label(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String {
    var a = address(selector); var value: CFString = "" as CFString
    var size = UInt32(MemoryLayout<CFString>.size)
    let status = withUnsafeMutablePointer(to: &value) { AudioObjectGetPropertyData(id, &a, 0, nil, &size, $0) }
    return status == 0 ? value as String : "error:\(status)"
}
let args = CommandLine.arguments
let mode = args.count > 1 ? args[1] : "launch"
if mode == "launch" {
    let log = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent(Bundle.main.bundleURL.lastPathComponent + ".log")
    FileManager.default.createFile(atPath: log.path, contents: nil)
    let handle = try FileHandle(forWritingTo: log)
    let child = Process(); child.executableURL = Bundle.main.executableURL!.deletingLastPathComponent().appendingPathComponent("helper")
    child.arguments = args.count > 2 ? Array(args.dropFirst(2)) : ["capture"]
    child.standardOutput = handle; child.standardError = handle
    try child.run(); child.waitUntilExit()
    try handle.write(contentsOf: Data("helperExit=\(child.terminationStatus) reason=\(child.terminationReason.rawValue)\n".utf8))
} else if mode == "capture" || mode == "feedback" {
    emit(["authorizationBefore": AVCaptureDevice.authorizationStatus(for: .audio).rawValue, "pid": getpid()])
    var answered = false; var granted = false
    AVCaptureDevice.requestAccess(for: .audio) { yes in granted = yes; answered = true }
    while !answered { RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05)) }
    emit(["granted": granted, "authorizationAfter": AVCaptureDevice.authorizationStatus(for: .audio).rawValue])
    guard granted else { exit(2) }
    if mode == "feedback" {
        do { try feedback(probe: args[2], models: args[3]); exit(0) }
        catch { emit(["feedbackError": String(describing: error)]); exit(5) }
    }
    let engine = AVAudioEngine(); let input = engine.inputNode
    let lock = NSLock()
    var frames: AVAudioFrameCount = 0; var peak: Float = 0
    input.installTap(onBus: 0, bufferSize: 1024, format: nil) { buffer, _ in
        lock.lock(); defer { lock.unlock() }
        frames += buffer.frameLength
        if let samples = buffer.floatChannelData?[0] { for i in 0..<Int(buffer.frameLength) { peak = max(peak, abs(samples[i])) } }
    }
    do { try engine.start(); RunLoop.current.run(until: Date(timeIntervalSinceNow: args.count > 2 ? Double(args[2]) ?? 3 : 3)); engine.stop(); input.removeTap(onBus: 0)
        lock.lock(); defer { lock.unlock() }
        emit(["frames": frames, "peak": peak, "sampleRate": input.outputFormat(forBus: 0).sampleRate])
    } catch { emit(["captureError": String(describing: error)]); exit(3) }
} else if mode == "hotkey" || mode == "hotkey-selftest" {
    let app = NSApplication.shared; app.setActivationPolicy(.accessory)
    var types = [EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed)), EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyReleased))]
    let handler: EventHandlerUPP = { _, event, _ in
        var id = EventHotKeyID()
        let status = GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil, MemoryLayout<EventHotKeyID>.size, nil, &id)
        emit(["event": GetEventKind(event) == UInt32(kEventHotKeyPressed) ? "press" : "release", "id": id.id, "status": status, "uptime": ProcessInfo.processInfo.systemUptime]); return noErr
    }
    var installed: EventHandlerRef?
    emit(["installStatus": InstallEventHandler(GetApplicationEventTarget(), handler, 2, &types, nil, &installed)])
    var refs = [EventHotKeyRef?](repeating: nil, count: 2)
    for i in 0..<2 {
        let modifiers = UInt32(controlKey | cmdKey | (i == 1 ? optionKey : 0))
        let status = RegisterEventHotKey(UInt32(kVK_ANSI_V), modifiers, EventHotKeyID(signature: 0x5653504b, id: UInt32(i+1)), GetApplicationEventTarget(), 0, &refs[i])
        emit(["registerStatus": status, "id": i+1, "chord": i == 0 ? "Control+Command+V" : "Control+Command+Option+V"])
    }
    // RunLoop alone services sources but does not dispatch queued application events.
    if mode == "hotkey-selftest" {
        // Only tests our dispatch loop. These are queued Carbon events, not physical keys.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            for kind in [kEventHotKeyPressed, kEventHotKeyReleased] {
                var event: EventRef?
                let created = CreateEvent(nil, OSType(kEventClassKeyboard), UInt32(kind), 0, EventAttributes(kEventAttributeNone), &event)
                if let event {
                    var id = EventHotKeyID(signature: 0x5653504b, id: 1)
                    let parameter = SetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), MemoryLayout<EventHotKeyID>.size, &id)
                    let queued = PostEventToQueue(GetMainEventQueue(), event, EventPriority(kEventPriorityStandard))
                    emit(["selfTestCreate": created, "parameter": parameter, "queue": queued])
                    ReleaseEvent(event)
                }
            }
        }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + (mode == "hotkey-selftest" ? 1 : 30)) {
        app.stop(nil)
        if let wake = NSEvent.otherEvent(with: .applicationDefined, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: 0, context: nil, subtype: 0, data1: 0, data2: 0) {
            app.postEvent(wake, atStart: false)
        }
    }
    app.run()
    for ref in refs { if let ref { UnregisterEventHotKey(ref) } }
} else if mode == "calls" {
    let ignored = Set(args.dropFirst(2).compactMap { UInt32($0) } + [UInt32(getpid())])
    let polls = Int(ProcessInfo.processInfo.environment["SPIKE_POLLS"] ?? "60") ?? 60
    for _ in 0..<polls {
        let start = ProcessInfo.processInfo.systemUptime
        do {
            let ids = try numbers(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyProcessObjectList)
            var active: [[String: Any]] = []
            var staleObjects = 0
            for id in ids {
                do {
                    let pid = try numbers(id, kAudioProcessPropertyPID).first ?? 0
                    if try numbers(id, kAudioProcessPropertyIsRunningInput).first == 1 {
                        active.append(["pid": pid, "bundle": label(id, kAudioProcessPropertyBundleID), "ignored": ignored.contains(pid)])
                    }
                } catch let error as NSError where error.domain == "CoreAudio" && error.code == Int(kAudioHardwareBadObjectError) {
                    // Processes can exit between enumeration and the per-object read.
                    staleObjects += 1
                }
            }
            emit(["inputProcesses": active, "staleObjects": staleObjects, "stage": ProcessInfo.processInfo.environment["SPIKE_STAGE"] ?? "unlabeled", "pollMs": (ProcessInfo.processInfo.systemUptime-start)*1000, "time": ISO8601DateFormatter().string(from: Date())])
        } catch { emit(["error": String(describing: error)]); exit(4) }
        Thread.sleep(forTimeInterval: 0.5)
    }
} else if mode == "devices" {
    for id in try numbers(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDevices) {
        let streams = try numbers(id, kAudioDevicePropertyStreams, kAudioDevicePropertyScopeInput)
        if !streams.isEmpty {
            let transport = try numbers(id, kAudioDevicePropertyTransportType).first!
            emit(["name": label(id, kAudioObjectPropertyName), "uid": label(id, kAudioDevicePropertyDeviceUID), "transport": transport, "builtIn": transport == kAudioDeviceTransportTypeBuiltIn, "bluetooth": transport == kAudioDeviceTransportTypeBluetooth || transport == kAudioDeviceTransportTypeBluetoothLE, "inputStreams": streams.count])
        }
    }
} else { fatalError("Unknown mode") }

// Only the synthetic playback comparison uses samples. They travel through an anonymous
// pipe to the local recognizer, never a recording file or an external service.
func feedback(probe: String, models: String) throws {
    let engine = AVAudioEngine(); let input = engine.inputNode
    let rate = input.outputFormat(forBus: 0).sampleRate
    let lock = NSLock(); var samples: [Float] = []
    func start() throws {
        lock.lock(); samples = []; lock.unlock()
        input.installTap(onBus: 0, bufferSize: 1024, format: nil) { buffer, _ in
            guard let data = buffer.floatChannelData?[0] else { return }
            lock.lock(); samples.append(contentsOf: UnsafeBufferPointer(start: data, count: Int(buffer.frameLength))); lock.unlock()
        }
        do { try engine.start() } catch { input.removeTap(onBus: 0); throw error }
    }
    func stop() -> [Float] {
        engine.stop(); input.removeTap(onBus: 0)
        lock.lock(); defer { lock.unlock() }; return samples
    }
    var clips: [[String: Any]] = []
    func retain(_ id: String, _ audio: [Float], _ extra: [String: Any] = [:]) {
        let rms = audio.isEmpty ? 0 : sqrt(audio.reduce(0.0) { $0 + Double($1) * Double($1) } / Double(audio.count))
        emit(extra.merging(["feedback": id, "frames": audio.count, "sampleRate": rate, "rms": rms]) { _, new in new })
        clips.append(["id": id, "sampleRate": rate, "samples": audio])
    }
    try start(); Thread.sleep(forTimeInterval: 2); retain("quiet", stop())
    for trial in 1...3 {
        for policy in ["listening", "paused-0ms", "paused-250ms"] {
            // Establish capture, then actually stop it before speech in paused trials.
            try start(); Thread.sleep(forTimeInterval: 0.2)
            if policy != "listening" { _ = stop() }
            let say = Process(); say.executableURL = URL(fileURLWithPath: "/usr/bin/say")
            say.arguments = ["-v", "Samantha", "-r", "180", "Will, check the build. Steve, run the tests."]
            let startTime = ProcessInfo.processInfo.systemUptime
            try say.run(); say.waitUntilExit()
            guard say.terminationStatus == 0 else { throw NSError(domain: "say", code: Int(say.terminationStatus)) }
            let ended = ProcessInfo.processInfo.systemUptime
            if policy != "listening" {
                if policy == "paused-250ms" { Thread.sleep(forTimeInterval: 0.25) }
                try start()
            }
            let resumed = ProcessInfo.processInfo.systemUptime
            Thread.sleep(forTimeInterval: 2)
            retain("\(policy)-\(trial)", stop(), ["playbackMs": (ended-startTime)*1000, "restartAfterSayMs": (resumed-ended)*1000, "captureDuringPlayback": policy == "listening"])
        }
    }
    let recognizer = Process(); let pipe = Pipe()
    recognizer.executableURL = URL(fileURLWithPath: probe); recognizer.arguments = [models, "--stdin-samples"]
    recognizer.standardInput = pipe; try recognizer.run()
    for clip in clips {
        var data = try JSONSerialization.data(withJSONObject: clip); data.append(10)
        try pipe.fileHandleForWriting.write(contentsOf: data)
    }
    try pipe.fileHandleForWriting.close(); recognizer.waitUntilExit()
    emit(["recognizerExit": recognizer.terminationStatus])
    guard recognizer.terminationStatus == 0 else { throw NSError(domain: "recognizer", code: Int(recognizer.terminationStatus)) }
}
