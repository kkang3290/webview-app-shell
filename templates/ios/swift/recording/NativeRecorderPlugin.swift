import AVFAudio
import Capacitor
import Foundation

/// 原生录音：采集、编码、落盘全在原生侧，锁屏 / 切后台不中断（需要 UIBackgroundModes=audio）。
///
/// WKWebView 进后台后 JS 可能被挂起，所以原生不依赖 Web 实时消费：
/// - 每 chunkMs 产出一段 16 位小端 PCM，先写进会话目录（spool），再在前台时以 `chunk` 事件推给 Web；
/// - Web 回到前台用 readChunks(afterSeq) 补拉漏掉的段，ack(uptoSeq) 之后原生才删除；
/// - 同时写一份完整的 AAC（.m4a）作为本地录音原件。
/// App 被杀后，会话目录还在：listSessions / readChunks / finalize 可以把它找回来。
@objc(NativeRecorderPlugin)
final class NativeRecorderPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "NativeRecorderPlugin"
    let jsName = "NativeRecorder"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pause", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resume", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readChunks", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "ack", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listSessions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "discard", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listInputs", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setInput", returnType: CAPPluginReturnPromise),
    ]

    private let queue = DispatchQueue(label: "org.appshell.native-recorder")
    private var session: RecorderSession?
    private var observers: [NSObjectProtocol] = []

    override func load() {
        let center = NotificationCenter.default
        let audio = AVAudioSession.sharedInstance()
        self.observers = [
            center.addObserver(forName: AVAudioSession.interruptionNotification, object: audio, queue: nil) { [weak self] note in
                self?.queue.async { self?.handleInterruption(note) }
            },
            center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: audio, queue: nil) { [weak self] _ in
                self?.queue.async { self?.restartAfterReset() }
            },
            center.addObserver(forName: AVAudioSession.routeChangeNotification, object: audio, queue: nil) { [weak self] note in
                self?.queue.async { self?.handleRouteChange(note) }
            },
        ]
    }

    deinit {
        self.observers.forEach { NotificationCenter.default.removeObserver($0) }
    }

    // MARK: - Web API

    @objc func start(_ call: CAPPluginCall) {
        guard let chunkMs = call.getInt("chunkMs"), (200 ... 5000).contains(chunkMs) else {
            call.reject("chunkMs must be 200..5000")
            return
        }
        guard let sampleRate = call.getInt("sampleRate"), [8000, 16000, 24000, 48000].contains(sampleRate) else {
            call.reject("sampleRate must be 8000, 16000, 24000 or 48000")
            return
        }
        let label = call.getString("label") ?? ""
        let inputId = call.getString("inputId")
        AVAudioApplication.requestRecordPermission { granted in
            guard granted else {
                call.reject("microphone permission denied", "PERMISSION_DENIED")
                return
            }
            self.queue.async {
                if self.session != nil {
                    call.reject("a recording is already active", "BUSY")
                    return
                }
                do {
                    // 先激活会话、选好输入，再建会话目录：输入无效时不留下空目录。
                    try Self.activateAudioSession()
                    try Self.applyInput(inputId)
                    let session = try RecorderSession.create(
                        root: Self.storageRoot(), sampleRate: Double(sampleRate), chunkMs: chunkMs, label: label
                    ) { [weak self] chunk in self?.emit(chunk) }
                    do {
                        try session.startEngine()
                    } catch {
                        _ = session.finish()
                        try? FileManager.default.removeItem(at: session.directory)
                        throw error
                    }
                    self.session = session
                    self.notifyState("recording", reason: "started")
                    call.resolve(session.describe())
                } catch {
                    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
                    call.reject("unable to start recording: \(error.localizedDescription)", "START_FAILED")
                }
            }
        }
    }

    @objc func pause(_ call: CAPPluginCall) {
        self.queue.async {
            guard let session = self.session else { return call.reject("no active recording", "IDLE") }
            session.pauseEngine()
            self.notifyState("paused", reason: "requested")
            call.resolve(session.describe())
        }
    }

    @objc func resume(_ call: CAPPluginCall) {
        self.queue.async {
            guard let session = self.session else { return call.reject("no active recording", "IDLE") }
            do {
                try Self.activateAudioSession()
                try session.startEngine()
                self.notifyState("recording", reason: "resumed")
                call.resolve(session.describe())
            } catch {
                call.reject("unable to resume: \(error.localizedDescription)", "RESUME_FAILED")
            }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        self.queue.async {
            guard let session = self.session else { return call.reject("no active recording", "IDLE") }
            self.session = nil
            let summary = session.finish()
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            self.notifyState("idle", reason: "stopped")
            call.resolve(summary)
        }
    }

    @objc func getStatus(_ call: CAPPluginCall) {
        self.queue.async {
            var status = self.session?.describe() ?? ["state": "idle"]
            status["microphone"] = Self.microphoneState()
            call.resolve(status)
        }
    }

    @objc func readChunks(_ call: CAPPluginCall) {
        guard let id = call.getString("sessionId"), let after = call.getInt("afterSeq"),
              let limit = call.getInt("limit"), (1 ... 120).contains(limit)
        else {
            call.reject("sessionId, afterSeq and limit (1..120) are required")
            return
        }
        self.queue.async {
            do {
                let directory = try Self.sessionDirectory(id)
                call.resolve(try RecorderSession.readChunks(directory: directory, after: after, limit: limit))
            } catch {
                call.reject(error.localizedDescription, "NOT_FOUND")
            }
        }
    }

    @objc func ack(_ call: CAPPluginCall) {
        guard let id = call.getString("sessionId"), let upto = call.getInt("uptoSeq") else {
            call.reject("sessionId and uptoSeq are required")
            return
        }
        self.queue.async {
            do {
                let removed = try RecorderSession.deleteChunks(directory: try Self.sessionDirectory(id), upto: upto)
                call.resolve(["removed": removed])
            } catch {
                call.reject(error.localizedDescription, "NOT_FOUND")
            }
        }
    }

    @objc func listSessions(_ call: CAPPluginCall) {
        self.queue.async {
            let active = self.session?.id
            let sessions = RecorderSession.list(root: Self.storageRoot()).map { info -> [String: Any] in
                var item = info
                item["active"] = (info["sessionId"] as? String) == active
                return item
            }
            call.resolve(["sessions": sessions])
        }
    }

    @objc func discard(_ call: CAPPluginCall) {
        guard let id = call.getString("sessionId") else { return call.reject("sessionId is required") }
        self.queue.async {
            if self.session?.id == id { return call.reject("stop the recording before discarding it", "BUSY") }
            do {
                try FileManager.default.removeItem(at: try Self.sessionDirectory(id))
                call.resolve()
            } catch {
                call.reject(error.localizedDescription, "NOT_FOUND")
            }
        }
    }

    // MARK: - 输入设备（内置 / 蓝牙 HFP / 有线 / USB）

    @objc func listInputs(_ call: CAPPluginCall) {
        self.queue.async {
            do {
                // availableInputs 需要已设置 playAndRecord 类别；不激活会话，不会打断别的 App。
                try AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .default,
                                                                options: [.mixWithOthers, .allowBluetoothHFP, .defaultToSpeaker])
                call.resolve(["inputs": Self.inputs()])
            } catch {
                call.reject("unable to list inputs: \(error.localizedDescription)")
            }
        }
    }

    @objc func setInput(_ call: CAPPluginCall) {
        let inputId = call.getString("inputId")
        self.queue.async {
            guard let session = self.session else { return call.reject("no active recording", "IDLE") }
            do {
                try Self.applyInput(inputId)
                // 换了输入，硬件格式可能跟着变（蓝牙 HFP 常见 16k/8k），重建采集与转换器。
                if session.isRunning { try session.rebuildEngine() }
                self.notifyState(session.isRunning ? "recording" : "paused", reason: "input-changed")
                call.resolve(["inputs": Self.inputs()])
            } catch {
                call.reject("unable to switch input: \(error.localizedDescription)", "INPUT_FAILED")
            }
        }
    }

    static func inputType(_ port: AVAudioSession.Port) -> String {
        switch port {
        case .builtInMic: "builtin"
        case .bluetoothHFP, .bluetoothLE: "bluetooth"
        case .headsetMic: "wired"
        case .usbAudio: "usb"
        default: "other"
        }
    }

    static func inputs() -> [[String: Any]] {
        let audio = AVAudioSession.sharedInstance()
        let active = Set(audio.currentRoute.inputs.map(\.uid))
        return (audio.availableInputs ?? []).map { port in
            ["id": port.uid, "type": Self.inputType(port.portType), "name": port.portName, "active": active.contains(port.uid)]
        }
    }

    /// nil 表示交还系统默认路由。
    static func applyInput(_ inputId: String?) throws {
        let audio = AVAudioSession.sharedInstance()
        guard let inputId else {
            try audio.setPreferredInput(nil)
            return
        }
        guard let port = audio.availableInputs?.first(where: { $0.uid == inputId }) else {
            throw NSError(domain: "NativeRecorder", code: 6, userInfo: [NSLocalizedDescriptionKey: "unknown input \(inputId)"])
        }
        try audio.setPreferredInput(port)
    }

    // MARK: - 系统事件

    private func handleInterruption(_ note: Notification) {
        guard let session = self.session,
              let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw)
        else { return }
        switch type {
        case .began:
            // 来电、闹钟、其他 App 抢占：系统已经停了输入，这里记账并告知 Web。
            session.markInterrupted()
            self.notifyState("interrupted", reason: "system")
        case .ended:
            let options = (note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt)
                .map(AVAudioSession.InterruptionOptions.init(rawValue:)) ?? []
            guard options.contains(.shouldResume) else {
                self.notifyState("interrupted", reason: "resume-not-allowed")
                return
            }
            do {
                try Self.activateAudioSession()
                try session.startEngine()
                self.notifyState("recording", reason: "interruption-ended")
            } catch {
                self.notifyState("interrupted", reason: "resume-failed")
            }
        @unknown default:
            break
        }
    }

    private func restartAfterReset() {
        guard let session = self.session else { return }
        do {
            try Self.activateAudioSession()
            try session.rebuildEngine()
            self.notifyState("recording", reason: "media-services-reset")
        } catch {
            session.markInterrupted()
            self.notifyState("interrupted", reason: "media-services-reset")
        }
    }

    private func handleRouteChange(_ note: Notification) {
        // 设备增减时把新的输入列表推给 Web，界面据此刷新选择器。
        self.notifyListeners("inputs", data: ["inputs": Self.inputs()])
        // 换耳机 / 拔耳机后输入格式可能变化，重建 tap，采样率转换器跟着重配。
        guard let session = self.session, session.isRunning,
              let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
              let reason = AVAudioSession.RouteChangeReason(rawValue: raw),
              [.newDeviceAvailable, .oldDeviceUnavailable, .override].contains(reason)
        else { return }
        do {
            try session.rebuildEngine()
            self.notifyState("recording", reason: "route-changed")
        } catch {
            session.markInterrupted()
            self.notifyState("interrupted", reason: "route-change-failed")
        }
    }

    // MARK: - 事件

    private func emit(_ chunk: [String: Any]) {
        self.notifyListeners("chunk", data: chunk)
    }

    private func notifyState(_ state: String, reason: String) {
        var data: [String: Any] = ["state": state, "reason": reason]
        if let session = self.session { data["sessionId"] = session.id; data["lastSeq"] = session.lastSeqSnapshot }
        self.notifyListeners("state", data: data)
    }

    // MARK: - 工具

    static func activateAudioSession() throws {
        let audio = AVAudioSession.sharedInstance()
        // playAndRecord + mixWithOthers：不打断用户正在放的音乐，也不被其他 App 的播放顶掉。
        try audio.setCategory(.playAndRecord, mode: .default,
                              options: [.mixWithOthers, .allowBluetoothHFP, .defaultToSpeaker])
        try audio.setActive(true)
    }

    static func microphoneState() -> String {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: "granted"
        case .undetermined: "prompt"
        case .denied: "denied"
        @unknown default: "unknown"
        }
    }

    static func storageRoot() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("appshell-recordings", isDirectory: true)
    }

    static func sessionDirectory(_ id: String) throws -> URL {
        guard UUID(uuidString: id) != nil else {
            throw NSError(domain: "NativeRecorder", code: 1, userInfo: [NSLocalizedDescriptionKey: "invalid sessionId"])
        }
        let directory = Self.storageRoot().appendingPathComponent(id, isDirectory: true)
        guard FileManager.default.fileExists(atPath: directory.path) else {
            throw NSError(domain: "NativeRecorder", code: 2, userInfo: [NSLocalizedDescriptionKey: "unknown session \(id)"])
        }
        return directory
    }
}

/// 一次录音会话。所有方法只在插件的串行队列上调用；tap 回调在音频线程，只做转换后再派回队列。
final class RecorderSession {
    let id: String
    let directory: URL
    private let sampleRate: Double
    private let chunkFrames: AVAudioFrameCount
    private let label: String
    private let startedAt: Date
    private let onChunk: ([String: Any]) -> Void
    private let queue = DispatchQueue(label: "org.appshell.native-recorder.session")

    private var engine = AVAudioEngine()
    private var converter: AVAudioConverter?
    private let targetFormat: AVAudioFormat
    private var pending = Data()
    private var pendingFrames: AVAudioFrameCount = 0
    private var lastSeq = 0
    private var framesWritten: Int64 = 0
    private var interruptions = 0
    private var archive: AVAudioFile?
    private(set) var isRunning = false

    private init(id: String, directory: URL, sampleRate: Double, chunkMs: Int, label: String,
                 onChunk: @escaping ([String: Any]) -> Void) throws
    {
        self.id = id
        self.directory = directory
        self.sampleRate = sampleRate
        self.chunkFrames = AVAudioFrameCount(sampleRate * Double(chunkMs) / 1000)
        self.label = label
        self.startedAt = Date()
        self.onChunk = onChunk
        guard let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: sampleRate, channels: 1, interleaved: true)
        else { throw NSError(domain: "NativeRecorder", code: 3, userInfo: [NSLocalizedDescriptionKey: "bad target format"]) }
        self.targetFormat = format
        self.archive = try AVAudioFile(
            forWriting: directory.appendingPathComponent("recording.m4a"),
            settings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: sampleRate,
                AVNumberOfChannelsKey: 1,
                AVEncoderBitRateKey: sampleRate >= 24000 ? 64000 : 32000,
            ],
            commonFormat: .pcmFormatInt16, interleaved: true
        )
    }

    static func create(root: URL, sampleRate: Double, chunkMs: Int, label: String,
                       onChunk: @escaping ([String: Any]) -> Void) throws -> RecorderSession
    {
        let id = UUID().uuidString
        let directory = root.appendingPathComponent(id, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        // 录音原件不进 iCloud 备份；数据保护到首次解锁后可读，锁屏时仍能写。
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var mutable = root
        try? mutable.setResourceValues(values)
        try (directory as NSURL).setResourceValue(
            URLFileProtection.completeUntilFirstUserAuthentication, forKey: .fileProtectionKey
        )
        let session = try RecorderSession(id: id, directory: directory, sampleRate: sampleRate, chunkMs: chunkMs,
                                          label: label, onChunk: onChunk)
        try session.writeMeta(state: "recording")
        return session
    }

    /// 计数在会话队列上更新，读也经过它，避免和音频回调竞争。
    func describe() -> [String: Any] {
        self.queue.sync { self.snapshot() }
    }

    var lastSeqSnapshot: Int { self.queue.sync { self.lastSeq } }

    private func snapshot() -> [String: Any] {
        [
            "state": self.isRunning ? "recording" : "paused",
            "sessionId": self.id,
            "lastSeq": self.lastSeq,
            "durationMs": Int(Double(self.framesWritten) / self.sampleRate * 1000),
            "sampleRate": Int(self.sampleRate),
            "interruptions": self.interruptions,
            "filePath": self.directory.appendingPathComponent("recording.m4a").path,
        ]
    }

    func startEngine() throws {
        guard !self.isRunning else { return }
        let input = self.engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else {
            throw NSError(domain: "NativeRecorder", code: 4, userInfo: [NSLocalizedDescriptionKey: "no audio input"])
        }
        self.converter = AVAudioConverter(from: inputFormat, to: self.targetFormat)
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { [weak self] buffer, _ in
            self?.convert(buffer)
        }
        self.engine.prepare()
        try self.engine.start()
        self.isRunning = true
        self.queue.sync { try? self.writeMeta(state: "recording") }
    }

    func pauseEngine() {
        guard self.isRunning else { return }
        self.engine.inputNode.removeTap(onBus: 0)
        self.engine.stop()
        self.isRunning = false
        self.queue.sync {
            self.flush()
            try? self.writeMeta(state: "paused")
        }
    }

    func markInterrupted() {
        self.interruptions += 1
        if self.isRunning {
            self.engine.inputNode.removeTap(onBus: 0)
            self.engine.stop()
            self.isRunning = false
        }
        self.queue.sync {
            self.flush()
            try? self.writeMeta(state: "interrupted")
        }
    }

    func rebuildEngine() throws {
        if self.isRunning {
            self.engine.inputNode.removeTap(onBus: 0)
            self.engine.stop()
            self.isRunning = false
        }
        self.engine = AVAudioEngine()
        try self.startEngine()
    }

    func finish() -> [String: Any] {
        self.pauseEngine()
        // AVAudioFile 释放时才写完 moov；置空让它析构，m4a 才能被播放器打开。
        self.queue.sync {
            self.flush()
            self.archive = nil
            try? self.writeMeta(state: "stopped")
        }
        let path = self.directory.appendingPathComponent("recording.m4a").path
        var summary = self.describe()
        summary["state"] = "stopped"
        summary["filePath"] = path
        return summary
    }

    // 音频线程 → 会话队列：转换成目标格式，凑满一段就落盘并推事件。
    private func convert(_ buffer: AVAudioPCMBuffer) {
        guard let converter = self.converter else { return }
        let ratio = self.targetFormat.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 64
        guard let output = AVAudioPCMBuffer(pcmFormat: self.targetFormat, frameCapacity: capacity) else { return }
        var consumed = false
        var error: NSError?
        converter.convert(to: output, error: &error) { _, status in
            if consumed {
                status.pointee = .noDataNow
                return nil
            }
            consumed = true
            status.pointee = .haveData
            return buffer
        }
        guard error == nil, output.frameLength > 0, let samples = output.int16ChannelData else { return }
        let data = Data(bytes: samples[0], count: Int(output.frameLength) * 2)
        let frames = output.frameLength
        self.queue.async {
            try? self.archive?.write(from: output)
            self.framesWritten += Int64(frames)
            self.pending.append(data)
            self.pendingFrames += frames
            while self.pendingFrames >= self.chunkFrames {
                let bytes = Int(self.chunkFrames) * 2
                self.publish(self.pending.prefix(bytes), frames: self.chunkFrames)
                self.pending.removeFirst(bytes)
                self.pendingFrames -= self.chunkFrames
            }
        }
    }

    private func flush() {
        guard self.pendingFrames > 0 else { return }
        self.publish(self.pending, frames: self.pendingFrames)
        self.pending.removeAll()
        self.pendingFrames = 0
    }

    private func publish(_ pcm: Data, frames: AVAudioFrameCount) {
        self.lastSeq += 1
        let seq = self.lastSeq
        let endFrames = self.framesWritten - Int64(self.pendingFrames) + Int64(frames)
        let durationMs = Int(Double(frames) / self.sampleRate * 1000)
        let startMs = Int(Double(endFrames - Int64(frames)) / self.sampleRate * 1000)
        let file = self.directory.appendingPathComponent(String(format: "chunk-%08d.pcm", seq))
        // 先落盘再推事件：Web 收不到（JS 被挂起）也能事后补拉。
        try? pcm.write(to: file, options: .atomic)
        try? self.writeMeta(state: self.isRunning ? "recording" : "paused")
        self.onChunk([
            "sessionId": self.id, "seq": seq, "startMs": startMs, "durationMs": durationMs,
            "sampleRate": Int(self.sampleRate), "level": Self.level(pcm), "data": pcm.base64EncodedString(),
        ])
    }

    private func writeMeta(state: String) throws {
        let meta: [String: Any] = [
            "sessionId": self.id, "label": self.label, "state": state, "lastSeq": self.lastSeq,
            "sampleRate": Int(self.sampleRate), "startedAt": ISO8601DateFormatter().string(from: self.startedAt),
            "durationMs": Int(Double(self.framesWritten) / self.sampleRate * 1000), "interruptions": self.interruptions,
        ]
        let data = try JSONSerialization.data(withJSONObject: meta)
        try data.write(to: self.directory.appendingPathComponent("session.json"), options: .atomic)
    }

    /// 峰值电平 0..1，给 Web 做「是否真在收音」的提示，不用解码 PCM。
    static func level(_ pcm: Data) -> Double {
        var peak: Int32 = 0
        pcm.withUnsafeBytes { raw in
            for sample in raw.bindMemory(to: Int16.self) { peak = max(peak, abs(Int32(sample))) }
        }
        return (Double(peak) / 32768 * 1000).rounded() / 1000
    }

    static func readChunks(directory: URL, after: Int, limit: Int) throws -> [String: Any] {
        let meta = try Self.meta(directory)
        let sampleRate = meta["sampleRate"] as? Int ?? 0
        var chunks: [[String: Any]] = []
        var seq = after + 1
        let lastSeq = meta["lastSeq"] as? Int ?? 0
        while seq <= lastSeq, chunks.count < limit {
            let file = directory.appendingPathComponent(String(format: "chunk-%08d.pcm", seq))
            if let pcm = try? Data(contentsOf: file) {
                chunks.append(["seq": seq, "sampleRate": sampleRate, "level": Self.level(pcm), "data": pcm.base64EncodedString()])
            }
            seq += 1
        }
        return ["sessionId": directory.lastPathComponent, "lastSeq": lastSeq, "chunks": chunks,
                "hasMore": seq <= lastSeq]
    }

    static func deleteChunks(directory: URL, upto: Int) throws -> Int {
        var removed = 0
        for name in try FileManager.default.contentsOfDirectory(atPath: directory.path)
            where name.hasPrefix("chunk-") && name.hasSuffix(".pcm")
        {
            if let seq = Int(name.dropFirst(6).dropLast(4)), seq <= upto {
                try FileManager.default.removeItem(at: directory.appendingPathComponent(name))
                removed += 1
            }
        }
        return removed
    }

    static func list(root: URL) -> [[String: Any]] {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: root.path) else { return [] }
        return names.compactMap { name in
            let directory = root.appendingPathComponent(name, isDirectory: true)
            guard var meta = try? Self.meta(directory) else { return nil }
            meta["filePath"] = directory.appendingPathComponent("recording.m4a").path
            return meta
        }
    }

    private static func meta(_ directory: URL) throws -> [String: Any] {
        let data = try Data(contentsOf: directory.appendingPathComponent("session.json"))
        guard let meta = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw NSError(domain: "NativeRecorder", code: 5, userInfo: [NSLocalizedDescriptionKey: "bad session.json"])
        }
        return meta
    }
}
