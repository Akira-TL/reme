"""Minimal RFC 6455 WebSocket server for B->C decision streaming (stdlib only).

Skeleton contract for parallel lane L2 — signatures are FROZEN; the server
lane (L3) codes against ``DecisionEventHub`` with a fake and never imports
protocol internals.

Frozen decisions:
- Wire format: one RuntimeEvent payload (``RuntimeEvent.to_payload()`` JSON)
  per text frame; the hub never fragments outbound messages.
- ``DecisionEventHub.accept(handler)`` owns the full connection lifecycle
  (handshake + register + blocking serve + unregister). It may only touch
  ``handler.command / handler.headers / handler.rfile / handler.wfile /
  handler.connection``; on handshake failure it raises WebSocketError
  BEFORE writing any bytes so the caller can still send an HTTP error.
- Reads go through ``handler.rfile`` exclusively (bytes may already sit in
  its buffer after the upgrade request); writes go through ``handler.wfile``
  under a per-connection lock.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, BinaryIO, Protocol

OPCODE_CONTINUATION = 0x0
OPCODE_TEXT = 0x1
OPCODE_BINARY = 0x2
OPCODE_CLOSE = 0x8
OPCODE_PING = 0x9
OPCODE_PONG = 0xA

MAX_MESSAGE_BYTES = 1024 * 1024  # close 1009 beyond this


class WebSocketError(Exception):
    """Handshake or protocol failure; on handshake paths no bytes were sent."""


class HandlerLike(Protocol):
    """The slice of BaseHTTPRequestHandler the hub is allowed to touch."""

    command: str

    @property
    def headers(self) -> Any: ...

    @property
    def rfile(self) -> BinaryIO: ...

    @property
    def wfile(self) -> Any: ...

    @property
    def connection(self) -> Any: ...


def compute_accept(key: str) -> str:
    """Sec-WebSocket-Accept for a client key (RFC 6455 section 4.2.2)."""

    raise NotImplementedError


@dataclass(frozen=True, slots=True)
class Frame:
    """One parsed frame (control frames arrive unfragmented)."""

    fin: bool
    opcode: int
    payload: bytes


def read_frame(rfile: BinaryIO) -> Frame:
    """Read exactly one client frame; unmasked client frames are a protocol error."""

    raise NotImplementedError


def encode_frame(opcode: int, payload: bytes, *, fin: bool = True) -> bytes:
    """Encode one server frame (never masked)."""

    raise NotImplementedError


class ServerConnection:
    """One accepted connection: send lock, recv loop, close handshake."""

    def __init__(self, *, connection: Any, rfile: BinaryIO, wfile: Any) -> None:
        raise NotImplementedError

    @property
    def closed(self) -> bool:
        raise NotImplementedError

    def send_text(self, text: str) -> None:
        """Thread-safe text send; marks the connection dead on OSError."""

        raise NotImplementedError

    def send_close(self, code: int = 1000) -> None:
        raise NotImplementedError

    def serve(self, on_text: Callable[[str], None] | None = None) -> None:
        """Blocking recv loop: pong pings, honour close, feed text upstream."""

        raise NotImplementedError


class DecisionEventHub:
    """Connection registry + broadcast fan-out for B's decision stream."""

    def __init__(self) -> None:
        raise NotImplementedError

    def accept(self, handler: HandlerLike) -> None:
        """Full WS lifecycle on an upgrade request; blocks until disconnect."""

        raise NotImplementedError

    def broadcast_json(self, payload: dict[str, Any]) -> int:
        """Send one JSON text frame to every live connection; returns count.

        Encodes the frame once, reuses the bytes, and prunes dead
        connections as it goes.
        """

        raise NotImplementedError

    def connection_count(self) -> int:
        raise NotImplementedError

    def close_all(self) -> None:
        """Graceful close of every connection (server shutdown/tests)."""

        raise NotImplementedError
