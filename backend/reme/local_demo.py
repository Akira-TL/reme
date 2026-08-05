"""Compatibility alias for :mod:`reme.runtime.launcher`."""

from __future__ import annotations

import sys

from reme.runtime import launcher as _launcher

sys.modules[__name__] = _launcher
