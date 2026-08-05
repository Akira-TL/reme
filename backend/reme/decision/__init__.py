"""Compatibility namespace for the relocated decision implementation.

New code belongs under ``reme.runtime.decision``. This package only preserves
existing imports while the repository and external callers migrate.
"""

from reme.runtime import decision as _implementation

__path__ = _implementation.__path__
__all__ = getattr(_implementation, "__all__", ())
