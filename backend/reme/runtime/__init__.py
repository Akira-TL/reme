"""Unified Reme backend runtime.

The runtime owns perception, decision, in-process transport, HTTP exposure, and
local process supervision. Compatibility namespaces under :mod:`reme.pose` and
:mod:`reme.decision` remain temporarily for existing imports; they are not
standalone services or executable entry points.
"""
