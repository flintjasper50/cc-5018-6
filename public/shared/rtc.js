// Thin WebRTC plumbing shared by presenter and viewer.
//
// The presenter publishes exactly one video track. Capture started with
// getDisplayMedia({video:{...}}) is re-constrained at runtime through
// applyConstraints() when the adaptive controller changes resolution or
// frameRate, so the wire format changes - not just CSS.

export const WS_PROTO = location.protocol === 'https:' ? 'wss' : 'ws';

export function wsUrl(params) {
  const q = new URLSearchParams(params);
  return `${WS_PROTO}://${location.host}/ws?${q.toString()}`;
}

export class SignalClient {
  constructor({ role, room, name, onMessage, onOpen, onClose }) {
    this.url = wsUrl({ role, room, name });
    this.onMessage = onMessage;
    this.onOpen = onOpen;
    this.onClose = onClose;
    this.ws = null;
    this.closedByUser = false;
    this.queue = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.addEventListener('open', () => {
        this.onOpen?.();
        for (const msg of this.queue.splice(0)) ws.send(msg);
        resolve();
      });
      ws.addEventListener('message', (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        this.onMessage?.(msg);
      });
      ws.addEventListener('close', () => {
        this.onClose?.({ byUser: this.closedByUser });
      });
      ws.addEventListener('error', () => {
        reject(new Error('signaling socket error'));
      });
    });
  }

  send(obj) {
    const data = JSON.stringify(obj);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(data);
    else this.queue.push(data);
  }

  close() {
    this.closedByUser = true;
    this.ws?.close();
  }
}

export function createPeerConnection(iceServers, handlers = {}) {
  const pc = new RTCPeerConnection({
    iceServers,
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
    iceTransportPolicy: handlers.iceTransportPolicy || 'all',
    encodedInsertableStreams: false,
  });
  pc.addEventListener('icecandidate', (ev) => {
    if (ev.candidate) handlers.onLocalCandidate?.(ev.candidate.toJSON());
  });
  pc.addEventListener('connectionstatechange', () => {
    handlers.onConnectionState?.(pc.connectionState);
  });
  pc.addEventListener('iceconnectionstatechange', () => {
    handlers.onIceState?.(pc.iceConnectionState);
  });
  return pc;
}

// Returns candidate-pair info plus RTT from the selected pair so the viewer can
// distinguish "transport relayed over TURN" from a direct host route.
export async function selectedPair(pc) {
  try {
    const stats = await pc.getStats();
    let pair = null;
    let local = null;
    let remote = null;
    stats.forEach((s) => {
      if (s.type === 'candidate-pair' && s.selected && s.state === 'succeeded') {
        pair = s;
      }
    });
    if (!pair) {
      stats.forEach((s) => {
        if (s.type === 'candidate-pair' && s.state === 'succeeded' && (!pair || s.nominated)) pair = s;
      });
    }
    if (!pair) return null;
    stats.forEach((s) => {
      if (s.id === pair.localCandidateId) local = s;
      if (s.id === pair.remoteCandidateId) remote = s;
    });
    return {
      rttMs: pair.currentRoundTripTime != null ? pair.currentRoundTripTime * 1000 : null,
      availableOutgoingKbps:
        pair.availableOutgoingBitrate != null
          ? pair.availableOutgoingBitrate / 1000
          : null,
      localType: local?.candidateType ?? null,
      remoteType: remote?.candidateType ?? null,
      protocol: local?.protocol ?? null,
      localAddress: local?.address ?? null,
      remoteAddress: remote?.address ?? null,
      relayProtocol: local?.relayProtocol ?? null,
    };
  } catch {
    return null;
  }
}

export function trackSettingsSummary(track) {
  if (!track) return null;
  const s = track.getSettings();
  return {
    width: s.width ?? null,
    height: s.height ?? null,
    frameRate: s.frameRate ?? null,
    displaySurface: s.displaySurface ?? null,
    deviceId: s.deviceId ?? null,
    resizeMode: s.resizeMode ?? null,
  };
}
