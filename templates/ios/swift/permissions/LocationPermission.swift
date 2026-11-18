import CoreLocation

/// 只申请「使用期间」定位。CLLocationManager 的结果走代理回调，所以这里持有一个管理器直到回调。
final class LocationPermission: NSObject, ShellPermission, CLLocationManagerDelegate {
    let name = "location"
    private let manager = CLLocationManager()
    private var pending: ((String) -> Void)?

    override init() {
        super.init()
        self.manager.delegate = self
    }

    private static func state(_ status: CLAuthorizationStatus) -> String {
        switch status {
        case .authorizedAlways, .authorizedWhenInUse: "granted"
        case .denied: "denied"
        case .restricted: "unsupported"
        case .notDetermined: "prompt"
        @unknown default: "prompt"
        }
    }

    func check(_ done: @escaping (String) -> Void) {
        done(Self.state(self.manager.authorizationStatus))
    }

    func request(_ done: @escaping (String) -> Void) {
        self.pending = done
        self.manager.requestWhenInUseAuthorization()
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard manager.authorizationStatus != .notDetermined, let done = self.pending else { return }
        self.pending = nil
        done(Self.state(manager.authorizationStatus))
    }
}
