import UIKit
import WebKit

final class ShellPageRefreshController: NSObject, WKScriptMessageHandler {
    private final class Handler: NSObject, WKScriptMessageHandler {
        weak var owner: ShellPageRefreshController?

        init(owner: ShellPageRefreshController) { self.owner = owner }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            self.owner?.userContentController(controller, didReceive: message)
        }
    }

    static let leaseChanged = Notification.Name("AppShellForegroundLeaseChanged")
    /// 业务扩展在不能被刷新打断的操作期间（如内购进行中）发这个通知，object 为 Bool。
    static let busyChanged = Notification.Name("AppShellRefreshBusyChanged")
    private static let handler = "appshellRefreshPolicy"
    private weak var webView: WKWebView?
    private let control = UIRefreshControl()
    private var loading: NSKeyValueObservation?
    private var lease: NSObjectProtocol?
    private var busyObserver: NSObjectProtocol?
    private var busy = false
    private var leaseHeld = false
    private var livePage = false

    /// blockSelector：页面里出现匹配元素时停用下拉刷新（例如正在进行的实时页面）；nil 表示只看前台租约。
    init(webView: WKWebView, blockSelector: String?) {
        self.webView = webView
        super.init()
        self.control.accessibilityIdentifier = "appshell-pull-refresh"
        self.control.addTarget(self, action: #selector(self.refresh), for: .valueChanged)
        self.updateAvailability()
        webView.configuration.userContentController.add(Handler(owner: self), name: Self.handler)
        if let blockSelector,
           let data = try? JSONSerialization.data(withJSONObject: [blockSelector]),
           let encoded = String(data: data, encoding: .utf8)
        {
            let script = """
            (() => {
              const selector = (\(encoded))[0];
              let previous;
              let scheduled = false;
              const publish = () => {
                scheduled = false;
                const live = !!document.querySelector(selector);
                if (previous === live) return;
                previous = live;
                window.webkit.messageHandlers.appshellRefreshPolicy.postMessage(live);
              };
              new MutationObserver(() => {
                if (!scheduled) { scheduled = true; requestAnimationFrame(publish); }
              }).observe(document.body, { attributes: true, attributeFilter: ['class'], childList: true, subtree: true });
              addEventListener('pageshow', publish);
              publish();
            })();
            """
            webView.configuration.userContentController.addUserScript(
                WKUserScript(source: script, injectionTime: .atDocumentEnd, forMainFrameOnly: true)
            )
        }
        self.loading = webView.observe(\.isLoading, options: [.new]) { [weak self] view, _ in
            if !view.isLoading { self?.control.endRefreshing() }
        }
        self.lease = NotificationCenter.default.addObserver(forName: Self.leaseChanged, object: nil, queue: .main) { [weak self] note in
            self?.leaseHeld = note.object as? Bool ?? false
            self?.updateAvailability()
        }
        self.busyObserver = NotificationCenter.default.addObserver(forName: Self.busyChanged, object: nil, queue: .main) { [weak self] note in
            self?.busy = note.object as? Bool ?? false
            self?.updateAvailability()
        }
    }

    func userContentController(_: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame,
              message.frameInfo.securityOrigin.protocol == "capacitor",
              message.frameInfo.securityOrigin.host == "localhost",
              let live = message.body as? Bool
        else { return }
        self.livePage = live
        self.updateAvailability()
    }

    private func updateAvailability() {
        guard let scroll = self.webView?.scrollView else { return }
        let allowed = !self.leaseHeld && !self.livePage && !self.busy
        self.control.endRefreshing()
        self.control.isEnabled = allowed
        scroll.refreshControl = allowed ? self.control : nil
        scroll.bounces = allowed
        scroll.alwaysBounceVertical = allowed
    }

    @objc private func refresh() {
        guard let webView = self.webView else { return }
        // Respect Web's existing recording/upload and unsaved-change guards before a reload.
        let script = """
        (() => {
          if (document.activeElement?.matches('input,textarea,[contenteditable="true"]')) return false;
          const event = new Event('beforeunload', { cancelable: true });
          return window.dispatchEvent(event) && !event.defaultPrevented;
        })()
        """
        webView.evaluateJavaScript(script) { [weak self] allowed, error in
            guard error == nil, allowed as? Bool == true, self?.control.isEnabled == true else {
                self?.control.endRefreshing()
                return
            }
            webView.reload()
        }
    }

    deinit {
        self.webView?.configuration.userContentController.removeScriptMessageHandler(forName: Self.handler)
        if let lease { NotificationCenter.default.removeObserver(lease) }
        if let busyObserver { NotificationCenter.default.removeObserver(busyObserver) }
    }
}
