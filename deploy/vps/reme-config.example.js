globalThis.__REME_PUBLIC_CONFIG__ = Object.freeze({
  // The repository owner's current unified Backend stays on the Home device
  // when routine JPEGs must remain local.
  perceptionHttpUrl: "http://127.0.0.1:8770",
  perceptionInputWsUrl: "ws://127.0.0.1:8770/ws/camera-input",
  decisionHttpUrl: "http://127.0.0.1:8770",

  // Replace only after the Relay owner publishes a different exact endpoint.
  relayUrl: "https://relay.reme.maniforld.com/",

  // Display metadata only. Never put MIMO_API_KEY or any other credential here.
  mimoModel: "mimo-v2.5",
  mimoConfigured: false,
});
