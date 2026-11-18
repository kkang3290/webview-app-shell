import environment from '../../env/config'
import { miniProgramWebUrl } from '../../lib/web-path'

Page({
  data: { webViewUrl: '', loadError: false },
  retryUrl: '',
  onLoad(options: { path?: string }) {
    let webViewUrl: string
    try {
      // The navigation query carries encodeURIComponent(path); decode that envelope once.
      // The shared validator still rejects nested traversal/URL encodings. Never accept src/url.
      const incomingPath = options.path === undefined ? undefined : decodeURIComponent(options.path)
      webViewUrl = miniProgramWebUrl(environment.siteOrigin, environment.entryPath, incomingPath)
    } catch {
      // An invalid external launch cannot replace the configured entry or origin.
      webViewUrl = miniProgramWebUrl(environment.siteOrigin, environment.entryPath)
    }
    this.retryUrl = webViewUrl
    this.setData({ webViewUrl, loadError: false })
  },
  onWebLoad() {
    this.setData({ loadError: false })
  },
  onWebError() {
    this.setData({ loadError: true })
  },
  onRetry() {
    this.setData({ webViewUrl: '', loadError: false }, () => {
      this.setData({ webViewUrl: this.retryUrl })
    })
  },
  onShareAppMessage() {
    // Never forward webViewUrl, query parameters, access tokens, or an incoming private path.
    return { title: environment.appName, path: '/pages/web/index' }
  },
})
