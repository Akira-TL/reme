import assert from "node:assert/strict";
import test from "node:test";

import { probeRtcRelayCandidates } from "./rtcRelayProbe.js";

const configuration = Object.freeze({
  mode: "turn_configured",
  iceServers: Object.freeze([
    Object.freeze({ urls: Object.freeze(["stun:turn.example:3478"]) }),
    Object.freeze({
      urls: Object.freeze([
        "turn:turn.example:3478?transport=udp",
        "turn:turn.example:3478?transport=tcp",
      ]),
      username: "expiry:reme-demo",
      credential: "temporary-credential",
    }),
  ]),
});

test("relay probe forces each TURN transport and reports real relay candidates", async () => {
  const instances = [];
  class FakePeerConnection {
    constructor(options) {
      this.options = options;
      this.iceGatheringState = "new";
      this.onicecandidate = null;
      this.closed = false;
      instances.push(this);
    }

    createDataChannel(label) {
      assert.equal(label, "reme-turn-probe");
    }

    async createOffer() {
      return { type: "offer", sdp: "fake-offer" };
    }

    async setLocalDescription() {
      this.iceGatheringState = "gathering";
      const url = this.options.iceServers[0].urls[0];
      queueMicrotask(() => {
        this.onicecandidate?.({
          candidate: {
            protocol: "udp",
            relayProtocol: url.includes("transport=tcp") ? "tcp" : "udp",
            type: "relay",
          },
        });
        this.iceGatheringState = "complete";
        this.onicecandidate?.({ candidate: null });
      });
    }

    close() {
      this.closed = true;
    }
  }

  const result = await probeRtcRelayCandidates(configuration, {
    RTCPeerConnectionImpl: FakePeerConnection,
    timeoutMs: 100,
  });

  assert.equal(result.status, "complete");
  assert.equal(result.allReachable, true);
  assert.deepEqual(result.transports.map((item) => ({
    candidateCount: item.candidates.length,
    completion: item.completion,
    reachable: item.reachable,
    requestedTransport: item.requestedTransport,
    relayProtocol: item.candidates[0]?.relayProtocol,
  })), [
    {
      candidateCount: 1,
      completion: "complete",
      reachable: true,
      requestedTransport: "udp",
      relayProtocol: "udp",
    },
    {
      candidateCount: 1,
      completion: "complete",
      reachable: true,
      requestedTransport: "tcp",
      relayProtocol: "tcp",
    },
  ]);
  assert.equal(instances.length, 2);
  for (const instance of instances) {
    assert.equal(instance.options.iceTransportPolicy, "relay");
    assert.equal(instance.options.iceServers[0].urls.length, 1);
    assert.equal(instance.closed, true);
  }
});

test("relay probe stays unavailable without TURN and fails closed without WebRTC", async () => {
  const localOnly = await probeRtcRelayCandidates({
    mode: "local_network_only",
    iceServers: [],
  });
  assert.deepEqual(localOnly, {
    allReachable: false,
    status: "not_configured",
    transports: [],
  });

  const unsupported = await probeRtcRelayCandidates(configuration, {
    RTCPeerConnectionImpl: undefined,
  });
  assert.deepEqual(unsupported, {
    allReachable: false,
    status: "unsupported",
    transports: [],
  });
});

test("relay probe closes failed peers and exposes no credential in its result", async () => {
  const instances = [];
  class FailingPeerConnection {
    constructor() {
      this.iceGatheringState = "new";
      this.onicecandidate = null;
      this.closed = false;
      instances.push(this);
    }

    createDataChannel() {}

    async createOffer() {
      throw new Error("offer unavailable");
    }

    close() {
      this.closed = true;
    }
  }

  const result = await probeRtcRelayCandidates(configuration, {
    RTCPeerConnectionImpl: FailingPeerConnection,
    timeoutMs: 100,
  });
  assert.equal(result.allReachable, false);
  assert.equal(result.transports.every((item) => item.completion === "error"), true);
  assert.equal(result.transports.every((item) => item.reason === "offer unavailable"), true);
  assert.equal(instances.every((instance) => instance.closed), true);
  assert.equal(JSON.stringify(result).includes("temporary-credential"), false);
});
