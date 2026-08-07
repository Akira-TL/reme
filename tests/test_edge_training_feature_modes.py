import numpy as np
import pytest

from scripts.training.benchmark_edge_bundle import ComputeBudget, EdgeBenchmarkError
from scripts.training.edge_int8_refine import (
    FACE_KEYPOINTS,
    FEATURE_COUNT,
    FEATURE_MODE_KEYPOINTS,
    FEATURE_MODES,
    GEOMETRY_FEATURE_COUNT,
    HEAD_TRACKING_KEYPOINT,
    HEAD_TRACKING_MODES,
    MOVENET_KEYPOINT_NAMES,
    SCORE_OFFSET,
)
from scripts.training.export_edge_bundle import (
    quantize_matrix_per_feature,
    quantize_vector,
)


def _landmark_feature_indices(name: str) -> set[int]:
    keypoint_index = MOVENET_KEYPOINT_NAMES.index(name)
    return {
        keypoint_index * 2,
        keypoint_index * 2 + 1,
        SCORE_OFFSET + keypoint_index,
    }


def test_head_tracking_modes_keep_nose_and_drop_other_face_points() -> None:
    for mode in HEAD_TRACKING_MODES:
        indices = set(int(value) for value in FEATURE_MODES[mode])
        assert _landmark_feature_indices(HEAD_TRACKING_KEYPOINT) <= indices
        assert HEAD_TRACKING_KEYPOINT in FEATURE_MODE_KEYPOINTS[mode]
        for face_keypoint in FACE_KEYPOINTS:
            assert _landmark_feature_indices(face_keypoint).isdisjoint(indices)
            assert face_keypoint not in FEATURE_MODE_KEYPOINTS[mode]


def test_head_tracking_feature_modes_have_stable_compact_sizes() -> None:
    assert FEATURE_MODES["nose_body_geometry"].size == 13 * 3 + GEOMETRY_FEATURE_COUNT
    assert FEATURE_MODES["nose_core_geometry"].size == 9 * 3 + GEOMETRY_FEATURE_COUNT
    for mode in HEAD_TRACKING_MODES:
        indices = FEATURE_MODES[mode]
        assert len(set(int(value) for value in indices)) == indices.size
        assert all(0 <= int(value) < FEATURE_COUNT for value in indices)


def test_linear_heads_use_int16_quantization_with_small_roundtrip_error() -> None:
    matrix = np.asarray([[0.01, -1.3], [2.2, 0.0], [-0.4, 0.8]], dtype=np.float64)
    quantized_matrix, matrix_scales = quantize_matrix_per_feature(matrix)
    assert quantized_matrix.dtype == np.int16
    reconstructed_matrix = quantized_matrix.astype(np.float64) * matrix_scales[:, None]
    assert np.max(np.abs(reconstructed_matrix - matrix)) < 5e-5

    vector = np.asarray([0.0, -3.7, 1.2, 0.05], dtype=np.float64)
    quantized_vector, vector_scale = quantize_vector(vector)
    assert quantized_vector.dtype == np.int16
    reconstructed_vector = quantized_vector.astype(np.float64) * vector_scale
    assert np.max(np.abs(reconstructed_vector - vector)) < 1e-4


def test_one_tops_budget_has_expected_service_time() -> None:
    budget = ComputeBudget(tops=1.0, effective_utilization=0.1)
    assert budget.effective_ops_per_second == pytest.approx(100_000_000_000.0)
    assert budget.service_time_seconds == pytest.approx(0.00541099008)
    assert budget.theoretical_max_fps == pytest.approx(184.809062, rel=1e-6)


@pytest.mark.parametrize(
    ("tops", "utilization"),
    ((0.0, 0.1), (1.0, 0.0), (1.0, 1.01)),
)
def test_one_tops_budget_rejects_invalid_values(
    tops: float,
    utilization: float,
) -> None:
    with pytest.raises(EdgeBenchmarkError):
        ComputeBudget(tops=tops, effective_utilization=utilization)
