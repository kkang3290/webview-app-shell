export function shellPlatform(): 'ios' | 'android' | 'desktop' | 'harmony' | 'miniprogram' | 'web'

export interface HarmonyShellInfo {
  protocolVersion: 1
  platform: 'harmony'
  id: string
  name: string
  appVersion: string
  build: number
  siteOrigin: string
  environment: string
  plugins: readonly ('App' | 'Permissions' | 'WebRecording')[]
}
/** Synchronous, origin-validated host identity; undefined outside the trusted Harmony main frame. */
export function harmonyShellInfo(): HarmonyShellInfo | undefined
/** WebRecording manages Web capture leases, not native PCM recording. */
export function webRecordingAvailable(): boolean
export function setWebRecordingState(state: { active: boolean; finishing: boolean }): Promise<void>
export interface WebRecordingInterruption { reason: string }
export function onWebRecordingInterrupted(listener: (event: WebRecordingInterruption) => void): Promise<{ remove(): Promise<void> }>

export interface NativeRecorderChunk {
  seq: number
  sampleRate: number
  /** 峰值电平 0..1 */
  level: number
  /** 16 位单声道 PCM */
  pcm: Int16Array
}

export interface NativeRecorderState {
  state: 'recording' | 'paused' | 'interrupted' | 'idle'
  reason: string
  sessionId?: string
  lastSeq?: number
}

export interface NativeRecordingSummary {
  sessionId: string
  filePath: string
  durationMs: number
  lastSeq: number
  interruptions: number
}

export interface NativeRecordingSessionInfo {
  sessionId: string
  label: string
  state: string
  lastSeq: number
  sampleRate: number
  startedAt: string
  durationMs: number
  interruptions: number
  filePath: string
  active: boolean
}

export interface NativeRecordingController {
  readonly sessionId: string
  readonly deliveredSeq: number
  pause(): Promise<unknown>
  resume(): Promise<unknown>
  stop(): Promise<NativeRecordingSummary>
  setInput(inputId?: string): Promise<{ inputs: NativeInput[] }>
}

export interface NativeInput {
  id: string
  type: 'builtin' | 'bluetooth' | 'wired' | 'usb' | 'other'
  name: string
  active: boolean
}
export function listNativeInputs(): Promise<NativeInput[]>
export function onNativeInputsChanged(callback: (inputs: NativeInput[]) => void): Promise<() => void>

export function nativeRecorderAvailable(): boolean
export function startNativeRecording(options: {
  sampleRate: 8000 | 16000 | 24000 | 48000
  chunkMs: number
  label?: string
  /** listNativeInputs() 返回的 id；不传则用系统默认麦克风 */
  inputId?: string
  onChunk(chunk: NativeRecorderChunk): void | Promise<void>
  onState?(state: NativeRecorderState): void
}): Promise<NativeRecordingController>
export function listNativeRecordings(): Promise<NativeRecordingSessionInfo[]>
export function recoverNativeRecording(sessionId: string, onChunk: (chunk: NativeRecorderChunk) => void | Promise<void>): Promise<number>
export function discardNativeRecording(sessionId: string): Promise<void>

export type ShellPermissionName = 'microphone' | 'camera' | 'notifications' | 'photos' | 'location'
export type ShellPermissionState = 'granted' | 'denied' | 'prompt' | 'unsupported'
export function shellPermissions(): {
  check(names: ShellPermissionName[]): Promise<Partial<Record<ShellPermissionName, ShellPermissionState>>>
  request(names: ShellPermissionName[]): Promise<Partial<Record<ShellPermissionName, ShellPermissionState>>>
  openSettings(): Promise<void>
} | undefined

export interface BackgroundUploadRecord {
  id: string
  method: 'PUT' | 'POST'
  label: string
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  sent: number
  total: number
  attempts: number
  status?: number
  error?: string
  responseHeaders: Record<string, string>
  createdAt: string
  finishedAt?: string
}
export function backgroundUploadAvailable(): boolean
export function enqueueBackgroundUpload(options: {
  id?: string
  url: string
  method: 'PUT' | 'POST'
  /** 必须包含 Content-Type */
  headers: Record<string, string>
  file: { path: string } | { data: string }
  label?: string
}): Promise<BackgroundUploadRecord>
export function listBackgroundUploads(): Promise<BackgroundUploadRecord[]>
export function cancelBackgroundUpload(id: string): Promise<BackgroundUploadRecord>
export function removeBackgroundUpload(id: string): Promise<void>
export function onBackgroundUpload(handlers: {
  onProgress?(event: { id: string; sent: number; total: number }): void
  onState?(record: BackgroundUploadRecord): void
}): Promise<() => void>
export function waitForBackgroundUpload(id: string, options?: { pollMs?: number }): Promise<BackgroundUploadRecord>

export interface PushToken { provider: 'jpush' | 'getui' | 'apns'; token: string; environment?: 'development' | 'production' }
export interface PushNotification { id: string; title: string; body: string; data: Record<string, unknown> }
export function pushAvailable(): boolean
export function registerPush(): Promise<PushToken>
export function getPushToken(): Promise<Partial<PushToken>>
export function unregisterPush(): Promise<void>
export function takeLaunchNotification(): Promise<PushNotification | null>
export function clearNotifications(): Promise<void>
export function setBadge(count: number): Promise<void>
export function onPush(handlers: {
  onToken?(token: PushToken): void
  onReceived?(notification: PushNotification): void
  onOpened?(notification: PushNotification): void
  /** Android 透传消息（极光 / 个推，不弹通知） */
  onMessage?(message: PushNotification): void
}): Promise<() => void>

export type ScreenCaptureState = 'requesting' | 'sharing' | 'stopped' | 'failed' | 'denied'
export interface ScreenCaptureCapabilities {
  platform: 'ios' | 'android' | 'desktop'
  screens: boolean
  windows: boolean
  /** 原生推流协议；空数组 = 由页面自己采集（桌面） */
  stream: 'rtmps'[]
  replay: boolean
  /** 桌面 macOS 屏幕录制授权：granted / denied / not-determined / restricted */
  permission?: string
}
export interface ScreenCaptureStart {
  stream: { url: string }
  lease: { renewUrl: string; publisherId: string; token: string; expiresAt: string }
  replay?: { uploadUrl: string; serverNow: string }
}
export interface ScreenSource {
  id: string
  kind: 'screen' | 'window'
  name: string
  displayId?: string
  bounds?: { x: number; y: number; width: number; height: number }
  scaleFactor?: number
  primary?: boolean
  thumbnail?: string
  icon?: string
}
export function screenCaptureAvailable(): boolean
export function screenCaptureCapabilities(): Promise<ScreenCaptureCapabilities | null>
export function startScreenCapture(options: ScreenCaptureStart): Promise<{ state: ScreenCaptureState }>
export function stopScreenCapture(): Promise<{ state: ScreenCaptureState }>
export function screenCaptureState(): Promise<{ state: ScreenCaptureState }>
export function onScreenCaptureState(callback: (state: ScreenCaptureState) => void): Promise<() => void>
export function listScreenSources(options?: { types?: ('screen' | 'window')[]; thumbnailWidth?: number; icons?: boolean }): Promise<ScreenSource[]>
export function snapshotScreenSource(sourceId: string, options?: { maxWidth?: number; quality?: number }): Promise<{ image: string; width: number; height: number }>
export function captureScreenSource(sourceId: string, constraints?: DisplayMediaStreamOptions): Promise<MediaStream>
