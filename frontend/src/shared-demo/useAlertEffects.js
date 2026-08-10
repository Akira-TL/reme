import { useCallback, useEffect, useRef, useState } from "react";

function getAudioContext(contextRef) {
  if (contextRef.current) return contextRef.current;
  const Context = window.AudioContext || window.webkitAudioContext;
  if (!Context) return null;
  contextRef.current = new Context();
  return contextRef.current;
}

async function playAlarm(contextRef, activeNodesRef) {
  const context = getAudioContext(contextRef);
  if (!context) return false;
  try {
    if (context.state === "suspended") await context.resume();
    if (context.state !== "running") return false;
    const start = context.currentTime + 0.02;
    for (const offset of [0, 0.25, 0.5]) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(720, start + offset);
      oscillator.frequency.exponentialRampToValueAtTime(980, start + offset + 0.13);
      gain.gain.setValueAtTime(0.0001, start + offset);
      gain.gain.exponentialRampToValueAtTime(0.14, start + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.19);
      oscillator.connect(gain).connect(context.destination);
      activeNodesRef.current.add(oscillator);
      oscillator.onended = () => activeNodesRef.current.delete(oscillator);
      oscillator.start(start + offset);
      oscillator.stop(start + offset + 0.2);
    }
    return true;
  } catch {
    return false;
  }
}

function stopNodes(activeNodesRef) {
  for (const oscillator of activeNodesRef.current) {
    try {
      oscillator.stop();
    } catch {
      // A scheduled oscillator may already have stopped.
    }
  }
  activeNodesRef.current.clear();
}

export function alertChannelPlan(alarm) {
  const channels = Array.isArray(alarm?.channels) ? new Set(alarm.channels) : new Set();
  const vibrate = channels.has("vibrate");
  const ring = channels.has("ring");
  const flash = channels.has("flash");
  return Object.freeze({
    vibrate,
    ring,
    flash,
    key: [vibrate ? "v" : "", ring ? "r" : "", flash ? "f" : ""]
      .filter(Boolean)
      .join(""),
  });
}

export function useAlertEffects({ enabled, alarm, decisionId }) {
  const contextRef = useRef(null);
  const notifiedRef = useRef(null);
  const flashTimerRef = useRef(0);
  const activeNodesRef = useRef(new Set());
  const [flashActive, setFlashActive] = useState(false);
  const [soundBlocked, setSoundBlocked] = useState(false);
  const channels = alertChannelPlan(alarm);
  const alarmKey = enabled && decisionId && channels.key
    ? `${decisionId}:${alarm?.trigger || "unknown"}:${channels.key}`
    : null;

  useEffect(() => {
    const unlock = () => {
      const context = getAudioContext(contextRef);
      if (context?.state === "suspended") void context.resume();
    };
    window.addEventListener("pointerdown", unlock, { capture: true, once: true });
    window.addEventListener("keydown", unlock, { capture: true, once: true });
    return () => {
      window.removeEventListener("pointerdown", unlock, { capture: true });
      window.removeEventListener("keydown", unlock, { capture: true });
    };
  }, []);

  useEffect(() => {
    window.clearTimeout(flashTimerRef.current);
    navigator.vibrate?.(0);
    stopNodes(activeNodesRef);

    if (!alarmKey) {
      notifiedRef.current = null;
      const resetTimer = window.setTimeout(() => {
        setFlashActive(false);
        setSoundBlocked(false);
      }, 0);
      return () => window.clearTimeout(resetTimer);
    }
    if (notifiedRef.current === alarmKey) return undefined;
    notifiedRef.current = alarmKey;

    if (channels.vibrate) navigator.vibrate?.([220, 100, 220, 100, 320]);
    const stateTimer = window.setTimeout(() => {
      setFlashActive(channels.flash);
      if (!channels.ring) setSoundBlocked(false);
    }, 0);
    if (channels.flash) {
      flashTimerRef.current = window.setTimeout(() => setFlashActive(false), 2400);
    }
    if (channels.ring) {
      void playAlarm(contextRef, activeNodesRef)
        .then((played) => setSoundBlocked(!played));
    }
    return () => window.clearTimeout(stateTimer);
  }, [alarmKey, channels.flash, channels.ring, channels.vibrate]);

  useEffect(() => () => {
    window.clearTimeout(flashTimerRef.current);
    navigator.vibrate?.(0);
    stopNodes(activeNodesRef);
    void contextRef.current?.close?.();
  }, []);

  const retrySound = useCallback(async () => {
    if (!alarmKey || !channels.ring) return false;
    const played = await playAlarm(contextRef, activeNodesRef);
    setSoundBlocked(!played);
    return played;
  }, [alarmKey, channels.ring]);

  return {
    flashActive: Boolean(alarmKey && channels.flash && flashActive),
    retrySound,
    soundBlocked: Boolean(alarmKey && channels.ring && soundBlocked),
  };
}
