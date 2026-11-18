import AVFoundation

struct CameraPermission: ShellPermission {
    let name = "camera"

    func check(_ done: @escaping (String) -> Void) {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: done("granted")
        case .denied: done("denied")
        case .restricted: done("unsupported")
        case .notDetermined: done("prompt")
        @unknown default: done("prompt")
        }
    }

    func request(_ done: @escaping (String) -> Void) {
        AVCaptureDevice.requestAccess(for: .video) { done($0 ? "granted" : "denied") }
    }
}
