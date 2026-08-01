"""Biomechanical quantities and uncertainty for one COCO-17 frame.

This module is the L1 layer of the explainable posture classifier: it turns one
of A's ``FrameLandmarks`` records into named physical quantities, each carrying
its own propagated uncertainty and a provenance tag.  It deliberately computes
*only* quantities that a single uncalibrated monocular view can support.

Three rules are enforced structurally rather than by convention:

1. **Pixels before angles.**  ``x_norm`` is normalised by image width and
   ``y_norm`` by image height, so an angle taken directly on the normalised
   pair is wrong whenever the image is not square.  At 16:9 a true 45 deg
   reads as 29.4 deg.  Every angle here is computed in pixel space, and the
   image size must be supplied explicitly (see :class:`ImageGeometry`).
2. **No force, no contact, no depth.**  Nothing here estimates centre of
   pressure, zero-moment point, ground reaction force, the base of support, or
   a metric centre of mass.  ``com2d`` is an image-plane pseudo-centroid and is
   named as such; it is a consistency aid, never a balance criterion.
3. **Every number carries an uncertainty.**  A quantity whose uncertainty is
   too large for the decision it would feed must be refused upstream rather
   than silently used.

Uncertainty propagation follows the first-order (GUM) treatment; see
``.scratch/posture-classifier-theory/notes/measurement-error.md`` for the
Monte-Carlo validation of each closed form, and ``data-reality.md`` for the
measured noise floor this project actually observes.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Literal, cast

import numpy as np

FEATURE_SCHEMA_VERSION = "reme-biomech/v0-experiment"

COCO17_NAMES: tuple[str, ...] = (
    "nose",
    "left_eye",
    "right_eye",
    "left_ear",
    "right_ear",
    "left_shoulder",
    "right_shoulder",
    "left_elbow",
    "right_elbow",
    "left_wrist",
    "right_wrist",
    "left_hip",
    "right_hip",
    "left_knee",
    "right_knee",
    "left_ankle",
    "right_ankle",
)

NOSE = 0
LEFT_SHOULDER, RIGHT_SHOULDER = 5, 6
LEFT_ELBOW, RIGHT_ELBOW = 7, 8
LEFT_WRIST, RIGHT_WRIST = 9, 10
LEFT_HIP, RIGHT_HIP = 11, 12
LEFT_KNEE, RIGHT_KNEE = 13, 14
LEFT_ANKLE, RIGHT_ANKLE = 15, 16

#: Points spanning the whole body, used for the *body long axis* that decides
#: recumbency.  Legs belong here: lying is a statement about the whole body.
BODY_AXIS_INDICES: tuple[int, ...] = (
    NOSE,
    LEFT_SHOULDER,
    RIGHT_SHOULDER,
    LEFT_HIP,
    RIGHT_HIP,
    LEFT_KNEE,
    RIGHT_KNEE,
    LEFT_ANKLE,
    RIGHT_ANKLE,
)

#: Points spanning head and torso only, used for *trunk* orientation.  Legs are
#: excluded because they are a different rigid body: seated, the whole-body
#: cloud is L-shaped and its principal axis is a compromise between a vertical
#: trunk and near-horizontal thighs, which describes neither.  Bending moves the
#: trunk while the legs stay put, so leg points dilute exactly the signal the
#: trunk criteria are trying to read.
TRUNK_AXIS_INDICES: tuple[int, ...] = (
    NOSE,
    LEFT_SHOULDER,
    RIGHT_SHOULDER,
    LEFT_HIP,
    RIGHT_HIP,
)

#: Measured on the project's only real clip (2370 frames, MoveNet Lightning
#: FP16, 1280x720): MAD-based second-difference estimate of per-keypoint
#: localisation noise, median over shoulders/hips/knees/ankles.  Recorded in
#: ``.scratch/posture-classifier-theory/data-reality.md`` section 6.
MEASURED_SIGMA_PX_AT_720P = 1.31

#: Body pixel height (nose to ankle) on that same clip, used to express the
#: measured sigma as a scale-free fraction of body height.
MEASURED_BODY_HEIGHT_PX = 318.9

#: Scale-free localisation noise: sigma as a fraction of body pixel height.
MEASURED_SIGMA_PER_BODY_HEIGHT = MEASURED_SIGMA_PX_AT_720P / MEASURED_BODY_HEIGHT_PX

#: Frontal biacromial-width to trunk-length expectation, from Winter's segment
#: proportions (shoulder breadth ~0.245 of stature, shoulder-to-hip ~0.288).
#: Used only as the normaliser of the azimuth proxy, never as a classification
#: threshold.
FRONTAL_SHOULDER_TO_TRUNK = 0.85

Provenance = Literal["measured", "derived", "literature", "pending_calibration", "assumed"]

Support = Literal["supports", "opposes", "inconclusive"]


class BiomechError(ValueError):
    """Raised when a frame cannot be turned into trustworthy geometry."""


@dataclass(frozen=True, slots=True)
class Quantity:
    """One physical quantity with its first-order standard uncertainty."""

    name: str
    value: float
    sigma: float
    unit: str
    provenance: Provenance
    note: str = ""

    def __post_init__(self) -> None:
        if not math.isfinite(self.value):
            raise BiomechError(f"{self.name}: value must be finite")
        if not math.isfinite(self.sigma) or self.sigma < 0.0:
            raise BiomechError(f"{self.name}: sigma must be finite and non-negative")

    def below(self, threshold: float, *, coverage: float = 1.96) -> bool:
        """Return True only when the whole coverage interval is below ``threshold``."""

        return self.value + coverage * self.sigma <= threshold

    def above(self, threshold: float, *, coverage: float = 1.96) -> bool:
        """Return True only when the whole coverage interval is above ``threshold``."""

        return self.value - coverage * self.sigma >= threshold

    def to_payload(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "value": round(self.value, 4),
            "sigma": round(self.sigma, 4),
            "unit": self.unit,
            "provenance": self.provenance,
        }
        if self.note:
            payload["note"] = self.note
        return payload


@dataclass(frozen=True, slots=True)
class ImageGeometry:
    """Pixel geometry and gravity direction for one scene.

    ``FrameLandmarks`` does not carry the source image size, so a consumer
    cannot recover the pixel aspect ratio from the record alone.  Rather than
    guessing silently, this type records whether the size was supplied by the
    producer or assumed, and that flag travels into the evidence payload.
    """

    width: int
    height: int
    size_provenance: Provenance = "assumed"
    gravity_x: float = 0.0
    gravity_y: float = 1.0
    gravity_provenance: Provenance = "assumed"

    def __post_init__(self) -> None:
        if self.width <= 0 or self.height <= 0:
            raise BiomechError("image width and height must be positive")
        norm = math.hypot(self.gravity_x, self.gravity_y)
        if not math.isfinite(norm) or norm <= 0.0:
            raise BiomechError("gravity direction must be a non-zero finite vector")
        if abs(norm - 1.0) > 1e-6:
            raise BiomechError("gravity direction must be a unit vector")

    @property
    def gravity(self) -> np.ndarray:
        """Return the image-space unit vector pointing along gravity."""

        return np.asarray([self.gravity_x, self.gravity_y], dtype=np.float64)

    def to_payload(self) -> dict[str, object]:
        return {
            "width": self.width,
            "height": self.height,
            "size_provenance": self.size_provenance,
            "gravity": [round(self.gravity_x, 6), round(self.gravity_y, 6)],
            "gravity_provenance": self.gravity_provenance,
        }


@dataclass(frozen=True, slots=True)
class FrameGeometry:
    """One frame lifted into pixel space with per-keypoint uncertainty."""

    scene_id: str
    frame_index: int
    timestamp_ms: float
    person_detected: bool
    landmark_quality: str
    xy: np.ndarray
    score: np.ndarray
    usable: np.ndarray
    sigma_px: np.ndarray
    image: ImageGeometry

    @property
    def usable_ratio(self) -> float:
        return float(self.usable.mean())

    def point(self, index: int) -> np.ndarray:
        return cast(np.ndarray, self.xy[index])

    def has(self, *indices: int) -> bool:
        return all(bool(self.usable[index]) for index in indices)

    def midpoint(self, first: int, second: int) -> np.ndarray | None:
        if not self.has(first, second):
            return None
        return cast(np.ndarray, (self.xy[first] + self.xy[second]) * 0.5)

    def midpoint_sigma(self, first: int, second: int) -> float:
        """Return the uncertainty of a two-point midpoint (independent errors)."""

        return 0.5 * math.hypot(float(self.sigma_px[first]), float(self.sigma_px[second]))


def parse_frame_record(
    record: dict[str, Any],
    *,
    image: ImageGeometry,
    score_threshold: float = 0.2,
    sigma_px: float | None = None,
) -> FrameGeometry:
    """Parse one FrameLandmarks record into pixel-space geometry.

    Two record shapes exist in this repository and both are accepted: the
    implemented ``schema_version``/``person_detected`` shape emitted by
    ``reme.pose.camera``, and the ``schema``/``torso_detected`` shape written by
    the ADR-0003 fixture.  Unknown extra keys are ignored so that producers can
    add fields without breaking this consumer.

    ``sigma_px`` overrides the per-keypoint localisation noise.  When omitted it
    is scaled from the project's measured noise floor by the observed body pixel
    height, so a person further from the camera correctly gets a larger angular
    uncertainty rather than a falsely confident one.
    """

    if not isinstance(record, dict):
        raise BiomechError("frame record must be an object")
    if not 0.0 <= score_threshold <= 1.0:
        raise BiomechError("score_threshold must be between 0 and 1")

    raw_points = record.get("keypoints")
    if not isinstance(raw_points, list) or len(raw_points) != len(COCO17_NAMES):
        raise BiomechError("frame record must contain exactly 17 keypoints")

    coords = np.zeros((len(COCO17_NAMES), 2), dtype=np.float64)
    scores = np.zeros(len(COCO17_NAMES), dtype=np.float64)
    for index, item in enumerate(raw_points):
        if not isinstance(item, dict):
            raise BiomechError(f"keypoints[{index}] must be an object")
        name = item.get("name")
        if name is not None and name != COCO17_NAMES[index]:
            raise BiomechError(
                f"keypoints[{index}] must be {COCO17_NAMES[index]!r}, got {name!r}"
            )
        x_norm = _finite(item.get("x_norm"), f"keypoints[{index}].x_norm")
        y_norm = _finite(item.get("y_norm"), f"keypoints[{index}].y_norm")
        score = _finite(item.get("score"), f"keypoints[{index}].score")
        if not 0.0 <= score <= 1.0:
            raise BiomechError(f"keypoints[{index}].score must be between 0 and 1")
        coords[index, 0] = x_norm * image.width
        coords[index, 1] = y_norm * image.height
        scores[index] = score

    detected = record.get("person_detected")
    if detected is None:
        detected = record.get("torso_detected")
    if not isinstance(detected, bool):
        raise BiomechError("record must carry a boolean person_detected or torso_detected")

    quality = record.get("landmark_quality")
    if quality is None:
        quality = "usable" if detected else "unavailable"
    if quality not in ("usable", "degraded", "unavailable"):
        raise BiomechError("landmark_quality is invalid")

    usable = scores >= score_threshold
    resolved_sigma = _resolve_sigma(coords, usable, sigma_px=sigma_px)

    return FrameGeometry(
        scene_id=_text(record.get("scene_id", "unknown-scene"), "scene_id"),
        frame_index=_index(record.get("frame_index"), "frame_index"),
        timestamp_ms=_finite(record.get("timestamp_ms"), "timestamp_ms"),
        person_detected=detected,
        landmark_quality=str(quality),
        xy=coords,
        score=scores,
        usable=usable,
        sigma_px=np.full(len(COCO17_NAMES), resolved_sigma, dtype=np.float64),
        image=image,
    )


def _resolve_sigma(
    coords: np.ndarray, usable: np.ndarray, *, sigma_px: float | None
) -> float:
    """Return per-keypoint localisation sigma in pixels.

    MoveNet's ``score`` correlates only weakly with actual localisation error
    (measured -0.31 on this project's clip), so it is used as a usability filter
    and never converted into a sigma.  The fallback instead scales the measured
    noise fraction by the person's observed pixel height.
    """

    if sigma_px is not None:
        if not math.isfinite(sigma_px) or sigma_px <= 0.0:
            raise BiomechError("sigma_px must be finite and positive")
        return float(sigma_px)
    if not bool(usable.any()):
        return MEASURED_SIGMA_PX_AT_720P
    visible = coords[usable]
    body_height = float(visible[:, 1].max() - visible[:, 1].min())
    if body_height <= 1.0:
        return MEASURED_SIGMA_PX_AT_720P
    return MEASURED_SIGMA_PER_BODY_HEIGHT * body_height


def segment_angle_from_gravity(
    frame: FrameGeometry, proximal: int, distal: int, *, name: str
) -> Quantity | None:
    """Return the acute angle between a two-point segment and gravity.

    Returns ``None`` when either endpoint is unusable.  The uncertainty is the
    first-order propagation ``sigma_theta = hypot(sigma_a, sigma_b) / L``; it
    grows without bound as the projected segment shortens, which is exactly the
    behaviour that makes short segments refuse themselves downstream.
    """

    if not frame.has(proximal, distal):
        return None
    vector = frame.xy[distal] - frame.xy[proximal]
    length = float(np.linalg.norm(vector))
    if length <= 1e-9:
        return None
    gravity = frame.image.gravity
    cosine = abs(float(np.dot(vector, gravity))) / length
    angle = math.degrees(math.acos(min(1.0, max(0.0, cosine))))
    sigma = math.degrees(
        math.hypot(float(frame.sigma_px[proximal]), float(frame.sigma_px[distal])) / length
    )
    return Quantity(
        name=name,
        value=angle,
        sigma=sigma,
        unit="deg",
        provenance="derived",
        note=f"projected segment length {length:.1f} px",
    )


def joint_angle(
    frame: FrameGeometry, first: int, vertex: int, last: int, *, name: str
) -> Quantity | None:
    """Return the interior joint angle at ``vertex`` with propagated uncertainty.

    The shared vertex correlates the two edge directions, so the uncertainty is
    not the sum of two independent segment-angle errors.  The closed form used
    here keeps the ``-2 cos(theta)/(L1 L2)`` cross term.
    """

    if not frame.has(first, vertex, last):
        return None
    edge_a = frame.xy[first] - frame.xy[vertex]
    edge_b = frame.xy[last] - frame.xy[vertex]
    length_a = float(np.linalg.norm(edge_a))
    length_b = float(np.linalg.norm(edge_b))
    if length_a <= 1e-9 or length_b <= 1e-9:
        return None
    cosine = float(np.dot(edge_a, edge_b)) / (length_a * length_b)
    cosine = min(1.0, max(-1.0, cosine))
    angle = math.acos(cosine)
    sigma_a = float(frame.sigma_px[first])
    sigma_b = float(frame.sigma_px[last])
    sigma_v = float(frame.sigma_px[vertex])
    variance = (sigma_a / length_a) ** 2 + (sigma_b / length_b) ** 2
    variance += sigma_v**2 * (
        1.0 / length_a**2 + 1.0 / length_b**2 - 2.0 * cosine / (length_a * length_b)
    )
    return Quantity(
        name=name,
        value=math.degrees(angle),
        sigma=math.degrees(math.sqrt(max(0.0, variance))),
        unit="deg",
        provenance="derived",
        note=f"edges {length_a:.1f}/{length_b:.1f} px",
    )


def principal_axis_angle(
    frame: FrameGeometry,
    *,
    indices: tuple[int, ...] = BODY_AXIS_INDICES,
    name: str = "body_long_axis_from_gravity",
    minimum_points: int = 4,
) -> tuple[Quantity, Quantity] | None:
    """Return a point cloud's principal-axis tilt from gravity and its elongation.

    The principal axis of the core keypoint cloud is a markedly more precise
    orientation estimate than the two-point shoulder-to-hip vector, because its
    uncertainty falls as ``sigma / sqrt(sum((t - t_mean)^2))`` over all
    contributing points rather than as ``sigma / L`` over one segment.  Limb
    points are excluded because their configuration biases the axis.

    The second returned quantity is the elongation ``sqrt(l1 / l2)`` of the
    point cloud, which distinguishes a genuinely elongated body from a
    foreshortened blob whose axis direction is numerically meaningless.
    """

    usable_indices = [index for index in indices if bool(frame.usable[index])]
    if len(usable_indices) < minimum_points:
        return None
    points = frame.xy[usable_indices]
    centre = points.mean(axis=0)
    centred = points - centre
    covariance = centred.T @ centred / float(len(usable_indices))
    eigenvalues, eigenvectors = np.linalg.eigh(covariance)
    order = np.argsort(eigenvalues)[::-1]
    eigenvalues = eigenvalues[order]
    principal = eigenvectors[:, order[0]]

    major = float(max(eigenvalues[0], 0.0))
    minor = float(max(eigenvalues[1], 0.0))
    if major <= 1e-12:
        return None
    elongation = math.sqrt(major / minor) if minor > 1e-12 else float("inf")
    if not math.isfinite(elongation):
        elongation = 1e6

    spread = float((centred @ principal) @ (centred @ principal))
    if spread <= 1e-9:
        return None
    sigma_axis = math.degrees(float(frame.sigma_px[usable_indices[0]]) / math.sqrt(spread))

    gravity = frame.image.gravity
    cosine = abs(float(np.dot(principal, gravity)))
    angle = math.degrees(math.acos(min(1.0, max(0.0, cosine))))
    axis = Quantity(
        name=name,
        value=angle,
        sigma=sigma_axis,
        unit="deg",
        provenance="derived",
        note=f"{len(usable_indices)} points",
    )
    shape = Quantity(
        name=f"{name}_elongation",
        value=elongation,
        sigma=0.0,
        unit="ratio",
        provenance="derived",
        note="sqrt(major/minor) of the point cloud",
    )
    return axis, shape


def sagittal_observability(frame: FrameGeometry) -> Quantity | None:
    """Return how much of the sagittal plane survives projection, in [0, 1].

    Under a weak-perspective assumption the observed biacromial-width to
    trunk-length ratio shrinks as the subject turns towards the camera axis.
    Comparing it with the frontal anthropometric expectation gives a proxy for
    the trunk azimuth, and ``sin(azimuth)`` states how much sagittal-plane
    motion still projects into the image.

    This is a proxy, not a measurement: perspective, trunk twist, shoulder
    occlusion, individual shoulder breadth and clothing all break it.  A ratio
    above the frontal expectation means the model itself is inconsistent, which
    is reported as zero confidence rather than clamped to a confident zero.
    """

    shoulders = frame.midpoint(LEFT_SHOULDER, RIGHT_SHOULDER)
    hips = frame.midpoint(LEFT_HIP, RIGHT_HIP)
    if shoulders is None or hips is None:
        return None
    trunk_length = float(np.linalg.norm(shoulders - hips))
    if trunk_length <= 1e-6:
        return None
    width = float(np.linalg.norm(frame.xy[LEFT_SHOULDER] - frame.xy[RIGHT_SHOULDER]))
    ratio = width / trunk_length
    frontal = FRONTAL_SHOULDER_TO_TRUNK
    if ratio > frontal * 1.25:
        return Quantity(
            name="sagittal_observability",
            value=0.0,
            sigma=0.0,
            unit="ratio",
            provenance="derived",
            note=f"model inconsistent: shoulder/trunk {ratio:.2f} exceeds frontal {frontal:.2f}",
        )
    frontal_component = min(1.0, max(0.0, ratio / frontal))
    value = math.sqrt(max(0.0, 1.0 - frontal_component**2))
    return Quantity(
        name="sagittal_observability",
        value=value,
        sigma=0.0,
        unit="ratio",
        provenance="derived",
        note=f"shoulder/trunk {ratio:.2f} vs frontal expectation {frontal:.2f}",
    )


def leg_extension_ratio(frame: FrameGeometry, side: Literal["left", "right"]) -> Quantity | None:
    """Return the projected vertical extension of one leg, normalised by its length.

    Defined as the gravity-aligned hip-to-ankle displacement divided by the
    summed thigh and shank projected lengths.  It approaches 1 for a straight
    vertical leg and falls as the leg folds, and being a ratio of two lengths it
    is free of the metric scale that a monocular view cannot supply.
    """

    hip, knee, ankle = (
        (LEFT_HIP, LEFT_KNEE, LEFT_ANKLE)
        if side == "left"
        else (RIGHT_HIP, RIGHT_KNEE, RIGHT_ANKLE)
    )
    if not frame.has(hip, knee, ankle):
        return None
    thigh = float(np.linalg.norm(frame.xy[knee] - frame.xy[hip]))
    shank = float(np.linalg.norm(frame.xy[ankle] - frame.xy[knee]))
    chain = thigh + shank
    if chain <= 1e-6:
        return None
    gravity = frame.image.gravity
    extension = float(np.dot(frame.xy[ankle] - frame.xy[hip], gravity)) / chain
    sigma_component = math.hypot(float(frame.sigma_px[hip]), float(frame.sigma_px[ankle]))
    return Quantity(
        name=f"{side}_leg_extension",
        value=extension,
        sigma=sigma_component / chain,
        unit="ratio",
        provenance="derived",
        note=f"thigh {thigh:.1f} px, shank {shank:.1f} px",
    )


DEFAULT_ROLL_TOLERANCE_DEG = 3.0


def vertical_order_margin(
    frame: FrameGeometry,
    upper: int,
    lower: int,
    *,
    name: str,
    roll_tolerance_deg: float = DEFAULT_ROLL_TOLERANCE_DEG,
) -> Quantity | None:
    """Return how far ``lower`` sits below ``upper`` along gravity, in pixels.

    A positive value means the expected standing order holds.  This is reported
    as a signed margin with an uncertainty rather than a boolean so that a
    near-tie is visible as inconclusive instead of silently deciding.

    Random keypoint jitter is not the dominant error here.  When gravity has not
    been calibrated, an unknown camera roll rotates the measurement axis, and
    that error scales with the *perpendicular* separation of the two points: a
    pair 100 px apart horizontally shifts by about 1.7 px per degree of roll,
    which swamps the sub-pixel jitter.  Seated, where hip and knee are far apart
    horizontally and nearly level vertically, this is the difference between a
    confident wrong answer and an honest abstention, so the roll term is carried
    in the uncertainty rather than assumed away.
    """

    if not frame.has(upper, lower):
        return None
    gravity = frame.image.gravity
    delta = frame.xy[lower] - frame.xy[upper]
    margin = float(np.dot(delta, gravity))
    perpendicular = abs(float(delta[0] * gravity[1] - delta[1] * gravity[0]))
    jitter = math.hypot(float(frame.sigma_px[upper]), float(frame.sigma_px[lower]))
    roll_term = (
        0.0
        if frame.image.gravity_provenance == "measured"
        else perpendicular * math.sin(math.radians(roll_tolerance_deg))
    )
    return Quantity(
        name=name,
        value=margin,
        sigma=math.hypot(jitter, roll_term),
        unit="px",
        provenance="derived",
        note=f"jitter {jitter:.2f} px, roll term {roll_term:.2f} px",
    )


def min_segment_length_for_angle_budget(sigma_px: float, budget_deg: float) -> float:
    """Return the shortest two-point segment whose angle meets a 1-sigma budget.

    Inverting ``sigma_theta = sqrt(2) sigma / L``.  With this project's measured
    ``sigma = 1.31 px`` a 5 deg budget needs about 21 px, and a 10 deg budget
    about 11 px; below that the angle carries no usable information.
    """

    if sigma_px <= 0.0 or budget_deg <= 0.0:
        raise BiomechError("sigma_px and budget_deg must be positive")
    return math.sqrt(2.0) * sigma_px / math.radians(budget_deg)


def _finite(value: object, field_name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise BiomechError(f"{field_name} must be numeric")
    number = float(value)
    if not math.isfinite(number):
        raise BiomechError(f"{field_name} must be finite")
    return number


def _index(value: object, field_name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise BiomechError(f"{field_name} must be a non-negative integer")
    return value


def _text(value: object, field_name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise BiomechError(f"{field_name} must be a non-empty string")
    return value.strip()
