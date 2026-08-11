function turnTransport(url) {
  const explicit = /[?&]transport=(udp|tcp)(?:&|$)/i.exec(url)?.[1]?.toLowerCase();
  if (explicit) return explicit;
  return /^turns:/i.test(url) ? "tls" : "udp";
}

function turnTargets(configuration) {
  if (configuration?.mode !== "turn_configured" || !Array.isArray(configuration.iceServers)) {
    return [];
  }
  return configuration.iceServers.flatMap((server) => {
    if (
      typeof server?.username !== "string"
      || typeof server?.credential !== "string"
      || !Array.isArray(server?.urls)
    ) return [];
    return server.urls
      .filter((url) => typeof url === "string" && /^turns?:/i.test(url))
      .map((url) => ({
        credential: server.credential,
        requestedTransport: turnTransport(url),
        url,
        username: server.username,
      }));
  });
}

function freezeProbe(value) {
  return Object.freeze({
    ...value,
    candidates: Object.freeze(value.candidates.map((candidate) => Object.freeze(candidate))),
  });
}

async function gatherRelayCandidates(target, {
  RTCPeerConnectionImpl,
  clearTimeoutImpl,
  setTimeoutImpl,
  signal,
  timeoutMs,
}) {
  let peer = null;
  let timer = null;
  let settled = false;
  let resolveDone;
  const candidates = [];
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  const finish = (completion, reason = null) => {
    if (settled) return;
    settled = true;
    if (timer !== null) clearTimeoutImpl(timer);
    signal?.removeEventListener("abort", onAbort);
    const gatheringState = peer?.iceGatheringState || "unknown";
    if (peer) {
      peer.onicecandidate = null;
      peer.close();
    }
    resolveDone(freezeProbe({
      candidates,
      completion,
      gatheringState,
      reachable: candidates.length > 0,
      reason,
      requestedTransport: target.requestedTransport,
      url: target.url,
    }));
  };
  const onAbort = () => finish("aborted", "probe_aborted");

  if (signal?.aborted) {
    finish("aborted", "probe_aborted");
    return done;
  }

  try {
    peer = new RTCPeerConnectionImpl({
      iceServers: [{
        credential: target.credential,
        urls: [target.url],
        username: target.username,
      }],
      iceTransportPolicy: "relay",
    });
    peer.onicecandidate = (event) => {
      if (event.candidate === null) {
        finish("complete");
        return;
      }
      const candidate = event.candidate;
      if (candidate?.type !== "relay") return;
      candidates.push({
        protocol: candidate.protocol || null,
        relayProtocol: candidate.relayProtocol || null,
        type: "relay",
      });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeoutImpl(() => finish("timeout", "ice_gathering_timeout"), timeoutMs);
    peer.createDataChannel("reme-turn-probe");
    const offer = await peer.createOffer();
    if (signal?.aborted) {
      finish("aborted", "probe_aborted");
    } else {
      await peer.setLocalDescription(offer);
    }
  } catch (error) {
    finish("error", error instanceof Error ? error.message : String(error));
  }
  return done;
}

export async function probeRtcRelayCandidates(configuration, {
  RTCPeerConnectionImpl = globalThis.RTCPeerConnection,
  clearTimeoutImpl = globalThis.clearTimeout,
  setTimeoutImpl = globalThis.setTimeout,
  signal,
  timeoutMs = 12_000,
} = {}) {
  const targets = turnTargets(configuration);
  if (targets.length === 0) {
    return Object.freeze({
      allReachable: false,
      status: "not_configured",
      transports: Object.freeze([]),
    });
  }
  if (typeof RTCPeerConnectionImpl !== "function") {
    return Object.freeze({
      allReachable: false,
      status: "unsupported",
      transports: Object.freeze([]),
    });
  }

  const transports = await Promise.all(targets.map((target) => gatherRelayCandidates(target, {
    RTCPeerConnectionImpl,
    clearTimeoutImpl,
    setTimeoutImpl,
    signal,
    timeoutMs,
  })));
  return Object.freeze({
    allReachable: transports.every((transport) => transport.reachable),
    status: signal?.aborted ? "aborted" : "complete",
    transports: Object.freeze(transports),
  });
}
