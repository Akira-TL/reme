"""OpenClaw inbound-hook transport for Reme's minimized emergency events."""

from __future__ import annotations

import json
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol, cast
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from reme.runtime.integrations.emergency import EmergencyEvent

_RETRYABLE_PRE_RUN_STATUS = frozenset({409, 502, 503})


class MilocoConfigError(ValueError):
    """Raised when the optional OpenClaw hook configuration is malformed."""


class MilocoDeliveryError(RuntimeError):
    """Raised after the adapter cannot safely confirm hook admission."""


class _HttpResponse(Protocol):
    def getcode(self) -> int: ...

    def close(self) -> None: ...


class _HttpOpener(Protocol):
    def __call__(self, request: Request, *, timeout: float) -> _HttpResponse: ...


def _default_opener(request: Request, *, timeout: float) -> _HttpResponse:
    return cast(_HttpResponse, urlopen(request, timeout=timeout))


@dataclass(frozen=True, slots=True)
class MilocoWebhookConfig:
    """Connection settings for one dedicated OpenClaw inbound hook."""

    url: str
    token: str
    timeout_seconds: float = 3.0
    max_attempts: int = 3
    retry_delay_seconds: float = 0.2

    def __post_init__(self) -> None:
        parsed = urlparse(self.url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise MilocoConfigError("url must be an absolute http(s) URL")
        if not self.token.strip():
            raise MilocoConfigError("token must be non-empty")
        if self.timeout_seconds <= 0:
            raise MilocoConfigError("timeout_seconds must be positive")
        if self.max_attempts <= 0:
            raise MilocoConfigError("max_attempts must be positive")
        if self.retry_delay_seconds < 0:
            raise MilocoConfigError("retry_delay_seconds must be non-negative")


class MilocoWebhookTransport:
    """POST minimized events to an OpenClaw hook without exposing Reme internals."""

    def __init__(
        self,
        config: MilocoWebhookConfig,
        *,
        opener: _HttpOpener = _default_opener,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._config = config
        self._opener = opener
        self._sleep = sleep

    def send_event(self, event: EmergencyEvent) -> None:
        """Return only after OpenClaw confirms admission with a 2xx response."""

        request = Request(
            self._config.url,
            data=json.dumps(
                event.to_payload(),
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {self._config.token}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            method="POST",
        )
        for attempt in range(1, self._config.max_attempts + 1):
            try:
                response = self._opener(request, timeout=self._config.timeout_seconds)
            except HTTPError as exc:
                if self._should_retry(exc.code, attempt):
                    self._sleep(self._config.retry_delay_seconds)
                    continue
                raise MilocoDeliveryError(
                    f"OpenClaw hook rejected event with HTTP {exc.code}"
                ) from exc
            except (URLError, TimeoutError, OSError) as exc:
                # The remote side may have admitted the run before the client
                # lost the response. Retrying here could execute one emergency
                # twice, so ambiguous transport failures are intentionally not
                # retried automatically.
                raise MilocoDeliveryError(
                    "delivery outcome unknown after transport failure"
                ) from exc

            try:
                status = response.getcode()
            finally:
                response.close()
            if 200 <= status < 300:
                return
            if self._should_retry(status, attempt):
                self._sleep(self._config.retry_delay_seconds)
                continue
            raise MilocoDeliveryError(f"OpenClaw hook returned HTTP {status}")

        raise MilocoDeliveryError("OpenClaw hook admission retries exhausted")

    def _should_retry(self, status: int, attempt: int) -> bool:
        return status in _RETRYABLE_PRE_RUN_STATUS and attempt < self._config.max_attempts
