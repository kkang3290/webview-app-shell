// Debug simulator adapter only. PCM comes from AVAudioEngine, never from a synthetic source.
(() => {
  const devices = navigator.mediaDevices;
  if (!devices?.getUserMedia || !window.Capacitor?.Plugins?.SimulatorMicrophone) return;
  // Keep subsequent Web module lookups on the same patched MediaDevices instance.
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: devices });
  const plugin = window.Capacitor.Plugins.SimulatorMicrophone;
  const original = devices.getUserMedia.bind(devices);
  const enumerate = devices.enumerateDevices.bind(devices);
  const deviceId = 'appshell-simulator-native-microphone';
  devices.enumerateDevices = async () => [
    ...(await enumerate()).filter(device => device.kind !== 'audioinput'),
    { deviceId, groupId: deviceId, kind: 'audioinput', label: '模拟器原生麦克风', toJSON() { return { deviceId, kind: this.kind, label: this.label }; } },
  ];
  devices.getUserMedia = async constraints => {
    if (!constraints?.audio || constraints.video) return original(constraints);
    const requested = constraints.audio?.deviceId?.exact;
    if (requested && requested !== deviceId && requested !== 'default') throw new DOMException('Microphone is unavailable', 'NotFoundError');
    const context = new AudioContext();
    const destination = context.createMediaStreamDestination();
    const tracks = new Set();
    let lease;
    let subscription;
    let ended;
    let closed = false;
    let cursor = 0;
    const scheduled = new Set();
    const cleanup = async () => {
      if (closed) return;
      closed = true;
      for (const source of scheduled) { try { source.stop(); } catch {} source.disconnect(); }
      await subscription?.remove().catch(() => {});
      await ended?.remove().catch(() => {});
      if (lease) await plugin.stop({ lease: lease.lease }).catch(() => {});
      await context.close().catch(() => {});
    };
    try {
      subscription = await plugin.addListener('pcm', event => {
        if (closed || !lease || event.generation !== lease.generation || context.state !== 'running') return;
        const bytes = Uint8Array.from(atob(event.pcm), character => character.charCodeAt(0));
        if (!bytes.length || bytes.length % 4 || bytes.length > 262144 || !Number.isFinite(event.sampleRate)) return;
        const pcm = new Float32Array(bytes.buffer);
        const buffer = context.createBuffer(1, pcm.length, event.sampleRate);
        buffer.copyToChannel(pcm, 0);
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(destination);
        if (cursor < context.currentTime + 0.005 || cursor > context.currentTime + 0.5) cursor = context.currentTime + 0.1;
        scheduled.add(source);
        source.onended = () => { scheduled.delete(source); source.disconnect(); };
        source.start(cursor);
        cursor += buffer.duration;
      });
      ended = await plugin.addListener('ended', event => {
        if (!lease || event.generation !== lease.generation) return;
        for (const track of [...tracks]) { track.stop(); track.dispatchEvent(new Event('ended')); }
        void cleanup();
      });
      await context.resume();
      lease = await plugin.start();
      const wrap = track => {
        tracks.add(track);
        const stop = track.stop.bind(track);
        const clone = track.clone.bind(track);
        const settings = track.getSettings.bind(track);
        Object.defineProperty(track, 'label', { value: lease.label });
        track.getSettings = () => ({ ...settings(), deviceId, groupId: deviceId });
        track.clone = () => wrap(clone());
        track.stop = () => {
          stop();
          tracks.delete(track);
          if (!tracks.size) void cleanup();
        };
        return track;
      };
      destination.stream.getAudioTracks().forEach(wrap);
      destination.stream.clone = () => new MediaStream(destination.stream.getTracks().map(track => track.clone()));
      context.addEventListener('statechange', () => {
        if (!closed && context.state === 'closed') {
          for (const track of tracks) { track.stop(); track.dispatchEvent(new Event('ended')); }
          void cleanup();
        }
      });
      return destination.stream;
    } catch (error) {
      destination.stream.getTracks().forEach(track => track.stop());
      await cleanup();
      if (['NotAllowedError', 'NotFoundError', 'NotReadableError', 'AbortError'].includes(error?.code)) {
        throw new DOMException(error.message, error.code);
      }
      throw error;
    }
  };
})();
