import { useEffect, useState } from "react";
import { saveRemeLocalRecording } from "../shared-demo/remeLocalRecordings.js";

export const REME_LOCAL_SEGMENT_DURATION_MS = 10_000;
const MINIMUM_SAVED_DURATION_MS = 1_000;
const VIDEO_BITS_PER_SECOND = 600_000;

const MIME_CANDIDATES = Object.freeze([
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
  "video/mp4;codecs=avc1",
  "video/mp4",
]);

export function selectSupportedRecordingMimeType(MediaRecorderType) {
  if (!MediaRecorderType) return null;
  if (typeof MediaRecorderType.isTypeSupported !== "function") return "";
  return MIME_CANDIDATES.find((mimeType) => MediaRecorderType.isTypeSupported(mimeType)) || null;
}

function createRecordingIdLabel(sceneLabel, startedAtMs) {
  const time = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(startedAtMs));
  return `${sceneLabel || "家中"} · ${time}`;
}

export function useRemeLocalRecorder({
  enabled,
  stream,
  sceneId,
  sceneLabel,
  runtimeSessionId,
  sourceGeneration,
}) {
  const [state, setState] = useState({ status: "idle", error: null, savedCount: 0 });

  useEffect(() => {
    if (!enabled || !stream || !runtimeSessionId) {
      const resetTimer = window.setTimeout(() => {
        setState((current) => ({ ...current, status: "idle", error: null }));
      }, 0);
      return () => window.clearTimeout(resetTimer);
    }
    const MediaRecorderType = globalThis.MediaRecorder;
    const mimeType = selectSupportedRecordingMimeType(MediaRecorderType);
    const videoTracks = stream.getVideoTracks?.().filter((track) => track.readyState !== "ended") || [];
    if (!MediaRecorderType || mimeType === null || videoTracks.length === 0) {
      const unsupportedTimer = window.setTimeout(() => {
        setState((current) => ({
          ...current,
          status: "unsupported",
          error: "当前浏览器无法保存本机录像片段",
        }));
      }, 0);
      return () => window.clearTimeout(unsupportedTimer);
    }

    const recordingStream = new MediaStream(videoTracks);
    let cancelled = false;
    let segmentTimer = null;
    let recorder = null;

    const fail = (reason) => {
      if (cancelled) return;
      setState((current) => ({
        ...current,
        status: "error",
        error: reason?.message || "本机录像保存失败",
      }));
    };

    const startSegment = () => {
      if (cancelled || videoTracks.some((track) => track.readyState === "ended")) return;
      const startedAtMs = Date.now();
      const chunks = [];
      try {
        recorder = new MediaRecorderType(recordingStream, {
          ...(mimeType ? { mimeType } : {}),
          videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
        });
      } catch (error) {
        fail(error);
        return;
      }
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data?.size > 0) chunks.push(event.data);
      });
      recorder.addEventListener("error", (event) => fail(event.error));
      recorder.addEventListener("stop", async () => {
        window.clearTimeout(segmentTimer);
        const endedAtMs = Date.now();
        if (chunks.length > 0 && endedAtMs - startedAtMs >= MINIMUM_SAVED_DURATION_MS) {
          const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || "video/webm" });
          try {
            if (!cancelled) setState((current) => ({ ...current, status: "saving", error: null }));
            await saveRemeLocalRecording({
              blob,
              startedAtMs,
              endedAtMs,
              sceneId,
              sceneLabel: createRecordingIdLabel(sceneLabel, startedAtMs),
              runtimeSessionId,
              sourceGeneration,
            });
            if (!cancelled) setState((current) => ({
              status: "recording",
              error: null,
              savedCount: current.savedCount + 1,
            }));
          } catch (error) {
            fail(error);
            return;
          }
        }
        if (!cancelled) startSegment();
      }, { once: true });
      recorder.start();
      setState((current) => ({ ...current, status: "recording", error: null }));
      segmentTimer = window.setTimeout(() => {
        if (recorder?.state === "recording") recorder.stop();
      }, REME_LOCAL_SEGMENT_DURATION_MS);
    };

    const startTimer = window.setTimeout(startSegment, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(startTimer);
      window.clearTimeout(segmentTimer);
      if (recorder?.state === "recording") recorder.stop();
    };
  }, [
    enabled,
    runtimeSessionId,
    sceneId,
    sceneLabel,
    sourceGeneration,
    stream,
  ]);

  return state;
}
