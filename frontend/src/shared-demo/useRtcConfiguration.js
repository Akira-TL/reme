import { useEffect, useState } from "react";
import { fetchRtcConfiguration } from "./rtcConfig.js";

const FALLBACK = Object.freeze({
  iceServers: Object.freeze([]),
  expiresAtMs: 0,
  capability: "unavailable",
});

export function useRtcConfiguration() {
  const [state, setState] = useState(() => ({
    configuration: FALLBACK,
    error: null,
  }));

  useEffect(() => {
    let active = true;
    let refreshTimer = 0;

    async function load() {
      try {
        const configuration = await fetchRtcConfiguration();
        if (!active) return;
        setState({ configuration, error: null });
        const refreshInMs = Math.max(5_000, configuration.expiresAtMs - Date.now() - 60_000);
        refreshTimer = window.setTimeout(load, refreshInMs);
      } catch (error) {
        if (!active) return;
        setState({
          configuration: FALLBACK,
          error: error instanceof Error ? error.message : "RTC 配置不可用",
        });
        refreshTimer = window.setTimeout(load, 10_000);
      }
    }

    void load();
    return () => {
      active = false;
      window.clearTimeout(refreshTimer);
    };
  }, []);

  return state;
}
