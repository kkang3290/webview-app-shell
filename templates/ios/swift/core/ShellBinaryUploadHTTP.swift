import WebKit

/// Capacitor 8 converts File bodies to base64, but sends a plain Blob as an unserializable object.
enum ShellBinaryUploadHTTP {
    static func install(on webView: WKWebView) {
        let script = """
        (() => {
          if (window.Capacitor?.getPlatform() !== 'ios' || !window.CapacitorWebFetch) return;
          const nativeFetch = window.fetch;
          window.fetch = async function(resource, options) {
            const body = options?.body;
            if (body instanceof Blob && !(body instanceof File)) {
              const headers = new Headers(options.headers || (resource instanceof Request ? resource.headers : undefined));
              const type = headers.get('Content-Type') || body.type || 'application/octet-stream';
              // File selects Capacitor's raw binary encoder. Keep signed headers and URL unchanged.
              options.signal?.throwIfAborted();
              // Materialize IndexedDB-backed Blob slices before Capacitor's legacy FileReader conversion.
              const bytes = await body.arrayBuffer();
              options.signal?.throwIfAborted();
              const file = new File([bytes], 'recording-part', { type });
              return nativeFetch.call(this, resource, { ...options, body: file });
            }
            return nativeFetch.call(this, resource, options);
          };
        })();
        """
        webView.configuration.userContentController.addUserScript(
            WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )
    }
}
