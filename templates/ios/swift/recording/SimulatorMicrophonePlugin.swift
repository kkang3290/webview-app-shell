#if DEBUG && targetEnvironment(simulator)
    import AVFAudio
    import Capacitor
    import UIKit
    import WebKit

    /// The iOS simulator's WebKit exposes mock inputs. Use public AVAudioEngine APIs for real input.
    @objc(SimulatorMicrophonePlugin)
    final class SimulatorMicrophonePlugin: CAPPlugin, CAPBridgedPlugin {
        let identifier = "SimulatorMicrophonePlugin"
        let jsName = "SimulatorMicrophone"
        let pluginMethods: [CAPPluginMethod] = [
            CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        ]
        private let queue = DispatchQueue(label: "org.appshell.microphone")
        private var engine: AVAudioEngine?
        private var leases = Set<String>()
        private var generation = UUID().uuidString
        private var frames = 0
        private var peak: Float = 0
        private var observers: [NSObjectProtocol] = []
        private var navigation: NSKeyValueObservation?
        private var lifecycle = 0

        override func load() {
            self.navigation = self.webView?.observe(\.isLoading, options: [.new]) { [weak self] view, _ in
                if view.isLoading { self?.resetCapture() }
            }
            for name in [UIApplication.didEnterBackgroundNotification, AVAudioSession.interruptionNotification] {
                self.observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
                    if name == AVAudioSession.interruptionNotification {
                        guard (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt) == AVAudioSession.InterruptionType.began.rawValue,
                              !(note.userInfo?[AVAudioSessionInterruptionWasSuspendedKey] as? Bool ?? false) else { return }
                    }
                    self?.resetCapture()
                })
            }
        }

        @objc func start(_ call: CAPPluginCall) {
            self.queue.async {
                let lifecycle = self.lifecycle
                AVAudioApplication.requestRecordPermission { granted in
                    self.queue.async {
                        guard lifecycle == self.lifecycle else { call.reject("Capture was cancelled", "AbortError"); return }
                        guard granted else { call.reject("Microphone permission denied", "NotAllowedError"); return }
                        do {
                            if self.engine == nil { try self.begin() }
                            let id = UUID().uuidString
                            self.leases.insert(id)
                            call.resolve(["lease": id, "generation": self.generation, "label": "模拟器原生麦克风"])
                        } catch {
                            self.end()
                            call.reject("Native microphone could not start: \(error.localizedDescription)", "NotReadableError")
                        }
                    }
                }
            }
        }

        @objc func stop(_ call: CAPPluginCall) {
            let id = call.getString("lease") ?? ""
            self.queue.async {
                self.leases.remove(id)
                if self.leases.isEmpty { self.end() }
                call.resolve()
            }
        }

        @objc func status(_ call: CAPPluginCall) {
            self.queue.async {
                call.resolve(["frames": self.frames, "peak": self.peak, "leases": self.leases.count])
            }
        }

        private func begin() throws {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker])
            try session.setActive(true)
            let engine = AVAudioEngine()
            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0, format.channelCount > 0 else {
                throw NSError(domain: "AppShellMicrophone", code: 1, userInfo: [NSLocalizedDescriptionKey: "No audio input"])
            }
            self.generation = UUID().uuidString
            self.frames = 0
            self.peak = 0
            let generation = self.generation
            input.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak self] buffer, _ in
                guard let channels = buffer.floatChannelData else { return }
                let count = Int(buffer.frameLength)
                var samples = [Float](repeating: 0, count: count)
                for channel in 0 ..< Int(buffer.format.channelCount) {
                    for index in 0 ..< count {
                        samples[index] += channels[channel][index] / Float(buffer.format.channelCount)
                    }
                }
                let peak = samples.reduce(Float(0)) { max($0, abs($1)) }
                let data = samples.withUnsafeBytes { Data($0) }.base64EncodedString()
                self?.queue.async { [weak self] in
                    guard let self, self.engine != nil, self.generation == generation, !self.leases.isEmpty else { return }
                    self.frames += count
                    self.peak = max(self.peak, peak)
                    self.notifyListeners("pcm", data: ["generation": generation, "pcm": data, "sampleRate": format.sampleRate])
                }
            }
            self.engine = engine
            engine.prepare()
            try engine.start()
        }

        private func end() {
            self.engine?.stop()
            self.engine?.inputNode.removeTap(onBus: 0)
            self.engine = nil
            self.generation = UUID().uuidString
        }

        private func resetCapture() {
            self.queue.async {
                self.lifecycle += 1
                if !self.leases.isEmpty { self.notifyListeners("ended", data: ["generation": self.generation]) }
                self.leases.removeAll()
                self.end()
            }
        }

        deinit {
            for observer in self.observers {
                NotificationCenter.default.removeObserver(observer)
            }
            self.engine?.stop()
            self.engine?.inputNode.removeTap(onBus: 0)
        }
    }
#endif
