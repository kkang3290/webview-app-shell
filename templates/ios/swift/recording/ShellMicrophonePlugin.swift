import AVFAudio
import Capacitor
import UIKit

/// Reuses the shared shell's permission contract. Background recording is not implemented here.
@objc(ShellMicrophonePlugin)
final class ShellMicrophonePlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "ShellMicrophonePlugin"
    let jsName = "RecordingKeepAlive"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestMicrophone", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestNotifications", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestStorage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSettings", returnType: CAPPluginReturnPromise),
    ]

    private var observers: [NSObjectProtocol] = []
    private var leaseHeld = false
    private var appActive = true
    private var audioInterrupted = false

    /// 录音期间把前后台切换与音频中断告诉页面（recordingLifecycle 事件），页面据此决定暂停、自动续录还是等用户手动继续。
    override func load() {
        DispatchQueue.main.async {
            self.appActive = UIApplication.shared.applicationState == .active
            for name in [UIApplication.willResignActiveNotification, UIApplication.didEnterBackgroundNotification] {
                self.observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                    self?.appActive = false
                    self?.emitLifecycle("background")
                })
            }
            self.observers.append(NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
                self?.appActive = true
                self?.emitLifecycle("foreground")
            })
            self.observers.append(NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
                guard let self, let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                      let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
                guard self.leaseHeld else { return }
                if type == .began {
                    let suspended = note.userInfo?[AVAudioSessionInterruptionWasSuspendedKey] as? Bool ?? false
                    // 「曾被挂起」的通知可能在回到前台后才送达，它不代表此刻有一个仍在进行的新中断。
                    guard self.appActive && !suspended else { return }
                    self.audioInterrupted = true
                    self.emitLifecycle("interrupted")
                } else if self.audioInterrupted {
                    self.audioInterrupted = false
                    let options = AVAudioSession.InterruptionOptions(rawValue: note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0)
                    self.emitLifecycle(options.contains(.shouldResume) ? "resumable" : "manual")
                }
            })
        }
    }

    private func emitLifecycle(_ phase: String) {
        guard self.leaseHeld else { return }
        self.notifyListeners("recordingLifecycle", data: ["phase": phase])
    }

    deinit {
        for observer in self.observers {
            NotificationCenter.default.removeObserver(observer)
        }
    }

    @objc func start(_ call: CAPPluginCall) {
        self.setForegroundLease(true, call)
    }

    @objc func stop(_ call: CAPPluginCall) {
        self.setForegroundLease(false, call)
    }

    private func setForegroundLease(_ held: Bool, _ call: CAPPluginCall) {
        DispatchQueue.main.async {
            // Foreground screen/refresh protection only; this does not promise background capture.
            if !held || !self.leaseHeld { self.audioInterrupted = false }
            self.leaseHeld = held
            // 录音期间把音频会话钉在「可后台采集」的配置上：WebKit 自己也会设，这里保证应用切到后台时会话仍然是活动的录音会话。
            if held, (Bundle.main.object(forInfoDictionaryKey: "UIBackgroundModes") as? [String] ?? []).contains("audio") {
                let session = AVAudioSession.sharedInstance()
                try? session.setCategory(.playAndRecord, mode: .default, options: [.allowBluetooth, .defaultToSpeaker, .mixWithOthers])
                try? session.setActive(true)
            }
            UIApplication.shared.isIdleTimerDisabled = held
            NotificationCenter.default.post(name: ShellPageRefreshController.leaseChanged, object: held)
            call.resolve()
        }
    }

    @objc func getStatus(_ call: CAPPluginCall) {
        DispatchQueue.main.async { call.resolve(self.snapshot()) }
    }

    @objc func requestMicrophone(_ call: CAPPluginCall) {
        AVAudioApplication.requestRecordPermission { granted in
            DispatchQueue.main.async {
                var result = self.snapshot()
                result["outcome"] = granted ? "granted" : "blocked"
                call.resolve(result)
            }
        }
    }

    @objc func requestNotifications(_ call: CAPPluginCall) {
        DispatchQueue.main.async { call.resolve(self.snapshot()) }
    }

    @objc func requestStorage(_ call: CAPPluginCall) {
        DispatchQueue.main.async { call.resolve(self.snapshot()) }
    }

    @objc func openSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let url = URL(string: UIApplication.openSettingsURLString) else {
                call.reject("System settings are unavailable")
                return
            }
            UIApplication.shared.open(url) { opened in
                if opened { call.resolve() }
                else { call.reject("System settings could not be opened") }
            }
        }
    }

    private func snapshot() -> [String: Any] {
        let microphone = switch AVAudioApplication.shared.recordPermission {
        case .granted: "granted"
        case .undetermined: "prompt"
        case .denied: "denied"
        @unknown default: "unknown"
        }
        // 声明了后台音频（ios.backgroundRecording → UIBackgroundModes: audio）时，页面的采集在退到后台、锁屏后继续，
        // 页面据此不再在退后台时主动暂停。
        let modes = Bundle.main.object(forInfoDictionaryKey: "UIBackgroundModes") as? [String] ?? []
        return ["microphone": microphone, "notifications": "unsupported", "storage": "unsupported",
                "appActive": self.appActive, "canResumeRecording": self.appActive && !self.audioInterrupted,
                "backgroundCapture": modes.contains("audio")]
    }
}
