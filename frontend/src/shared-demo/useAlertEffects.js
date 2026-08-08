import { useCallback, useEffect, useRef, useState } from "react";

function getAudioContext(contextRef) {
  if (contextRef.current) return contextRef.current;
  const Context = window.AudioContext || window.webkitAudioContext;
  if (!Context) return null;
  contextRef.current = new Context();
  return contextRef.current;
}

async function playAlarm(contextRef) {
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
      oscillator.start(start + offset);
      oscillator.stop(start + offset + 0.2);
    }
    return true;
  } catch {
    return false;
  }
}

export function useAlertEffects({ enabled, emergency, decisionId }) {
  const contextRef = useRef(null);
  const notifiedRef = useRef(null);
  const flashTimerRef = useRef(0);
  const [flashActive, setFlashActive] = useState(false);
  const [soundBlocked, setSoundBlocked] = useState(false);

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
    if (!enabled) {
      window.clearTimeout(flashTimerRef.current);
      navigator.vibrate?.(0);
      return;
    }
    if (!emergency || !decisionId) return;
    const key = `${decisionId}:emergency`;
    if (notifiedRef.current === key) return;
    notifiedRef.current = key;
    navigator.vibrate?.([220, 100, 220, 100, 320]);
    window.setTimeout(() => setFlashActive(true), 0);
    window.clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(() => setFlashActive(false), 2400);
    void playAlarm(contextRef).then((played) => setSoundBlocked(!played));
  }, [decisionId, emergency, enabled]);

  useEffect(() => () => {
    window.clearTimeout(flashTimerRef.current);
    navigator.vibrate?.(0);
    void contextRef.current?.close?.();
  }, []);

  const retrySound = useCallback(async () => {
    const played = await playAlarm(contextRef);
    setSoundBlocked(!played);
    return played;
  }, []);

  return {
    flashActive: enabled && flashActive,
    retrySound,
    soundBlocked: enabled && soundBlocked,
  };
}
