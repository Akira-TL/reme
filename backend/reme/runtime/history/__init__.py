"""Reme family history / memory projection for the public demo.

This package is intentionally separate from ``decision.family_event``.  History
is replayable, date-scoped product data; FamilyEvent remains the current safety
authority.
"""

from reme.runtime.history.projection import (
    DEMO_DATASET_ID,
    DEMO_MODE,
    DEMO_TIMEZONE,
    HistoryContractError,
    ProjectedHistoryFixture,
    load_projected_demo_fixture,
)
from reme.runtime.history.summary import DiarySummaryService

__all__ = [
    "DEMO_DATASET_ID",
    "DEMO_MODE",
    "DEMO_TIMEZONE",
    "DiarySummaryService",
    "HistoryContractError",
    "ProjectedHistoryFixture",
    "load_projected_demo_fixture",
]
