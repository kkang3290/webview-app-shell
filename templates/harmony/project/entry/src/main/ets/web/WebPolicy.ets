import { url } from '@kit.ArkTS';
import { WEB_ORIGIN, WEB_FILES, API_PREFIXES, WebFile } from '../generated/WebBundle';

export function trustedUrl(value: string): boolean {
  try {
    const target = new url.URL(value);
    return target.protocol === 'https:' && target.origin === WEB_ORIGIN && !target.username && !target.password;
  } catch { return false; }
}

export function apiPath(path: string): boolean {
  return API_PREFIXES.some(prefix => path === prefix || path.startsWith(`${prefix}/`));
}

function safePath(value: string): string | null {
  // Validate before URL normalization so encoded traversal, separators and double encoding cannot alias a file.
  const match = /^https:\/\/[^/?#]+([^?#]*)/.exec(value);
  if (!match || /[\\\x00-\x20]/.test(value) || /%(2f|5c|25)/i.test(match[1])) return null;
  try {
    const path = decodeURIComponent(match[1] || '/');
    if (/[\\\x00-\x1f\x7f]/.test(path) || path.split('/').some(part => part === '.' || part === '..')) return null;
    return path;
  } catch { return null; }
}

function resourceResponse(file: WebFile | undefined, code: number, reason: string): WebResourceResponse {
  const response = new WebResourceResponse();
  response.setResponseData(file ? $rawfile(file.resource) : '');
  response.setResponseMimeType(file ? file.mime : 'text/plain');
  response.setResponseEncoding('utf-8');
  response.setResponseCode(code);
  response.setReasonMessage(reason);
  response.setResponseHeader([{ headerKey: 'Cache-Control', headerValue: 'no-store' },
    { headerKey: 'X-Content-Type-Options', headerValue: 'nosniff' }]);
  return response;
}

export function bundleResource(request: WebResourceRequest): WebResourceResponse | null {
  const value = request.getRequestUrl();
  if (!trustedUrl(value)) return null;
  const path = safePath(value);
  if (path === null) return resourceResponse(undefined, 404, 'Not Found');
  if (apiPath(path)) return null;
  if (request.getRequestMethod() !== 'GET' && request.getRequestMethod() !== 'HEAD') {
    return resourceResponse(undefined, 405, 'Method Not Allowed');
  }
  const localPath = path === '/' ? '/index.html' : path;
  let file = WEB_FILES.find(entry => entry.path === localPath);
  // Only main-frame extensionless routes are SPA documents. Missing assets never reach the remote origin.
  if (!file && request.isMainFrame() && !path.endsWith('/') && !path.split('/').pop()?.includes('.')) {
    file = WEB_FILES.find(entry => entry.path === '/index.html');
  }
  if (!file) return resourceResponse(undefined, 404, 'Not Found');
  return resourceResponse(request.getRequestMethod() === 'HEAD' ? undefined : file, 200, 'OK');
}

export function bridgePermission(): string {
  const site = new url.URL(WEB_ORIGIN);
  return '{"javascriptProxyPermission":{"urlPermissionList":[{"scheme":"https","host":' +
    JSON.stringify(site.hostname) + ',"port":' + JSON.stringify(site.port) + ',"path":""}]}}';
}
