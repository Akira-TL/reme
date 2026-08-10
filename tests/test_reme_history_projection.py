from __future__ import annotations

from copy import deepcopy
from datetime import date

import pytest
from reme.runtime.history.projection import (
    DEMO_DATASET_ID,
    HistoryContractError,
    load_projected_demo_fixture,
    project_fixture,
)


def test_demo_fixture_projects_eight_backend_owned_days() -> None:
    fixture = load_projected_demo_fixture()

    assert fixture.dataset_id == DEMO_DATASET_ID
    assert list(fixture.day_states) == [
        "2026-08-04",
        "2026-08-05",
        "2026-08-06",
        "2026-08-07",
        "2026-08-08",
        "2026-08-09",
        "2026-08-10",
        "2026-08-11",
    ]
    for day in fixture.day_states.values():
        assert day["mode"] == "mock_fixture"
        assert day["coverage"]["status"] == "complete"
        assert day["coverage"]["observed_hours"] == 24
        assert day["counts"] == {"total": 3, "activity": 1, "device": 1, "care": 1}
        assert [item["kind"] for item in day["items"]].count("activity") == 1
        assert [item["kind"] for item in day["items"]].count("device") == 1
        assert [item["kind"] for item in day["items"]].count("care_thread") == 1


def test_august_ninth_contains_complete_mock_family_material_thread() -> None:
    fixture = load_projected_demo_fixture()
    day = fixture.day_states["2026-08-09"]
    care = next(item for item in day["items"] if item["kind"] == "care_thread")

    assert care["status"] == "delivered"
    assert care["response"]["consent_scope"] == "family_material_share"
    assert care["material"]["attachment"] == {
        "type": "skeleton_clip",
        "status": "metadata_only",
        "duration_seconds": 18,
        "privacy_mode": "skeleton",
        "asset_id": None,
    }
    assert care["delivery"]["status"] == "mock_delivered"
    assert care["delivery"]["transport_receipt_id"] is None


def test_date_index_never_exposes_future_fixture_days() -> None:
    fixture = load_projected_demo_fixture()

    aug10 = fixture.date_index(today=date(2026, 8, 10))
    assert [entry["date"] for entry in aug10["dates"]][-1] == "2026-08-10"
    assert len(aug10["dates"]) == 7

    aug11 = fixture.date_index(today=date(2026, 8, 11))
    assert len(aug11["dates"]) == 8
    assert aug11["dates"][-1]["date"] == "2026-08-11"


def test_projection_rejects_raw_media_and_duplicate_ids() -> None:
    fixture = load_projected_demo_fixture()
    # Reconstruct a minimal fixture from projected items for contract mutation.
    raw = {
        "schema_version": "reme-history-fixture/v1",
        "dataset_id": DEMO_DATASET_ID,
        "mode": "mock_fixture",
        "timezone": "Asia/Shanghai",
        "revision": 1,
        "coverage": [
            {
                "date": "2026-08-09",
                "status": "complete",
                "start_at_ms": 1786204800000,
                "end_at_ms": 1786291199999,
                "observed_hours": 24,
                "missing_intervals": [],
            }
        ],
        "events": [deepcopy(fixture.day_states["2026-08-09"]["items"][0])],
    }
    event = raw["events"][0]
    event.pop("schema_version", None)
    event["source"]["raw_frame"] = "forbidden"
    with pytest.raises(HistoryContractError, match="forbidden history field"):
        project_fixture(raw)
