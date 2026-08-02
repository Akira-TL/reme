"""A→B 本地联调驱动：合成关键点喂给 A，实时打印 A 姿态分类与 B 决策输出。

用途：B→C 链路未通时，独立验证「A 对姿态的分类传给 B，B 的 MiMo 判断并输出」
这一段数据流。脚本同时订阅 A 的 ``/ws/events`` 和 B 的 ``/ws``，把两侧事件
按时间顺序打在同一个终端里，结束时给出摘要。

前置（两个终端分别启动，先 A 后 B）：

  .venv/bin/python -m reme.pose.runtime_server \
      --host 127.0.0.1 --port 8770 --input-adapter c_ws_server

  source ~/.config/reme/mimo.env && .venv/bin/python -m reme.decision.server \
      --host 127.0.0.1 --port 8100 --a-events-url ws://127.0.0.1:8770/ws/events

用法：

  # 合成「站立→跌倒→躺地」序列，观察 B 的事件触发式 MiMo 决策
  .venv/bin/python examples/integration/ab_live_debug.py

  # 合成持续站立，验证正常稳定时 B 不调用 MiMo
  .venv/bin/python examples/integration/ab_live_debug.py --scenario still --duration 8

  # 不注入任何输入，旁听当前已激活会话（例如浏览器真人驱动时）
  .venv/bin/python examples/integration/ab_live_debug.py --attach

合成骨架与 tests/test_danger_link_e2e.py 保持一致，走 A 的浏览器关键点直传
通道（``/ws/camera-input`` 的 ``landmarks_frame``），不需要摄像头和模型文件。
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import http.client
import json
import os
import socket
import struct
import sys
import threading
import time
import uuid
from collections import Counter
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

try:
    from reme.decision.ws_client import PerceptionEventClient
    from reme.pose.browser_input import KEYPOINT_NAMES
    from reme.pose.runtime import RuntimeEvent, RuntimeEventType
except ImportError:  # 允许在未安装 editable 包的解释器里直接运行
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))
    from reme.decision.ws_client import PerceptionEventClient
    from reme.pose.browser_input import KEYPOINT_NAMES
    from reme.pose.runtime import RuntimeEvent, RuntimeEventType

SESSION_SCHEMA = "reme-runtime-session-request/v0-experiment"
DEFAULT_SCENE_ID = "debug-living-room"

_PRINT_LOCK = threading.Lock()
_USE_COLOR = sys.stdout.isatty()


def _paint(text: str, code: str) -> str:
    return f"\x1b[{code}m{text}\x1b[0m" if _USE_COLOR else text


def _say(side: str, message: str) -> None:
    stamp = time.strftime("%H:%M:%S", time.localtime())
    tags = {
        "A": _paint("[A]", "36"),
        "B": _paint("[B]", "33;1"),
        "驱动": _paint("[驱动]", "32"),
        "!": _paint("[警告]", "31;1"),
    }
    with _PRINT_LOCK:
        print(f"{stamp} {tags.get(side, f'[{side}]')} {message}", flush=True)


# -- REST 帮助函数 -----------------------------------------------------------


def _request(
    base: str, method: str, path: str, payload: dict[str, Any] | None = None
) -> tuple[int, Any]:
    parsed = urlparse(base)
    connection = http.client.HTTPConnection(parsed.hostname, parsed.port, timeout=10)
    try:
        body = None if payload is None else json.dumps(payload)
        headers = {"Content-Type": "application/json"} if body is not None else {}
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        raw = response.read().decode("utf-8")
        try:
            return response.status, json.loads(raw) if raw else None
        except json.JSONDecodeError:
            return response.status, raw
    finally:
        connection.close()


def _require_health(name: str, base: str) -> None:
    try:
        status, body = _request(base, "GET", "/api/health")
    except OSError as exc:
        raise SystemExit(f"{name} 无法连接（{base}）：{exc}；请先启动 {name} 服务") from exc
    if status != 200:
        raise SystemExit(f"{name} 健康检查失败：HTTP {status} {body!r}")


# -- 最小 RFC6455 发送端（camera-input 注入用） ------------------------------


class _WsSender:
    """仅支持客户端握手与发送文本帧，够 ``/ws/camera-input`` 注入使用。"""

    def __init__(self, base: str, path: str) -> None:
        parsed = urlparse(base)
        self._sock = socket.create_connection((parsed.hostname, parsed.port), timeout=10)
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        handshake = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {parsed.hostname}:{parsed.port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self._sock.sendall(handshake.encode("ascii"))
        buffer = b""
        while b"\r\n\r\n" not in buffer:
            chunk = self._sock.recv(4096)
            if not chunk:
                raise ConnectionError("camera-input 握手中断")
            buffer += chunk
        status_line = buffer.split(b"\r\n", 1)[0].decode(errors="replace")
        if "101" not in status_line:
            raise ConnectionError(f"camera-input 握手被拒绝：{status_line}")

    def send_json(self, payload: dict[str, Any]) -> None:
        data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        mask = os.urandom(4)
        masked = bytes(byte ^ mask[i % 4] for i, byte in enumerate(data))
        length = len(data)
        if length < 126:
            header = struct.pack("!BB", 0x81, 0x80 | length)
        elif length <= 0xFFFF:
            header = struct.pack("!BBH", 0x81, 0x80 | 126, length)
        else:
            header = struct.pack("!BBQ", 0x81, 0x80 | 127, length)
        self._sock.sendall(header + mask + masked)

    def close(self) -> None:
        with contextlib.suppress(OSError):
            self._sock.sendall(bytes(bytearray([0x88, 0x80]) + os.urandom(4)))
        self._sock.close()


# -- 合成骨架（与 tests/test_danger_link_e2e.py 同源） -----------------------


def _standing() -> dict[str, tuple[float, float]]:
    return {
        "nose": (0.50, 0.18),
        "left_eye": (0.485, 0.17),
        "right_eye": (0.515, 0.17),
        "left_ear": (0.47, 0.18),
        "right_ear": (0.53, 0.18),
        "left_shoulder": (0.44, 0.30),
        "right_shoulder": (0.56, 0.30),
        "left_elbow": (0.42, 0.42),
        "right_elbow": (0.58, 0.42),
        "left_wrist": (0.41, 0.53),
        "right_wrist": (0.59, 0.53),
        "left_hip": (0.46, 0.55),
        "right_hip": (0.54, 0.55),
        "left_knee": (0.46, 0.75),
        "right_knee": (0.54, 0.75),
        "left_ankle": (0.46, 0.95),
        "right_ankle": (0.54, 0.95),
    }


def _lying() -> dict[str, tuple[float, float]]:
    return {
        "nose": (0.24, 0.84),
        "left_eye": (0.25, 0.83),
        "right_eye": (0.25, 0.85),
        "left_ear": (0.26, 0.82),
        "right_ear": (0.26, 0.86),
        "left_shoulder": (0.36, 0.83),
        "right_shoulder": (0.40, 0.87),
        "left_elbow": (0.44, 0.80),
        "right_elbow": (0.46, 0.90),
        "left_wrist": (0.50, 0.79),
        "right_wrist": (0.52, 0.91),
        "left_hip": (0.58, 0.84),
        "right_hip": (0.62, 0.88),
        "left_knee": (0.70, 0.83),
        "right_knee": (0.72, 0.89),
        "left_ankle": (0.80, 0.84),
        "right_ankle": (0.82, 0.88),
    }


def _skeleton(coords: dict[str, tuple[float, float]]) -> list[dict[str, Any]]:
    return [
        {
            "name": name,
            "x_norm": coords.get(name, (0.5, 0.5))[0],
            "y_norm": coords.get(name, (0.5, 0.5))[1],
            "score": 0.9 if name in coords else 0.0,
        }
        for name in KEYPOINT_NAMES
    ]


def _blend(
    start: dict[str, tuple[float, float]],
    end: dict[str, tuple[float, float]],
    ratio: float,
) -> dict[str, tuple[float, float]]:
    return {
        name: (
            start[name][0] + (end[name][0] - start[name][0]) * ratio,
            start[name][1] + (end[name][1] - start[name][1]) * ratio,
        )
        for name in start
    }


Pose = dict[str, tuple[float, float]]


def _scenario_poses(scenario: str, duration_s: float, fps: float) -> list[Pose]:
    if scenario == "still":
        return [_standing()] * max(1, round(duration_s * fps))
    # 站立基线必须短：转变检测器的 short_window 信号要求评估窗口 ≤1400ms，
    # 而滑窗从场景开始（或上一事件清空）起累积，站立前奏过长会把窗口撑破，
    # 跌倒只能判成 uncertain。0.6s+0.4s 与 tests/test_danger_link_e2e.py 同节奏。
    standing, lying = _standing(), _lying()
    poses = [standing] * round(0.6 * fps)  # 0.6s 站立基线
    fall_steps = max(2, round(0.4 * fps))  # 0.4s 快速倒地
    poses += [_blend(standing, lying, step / fall_steps) for step in range(1, fall_steps + 1)]
    poses += [lying] * round(6.0 * fps)  # 6s 躺地不动
    return poses


# -- 事件观察 ----------------------------------------------------------------


class LinkObserver:
    """双流观察者：A 姿态去重打印，B 决策全文打印，收尾出摘要。"""

    def __init__(self, verbose: bool) -> None:
        self._verbose = verbose
        self._last_posture: tuple[str, str] | None = None
        self._last_posture_print = 0.0
        self.a_counts: Counter[str] = Counter()
        self.postures_seen: Counter[str] = Counter()
        self.transitions: list[dict[str, Any]] = []
        self.decisions: list[dict[str, Any]] = []

    def on_a_event(self, event: RuntimeEvent) -> None:
        self.a_counts[event.event_type.value] += 1
        payload = event.payload
        if event.event_type is RuntimeEventType.FRAME_LANDMARKS:
            if self._verbose:
                stamp = payload.get("timestamp_ms")
                _say("A", f"关键点帧 #{payload.get('frame_index')} t={stamp}ms")
            return
        if event.event_type is RuntimeEventType.POSTURE_OBSERVATION:
            posture = str(payload.get("posture"))
            motion = str(payload.get("motion_level"))
            self.postures_seen[posture] += 1
            now = time.monotonic()
            changed = self._last_posture != (posture, motion)
            if changed or now - self._last_posture_print >= 2.0 or self._verbose:
                self._last_posture = (posture, motion)
                self._last_posture_print = now
                _say(
                    "A",
                    f"姿态分类 {posture} conf={payload.get('posture_confidence')} "
                    f"motion={motion} 持续={payload.get('posture_duration_ms')}ms "
                    f"质量={payload.get('landmark_quality')} t={payload.get('timestamp_ms')}ms",
                )
            return
        if event.event_type is RuntimeEventType.TRANSITION_EVENT:
            self.transitions.append(payload)
            evidence = payload.get("evidence") or {}
            _say(
                "A",
                f"转变候选 {payload.get('transition')} conf={payload.get('transition_confidence')} "
                f"{payload.get('start_ms')}→{payload.get('end_ms')}ms "
                f"{evidence.get('posture_before')}→{evidence.get('posture_after')}",
            )

    def on_b_event(self, event: RuntimeEvent) -> None:
        if event.event_type is not RuntimeEventType.CARE_DECISION:
            body = json.dumps(event.payload, ensure_ascii=False)
            _say("B", f"事件 {event.event_type.value}: {body}")
            return
        payload = event.payload
        self.decisions.append(payload)
        _say(
            "B",
            f"决策 {payload.get('decision_id')} state={payload.get('state')} "
            f"action={payload.get('action')} risk={payload.get('risk_level')} "
            f"source={_paint(str(payload.get('source')), '35;1')} "
            f"fallback={payload.get('fallback_used')}",
        )
        message = payload.get("elder_message")
        if message:
            _say("B", f"  老人话术:「{message}」")
        reason = payload.get("reason_summary")
        if reason:
            _say("B", f"  判断理由: {reason}")
        family = payload.get("family_notification")
        if family:
            _say("B", f"  家属通知: {json.dumps(family, ensure_ascii=False)}")
        extras: list[str] = []
        if payload.get("need_dialogue"):
            extras.append(f"等待回应 {payload.get('response_timeout_ms')}ms")
        if payload.get("confirm_channels"):
            extras.append(f"确认通道 {payload.get('confirm_channels')}")
        if payload.get("alarm"):
            extras.append(f"告警 {payload.get('alarm')}")
        if extras:
            _say("B", "  " + " | ".join(extras))

    def summary(self) -> str:
        lines = ["", "=== A→B 链路摘要 ==="]
        lines.append(
            "A 事件: "
            + (
                ", ".join(f"{name}×{count}" for name, count in sorted(self.a_counts.items()))
                or "（无）"
            )
        )
        if self.postures_seen:
            lines.append(
                "A 姿态分布: "
                + ", ".join(f"{name}×{count}" for name, count in self.postures_seen.most_common())
            )
        if self.transitions:
            for item in self.transitions:
                lines.append(
                    f"A 转变候选: {item.get('transition')} conf={item.get('transition_confidence')}"
                )
        decision_kinds = Counter(
            f"{item.get('state')}({item.get('source')})" for item in self.decisions
        )
        lines.append(
            "B 决策: "
            + (", ".join(f"{name}×{count}" for name, count in decision_kinds.items()) or "（无）")
        )
        mimo_count = sum(1 for item in self.decisions if item.get("source") == "mimo")
        degraded = sum(1 for item in self.decisions if item.get("fallback_used"))
        lines.append(
            f"MiMo 实际出话: {'是' if mimo_count else '否'}（source=mimo 共 {mimo_count} 条，"
            f"fallback {degraded} 条）"
        )
        return "\n".join(lines)


# -- 会话编排 ----------------------------------------------------------------


def _session_payload(session_id: str, scene_id: str) -> dict[str, Any]:
    return {
        "schema_version": SESSION_SCHEMA,
        "session_id": session_id,
        "profile": "live_camera",
        "scene_id": scene_id,
        "input_source": "camera",
        "perception_mode": "live",
        "decision_mode": "live",
        "camera_id": "debug-driver-camera",
        "manifest_path": None,
    }


def _stop_active_a_session(a_url: str) -> None:
    status, body = _request(a_url, "GET", "/api/runtime/status")
    if status == 200 and isinstance(body, dict) and body.get("session_id"):
        _say("驱动", f"A 存在旧会话 {body['session_id']}，先停止")
        _request(a_url, "POST", "/api/runtime/stop", {"session_id": body["session_id"]})


def _start_sessions(a_url: str, b_url: str, session_id: str, scene_id: str) -> None:
    payload = _session_payload(session_id, scene_id)
    status, body = _request(a_url, "POST", "/api/runtime/start", payload)
    if status != 202:
        raise SystemExit(f"A 启动失败：HTTP {status} {body!r}")
    _say("驱动", f"A 会话已受理 state={body.get('state')}")
    status, body = _request(b_url, "POST", "/api/session", payload)
    if status != 200:
        _request(a_url, "POST", "/api/runtime/stop", {"session_id": session_id})
        raise SystemExit(f"B 启动失败：HTTP {status} {body!r}")
    _say("驱动", f"B 会话已运行 component={body.get('component')} state={body.get('state')}")


def _stop_sessions(a_url: str, b_url: str, session_id: str) -> None:
    with contextlib.suppress(Exception):
        _request(b_url, "POST", "/api/session/stop", {"session_id": session_id})
    with contextlib.suppress(Exception):
        _request(a_url, "POST", "/api/runtime/stop", {"session_id": session_id})


def _connect_camera_input(a_url: str) -> _WsSender:
    last_error: Exception | None = None
    for _ in range(10):
        try:
            return _WsSender(a_url, "/ws/camera-input")
        except (OSError, ConnectionError) as exc:
            last_error = exc
            time.sleep(0.3)
    raise SystemExit(f"无法连接 A 的 /ws/camera-input：{last_error}")


def _drive_scenario(
    sender: _WsSender, session_id: str, scene_id: str, scenario: str, duration_s: float, fps: float
) -> None:
    poses = _scenario_poses(scenario, duration_s, fps)
    interval = 1.0 / fps
    _say("驱动", f"开始注入合成关键点：scenario={scenario} 共 {len(poses)} 帧 @ {fps:g}fps")
    for index, coords in enumerate(poses):
        sender.send_json(
            {
                "type": "landmarks_frame",
                "session_id": session_id,
                "scene_id": scene_id,
                "frame_index": index,
                "timestamp_ms": round(index * 1000.0 / fps, 1),
                "person_detected": True,
                "keypoints": _skeleton(coords),
            }
        )
        time.sleep(interval)
    _say("驱动", "合成序列注入完毕")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--a-url", default="http://127.0.0.1:8770", help="A 感知服务地址")
    parser.add_argument("--b-url", default="http://127.0.0.1:8100", help="B 决策服务地址")
    parser.add_argument("--scenario", choices=("fall", "still"), default="fall")
    parser.add_argument("--duration", type=float, default=8.0, help="still 场景时长（秒）")
    parser.add_argument("--fps", type=float, default=10.0, help="注入帧率")
    parser.add_argument("--linger", type=float, default=15.0, help="注入完成后继续观察的秒数")
    parser.add_argument("--scene-id", default=DEFAULT_SCENE_ID)
    parser.add_argument(
        "--attach", action="store_true", help="不注入输入，旁听 A 当前活跃会话（Ctrl+C 退出）"
    )
    parser.add_argument("--verbose", action="store_true", help="逐帧打印 A 的全部事件")
    args = parser.parse_args(argv)

    _require_health("A", args.a_url)
    _require_health("B", args.b_url)

    a_ws = args.a_url.replace("http://", "ws://", 1) + "/ws/events"
    b_ws = args.b_url.replace("http://", "ws://", 1) + "/ws"

    if args.attach:
        status, body = _request(args.a_url, "GET", "/api/runtime/status")
        if status != 200 or not isinstance(body, dict) or not body.get("session_id"):
            raise SystemExit("A 当前没有活跃会话，--attach 无从旁听")
        session_id = str(body["session_id"])
        _say("驱动", f"旁听会话 {session_id}（state={body.get('state')}），Ctrl+C 退出")
    else:
        session_id = f"live-camera-debug-{uuid.uuid4().hex[:8]}"
        _stop_active_a_session(args.a_url)
        _start_sessions(args.a_url, args.b_url, session_id, args.scene_id)

    observer = LinkObserver(verbose=args.verbose)
    a_client = PerceptionEventClient(url=a_ws, session_id=session_id, on_event=observer.on_a_event)
    b_client = PerceptionEventClient(url=b_ws, session_id=session_id, on_event=observer.on_b_event)
    a_client.start()
    b_client.start()

    sender: _WsSender | None = None
    try:
        if args.attach:
            while True:
                time.sleep(0.5)
        else:
            sender = _connect_camera_input(args.a_url)
            _drive_scenario(
                sender, session_id, args.scene_id, args.scenario, args.duration, args.fps
            )
            _say("驱动", f"继续观察 {args.linger:g}s（等待 B 的超时升级/尾随决策）")
            time.sleep(args.linger)
    except KeyboardInterrupt:
        _say("驱动", "收到 Ctrl+C，收尾")
    finally:
        if sender is not None:
            sender.close()
        # 先断订阅再停会话，避免停止时的关闭通知被当成畸形事件告警。
        a_client.stop()
        b_client.stop()
        if not args.attach:
            _stop_sessions(args.a_url, args.b_url, session_id)
        with _PRINT_LOCK:
            print(observer.summary(), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
