import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { createMoveNetBrowserEstimator } from "../model/movenet.js";
import { relayHttpUrl, relayWebSocketUrl } from "./config.js";
import {
  CONTROLLER_PROTOCOL,
  controllerProtocols,
  createPoseFrame,
} from "./protocol.js";
import { SkeletonStage } from "./SkeletonStage.jsx";
import { createMonitorState, reduceMonitorState } from "./state.js";

const MIN_PUBLISH_INTERVAL_MS = 100;
const HEARTBEAT_INTERVAL_MS = 15_000;

function unlockError(response, payload) {
  if (payload?.error === "invalid_control_key" || response.status === 401) {
    return "控制密钥不正确，请重新输入。";
  }
  if (payload?.error === "controller_locked" || response.status === 423) {
    return "已有监控端占用控制权。请先在原设备释放，或等待租约到期。";
  }
  if (payload?.error === "unlock_rate_limited" || response.status === 429) {
    return "密钥尝试次数过多，请稍后再试。";
  }
  return "控制端暂时无法解锁，请检查网络后重试。";
}

function waitForVideo(video) {
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("摄像头首帧等待超时"));
    }, 10_000);
    const onReady = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener("loadeddata", onReady);
    };
    video.addEventListener("loadeddata", onReady, { once: true });
  });
}

export function MonitorApp() {
  const [ui, dispatch] = useReducer(reduceMonitorState, undefined, createMonitorState);
  const [controlKey, setControlKey] = useState("");
  const [localFrame, setLocalFrame] = useState(null);
  const [stats, setStats] = useState({ inferenceMs: null, published: 0, quality: "—" });

  const videoRef = useRef(null);
  const tokenRef = useRef(null);
  const controllerRef = useRef(null);
  const streamRef = useRef(null);
  const estimatorRef = useRef(null);
  const animationRef = useRef(0);
  const captureGenerationRef = useRef(0);
  const captureActiveRef = useRef(false);
  const sequenceRef = useRef(0);
  const intentionalCloseRef = useRef(false);

  const closeControllerSocket = useCallback(() => {
    const connection = controllerRef.current;
    controllerRef.current = null;
    if (!connection) return;
    window.clearInterval(connection.heartbeat);
    connection.socket.onopen = null;
    connection.socket.onclose = null;
    connection.socket.onerror = null;
    connection.socket.close();
  }, []);

  const connectController = useCallback((token) => {
    intentionalCloseRef.current = true;
    closeControllerSocket();
    intentionalCloseRef.current = false;
    dispatch({ type: "controller_connecting" });

    let socket;
    try {
      socket = new WebSocket(
        relayWebSocketUrl("/ws/controller"),
        controllerProtocols(token),
      );
    } catch {
      dispatch({
        type: "degraded",
        connection: "disconnected",
        error: "无法建立安全控制连接。",
      });
      return;
    }

    const connection = { socket, heartbeat: 0 };
    controllerRef.current = connection;
    socket.onopen = () => {
      if (controllerRef.current !== connection) return;
      if (socket.protocol !== CONTROLLER_PROTOCOL) {
        socket.close(1002, "unexpected subprotocol");
        return;
      }
      connection.heartbeat = window.setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "heartbeat" }));
        }
      }, HEARTBEAT_INTERVAL_MS);
      dispatch({ type: "controller_connected" });
    };
    socket.onclose = () => {
      if (controllerRef.current !== connection) return;
      window.clearInterval(connection.heartbeat);
      controllerRef.current = null;
      if (!intentionalCloseRef.current) {
        dispatch({
          type: "degraded",
          connection: "disconnected",
          captureActive: captureActiveRef.current,
          error: captureActiveRef.current
            ? "中继连接已断开：摄像头仍在本机运行，但评委端不会收到新骨架。"
            : "中继连接已断开，请在租约到期前重新连接。",
        });
      }
    };
    socket.onerror = () => socket.close();
  }, [closeControllerSocket]);

  const stopCapture = useCallback(async () => {
    captureGenerationRef.current += 1;
    captureActiveRef.current = false;
    window.cancelAnimationFrame(animationRef.current);
    animationRef.current = 0;

    const stream = streamRef.current;
    streamRef.current = null;
    stream?.getTracks().forEach((track) => track.stop());
    if (videoRef.current) videoRef.current.srcObject = null;

    const estimator = estimatorRef.current;
    estimatorRef.current = null;
    if (estimator) {
      try {
        await estimator.dispose();
      } catch {
        // 资源已经从页面引用中移除，释放失败不掩盖后续 UI 状态。
      }
    }
    setLocalFrame(null);
  }, []);

  const unlock = useCallback(async (event) => {
    event.preventDefault();
    const key = controlKey.trim();
    if (!key) return;
    dispatch({ type: "unlocking" });
    try {
      const response = await fetch(relayHttpUrl("/api/unlock"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok || !payload.token || !payload.session_id) {
        dispatch({ type: "degraded", error: unlockError(response, payload) });
        return;
      }

      tokenRef.current = payload.token;
      sequenceRef.current = 0;
      setControlKey("");
      dispatch({ type: "unlocked", sessionId: payload.session_id });
      connectController(payload.token);
    } catch {
      dispatch({ type: "degraded", error: "无法连接控制服务，请确认网络后重试。" });
    }
  }, [connectController, controlKey]);

  const startCapture = useCallback(async () => {
    if (captureActiveRef.current || ui.connection !== "connected") return;
    if (!navigator.mediaDevices?.getUserMedia) {
      dispatch({ type: "degraded", error: "当前浏览器不支持摄像头采集。" });
      return;
    }

    dispatch({ type: "starting" });
    const generation = captureGenerationRef.current + 1;
    captureGenerationRef.current = generation;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
      streamRef.current = stream;
      const estimator = await createMoveNetBrowserEstimator();
      if (captureGenerationRef.current !== generation) {
        stream.getTracks().forEach((track) => track.stop());
        await estimator.dispose();
        return;
      }

      estimatorRef.current = estimator;
      const video = videoRef.current;
      video.srcObject = stream;
      await video.play();
      await waitForVideo(video);
      captureActiveRef.current = true;
      setStats({ inferenceMs: null, published: 0, quality: "准备首帧" });

      const socketReady = controllerRef.current?.socket.readyState === WebSocket.OPEN;
      if (socketReady) {
        dispatch({ type: "live" });
      } else {
        dispatch({
          type: "degraded",
          connection: "disconnected",
          captureActive: true,
          error: "摄像头已在本机运行，但中继未连接，暂未向评委发布。",
        });
      }

      let lastAttemptMs = -MIN_PUBLISH_INTERVAL_MS;
      const sample = async () => {
        try {
          const result = await estimator.infer(video);
          if (captureGenerationRef.current !== generation) return;
          const frame = createPoseFrame({
            sessionId: ui.sessionId,
            sequence: sequenceRef.current,
            timestampMs: Date.now(),
            sourceWidth: video.videoWidth,
            sourceHeight: video.videoHeight,
            personDetected: result.person_detected,
            landmarkQuality: result.landmark_quality,
            keypoints: result.keypoints,
          });
          if (!frame) {
            throw new Error("姿态结果不符合 17 点发布合同");
          }
          setLocalFrame(frame);
          const activeSocket = controllerRef.current?.socket;
          if (activeSocket?.readyState === WebSocket.OPEN) {
            activeSocket.send(JSON.stringify(frame));
            sequenceRef.current += 1;
            setStats((current) => ({
              inferenceMs: result.inference_ms,
              published: current.published + 1,
              quality: result.landmark_quality,
            }));
          } else {
            setStats((current) => ({
              ...current,
              inferenceMs: result.inference_ms,
              quality: result.landmark_quality,
            }));
          }
        } catch (error) {
          if (captureGenerationRef.current !== generation) return;
          await stopCapture();
          dispatch({
            type: "degraded",
            captureActive: false,
            error: `姿态模型已停止：${error instanceof Error ? error.message : "推理失败"}`,
          });
          return;
        }
        if (captureGenerationRef.current === generation) {
          animationRef.current = window.requestAnimationFrame(loop);
        }
      };
      const loop = (nowMs) => {
        if (captureGenerationRef.current !== generation) return;
        if (nowMs - lastAttemptMs < MIN_PUBLISH_INTERVAL_MS) {
          animationRef.current = window.requestAnimationFrame(loop);
          return;
        }
        lastAttemptMs = nowMs;
        void sample();
      };
      animationRef.current = window.requestAnimationFrame(loop);
    } catch (error) {
      if (captureGenerationRef.current !== generation) return;
      await stopCapture();
      dispatch({
        type: "degraded",
        captureActive: false,
        error: `无法开始采集：${error instanceof Error ? error.message : "摄像头或模型不可用"}`,
      });
    }
  }, [stopCapture, ui.connection, ui.sessionId]);

  const stopOnly = useCallback(async () => {
    await stopCapture();
    dispatch({ type: "capture_stopped" });
  }, [stopCapture]);

  const releaseControl = useCallback(async () => {
    const token = tokenRef.current;
    intentionalCloseRef.current = true;
    const socket = controllerRef.current?.socket;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "release" }));
    }
    const releaseRequest = token
      ? fetch(relayHttpUrl("/api/release"), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => null)
      : Promise.resolve(null);
    await stopCapture();
    await releaseRequest;
    closeControllerSocket();
    tokenRef.current = null;
    sequenceRef.current = 0;
    intentionalCloseRef.current = false;
    dispatch({ type: "released" });
  }, [closeControllerSocket, stopCapture]);

  const retryConnection = useCallback(() => {
    if (tokenRef.current) connectController(tokenRef.current);
  }, [connectController]);

  useEffect(() => {
    const releaseOnPageHide = () => {
      const socket = controllerRef.current?.socket;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "release" }));
      }
      intentionalCloseRef.current = true;
      closeControllerSocket();
      void stopCapture();
      tokenRef.current = null;
    };
    window.addEventListener("pagehide", releaseOnPageHide);
    return () => {
      window.removeEventListener("pagehide", releaseOnPageHide);
      releaseOnPageHide();
    };
  }, [closeControllerSocket, stopCapture]);

  const locked = ui.phase === "locked" || (ui.phase === "degraded" && !ui.sessionId);
  const canStart = ui.connection === "connected" && !ui.captureActive && ui.phase !== "starting";

  return (
    <div className="demo-shell monitor-role">
      <header className="demo-header">
        <a className="demo-brand" href="https://reme.maniforld.com/" aria-label="返回 Reme 评委旁观端">
          <span className="brand-mark">R</span>
          <span><b>Reme</b><small>现场采集控制台</small></span>
        </a>
        <div className="role-lockup">
          <span className="role-pill monitor-pill">唯一监控端</span>
          {!locked && (
            <span className={`connection-pill is-${ui.connection}`}>
              <i />{ui.connection === "connected" ? "控制租约在线" : "控制链路中断"}
            </span>
          )}
        </div>
      </header>

      {locked ? (
        <main className="unlock-layout">
          <section className="unlock-copy">
            <div className="eyebrow">MONITOR ACCESS</div>
            <h1>监控入口<br />与旁观入口分开。</h1>
            <p>只有一台设备可以取得控制租约。密钥只用于本次解锁，不会写入网址或浏览器存储。</p>
            <div className="boundary-list">
              <span><i>1</i>解锁唯一控制租约</span>
              <span><i>2</i>主动点击开启后置摄像头</span>
              <span><i>3</i>仅发布隐私化的 17 点抽象骨架</span>
            </div>
          </section>
          <form className="unlock-card" onSubmit={unlock} autoComplete="off">
            <span className="key-icon" aria-hidden="true">⌁</span>
            <h2>输入控制密钥</h2>
            <p>评委访问首页无需密钥，也无法进入此控制台。</p>
            <label htmlFor="control-key">本次演示密钥</label>
            <input
              id="control-key"
              name="reme-demo-control-key"
              type="password"
              value={controlKey}
              onChange={(event) => setControlKey(event.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck="false"
              disabled={ui.phase === "unlocking"}
              placeholder="••••••••••••"
            />
            {ui.error && <p className="form-error" role="alert">{ui.error}</p>}
            <button className="primary-action" type="submit" disabled={!controlKey.trim() || ui.phase === "unlocking"}>
              {ui.phase === "unlocking" ? "正在验证…" : "解锁监控端"}
            </button>
            <small>密钥经 HTTPS 发送给中继验证；页面不会保存它。</small>
          </form>
        </main>
      ) : (
        <main className="monitor-layout">
          <section className="monitor-stage">
            <video ref={videoRef} muted playsInline className="camera-preview" />
            <div className="stage-grid" />
            <SkeletonStage frame={localFrame} color="#ffb454" className="monitor-skeleton" />
            {!ui.captureActive && (
              <div className="stage-placeholder compact">
                <span className="camera-glyph" aria-hidden="true">◉</span>
                <b>{ui.phase === "starting" ? "正在加载摄像头与模型…" : "摄像头尚未开启"}</b>
                <p>只有点击下方按钮后，浏览器才会申请后置摄像头权限。</p>
              </div>
            )}
            <div className="stage-topline">
              <span><i className={ui.phase === "live" ? "live-dot" : "wait-dot"} />{ui.phase === "live" ? "PUBLISHING" : "LOCAL / PAUSED"}</span>
              <span>原始画面仅在本机</span>
            </div>
          </section>

          <aside className="control-panel">
            <div>
              <div className="eyebrow">CONTROLLER</div>
              <h1>手机监控端</h1>
              <p className="intro-copy">后置摄像头在本机运行自训练 MoveNet，向评委页发布不高于 10Hz 的骨架。</p>
            </div>

            {ui.error && (
              <div className="degraded-card" role="alert">
                <b>已明确降级</b>
                <p>{ui.error}</p>
                {ui.connection !== "connected" && (
                  <button type="button" className="secondary-action" onClick={retryConnection}>重新连接中继</button>
                )}
                <a href="/typical-demo.html">改用单机演示备份</a>
              </div>
            )}

            <dl className="session-facts compact-facts">
              <div><dt>会话</dt><dd title={ui.sessionId}>{ui.sessionId ? `…${ui.sessionId.slice(-12)}` : "—"}</dd></div>
              <div><dt>发布帧</dt><dd>{stats.published}</dd></div>
              <div><dt>单帧推理</dt><dd>{Number.isFinite(stats.inferenceMs) ? `${stats.inferenceMs.toFixed(1)} ms` : "—"}</dd></div>
              <div><dt>骨架质量</dt><dd>{stats.quality}</dd></div>
            </dl>

            <div className="control-actions">
              {!ui.captureActive ? (
                <button type="button" className="primary-action" onClick={startCapture} disabled={!canStart}>
                  {ui.phase === "starting" ? "正在启动…" : "开启后置摄像头"}
                </button>
              ) : (
                <button type="button" className="secondary-action" onClick={stopOnly}>停止采集</button>
              )}
              <button type="button" className="release-action" onClick={releaseControl}>释放控制权</button>
            </div>
            <small className="control-footnote">释放后，下一台输入正确密钥的设备才能成为监控端。</small>
          </aside>
        </main>
      )}

      <footer className="demo-footer">
        <span>Reme Monitor · 控制入口</span>
        <a href="https://reme.maniforld.com/">查看评委只读页</a>
      </footer>
    </div>
  );
}
