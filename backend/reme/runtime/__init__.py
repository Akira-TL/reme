"""Unified Reme backend runtime.

The runtime owns perception, decision, in-process transport, HTTP exposure, and
local process supervision. Implementations are exposed through
:mod:`reme.runtime.perception` and :mod:`reme.runtime.decision`; the legacy
top-level namespaces are no longer part of the package.
"""
