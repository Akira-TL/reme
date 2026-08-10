"""Authenticated server-to-server publication of Reme history snapshots."""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any


class HistoryRelayError(RuntimeError):
    """History snapshot publication failed or was rejected."""


@dataclass(frozen=True, slots=True)
class HistoryRelayPublisher:
    relay_url: str
    token: str
    timeout_seconds: float = 5.0

    def __post_init__(self) -> None:
        parsed = urllib.parse.urlparse(self.relay_url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise HistoryRelayError("history relay URL must be absolute http(s)")
        if not self.token.strip():
            raise HistoryRelayError("history relay token must be non-empty")
        if self.timeout_seconds <= 0:
            raise HistoryRelayError("history relay timeout must be positive")

    def publish_day(self, day_state: dict[str, Any]) -> dict[str, Any]:
        return self._post("api/runtime/reme/day", day_state)

    def publish_summary(self, summary_state: dict[str, Any]) -> dict[str, Any]:
        return self._post("api/runtime/reme/summary", summary_state)

    def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        url = urllib.parse.urljoin(self.relay_url.rstrip("/") + "/", path)
        request = urllib.request.Request(
            url=url,
            data=json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
            method="POST",
            headers={
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
                "Cache-Control": "no-store",
                "User-Agent": "reme-history-loader/1",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                raw = response.read()
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:500]
            raise HistoryRelayError(f"Relay rejected {path}: HTTP {exc.code}: {detail}") from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise HistoryRelayError(f"Relay delivery failed for {path}: {exc}") from exc
        try:
            value = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise HistoryRelayError(f"Relay returned invalid JSON for {path}") from exc
        if not isinstance(value, dict):
            raise HistoryRelayError(f"Relay response for {path} must be an object")
        return value
