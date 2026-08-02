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

#: Official COCO keypoint-evaluation sigmas, in COCO's canonical index order.
#: These express *annotator disagreement* about where each joint centre is, so
#: they rank a joint by how ill-defined its location is, not by how noisily a
#: model tracks it.  Source: the COCO keypoint evaluation definition
#: (https://cocodataset.org/#keypoints-eval).
COCO_OKS_SIGMA: tuple[float, ...] = (
    0.026,  # nose
    0.025,  # left_eye
    0.025,  # right_eye
    0.035,  # left_ear
    0.035,  # right_ear
    0.079,  # left_shoulder
    0.079,  # right_shoulder
    0.072,  # left_elbow
    0.072,  # right_elbow
    0.062,  # left_wrist
    0.062,  # right_wrist
    0.107,  # left_hip
    0.107,  # right_hip
    0.087,  # left_knee
    0.087,  # right_knee
    0.089,  # left_ankle
    0.089,  # right_ankle
)

#: Systematic joint-centre bias for hip and knee as a fraction of body height.
#: Needham et al. 2021 (Sci Rep 11:20673, doi:10.1038/s41598-021-00212-x) measured
#: 30-50 mm for hip and knee and 1-15 mm for ankle, and attributed it to
#: large-scale mislabelling of hip joint-centre locations in the datasets used to
#: train these models.  That cause is a property of the training data, so it
#: carries over in kind to MoveNet -- but the magnitude does not transfer
#: exactly: Needham triangulated from a calibrated multi-camera 200 Hz rig, while
#: this project has one uncalibrated view.  Treat as an order of magnitude that
#: needs project calibration, not a measured constant.
NEEDHAM_HIP_KNEE_BIAS_PER_HEIGHT = 0.02

#: Ankle bias from the same study (1-15 mm, midpoint ~8 mm on a 1.7 m subject).
NEEDHAM_ANKLE_BIAS_PER_HEIGHT = 0.005

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
class UncertaintyModel:
    """Per-keypoint localisation uncertainty, split into its physical parts.

    Frame-to-frame jitter is not the whole error and is not even the largest
    part.  A model that places the hip centre in a consistently wrong spot is
    *temporally stable*, so a jitter estimator built on time differences is
    structurally blind to it.  This project's own numbers show exactly that: the
    measured jitter ranks the hips as the calmest core joint, while COCO's
    annotation sigma ranks them the most ill-defined and Needham et al. measured
    the largest systematic offset there.  A confidence built on jitter alone is
    therefore optimistic in a known direction.

    The total combines three independent contributions in quadrature, following
    the GUM treatment of Type A (statistical) and Type B (other evidence)
    uncertainty:

    ``sigma(i)^2 = random(i)^2 + absolute^2 + bias(i)^2``

    ``random`` is measurable from the data and shrinks with filtering;
    ``absolute`` is the heatmap grid floor; ``bias`` neither averages out over
    time nor responds to filtering, so it sets the ceiling on achievable
    confidence no matter how long the observation window is.

    Treating the bias terms of two different keypoints as independent is the
    conservative choice.  A bias common to the whole skeleton would cancel in
    any difference between two points, so this over-states rather than
    under-states uncertainty -- the safe direction for a care system.
    """

    #: Random jitter as a fraction of body pixel height, measured on this
    #: project's clip.
    random_per_height: float = MEASURED_SIGMA_PER_BODY_HEIGHT
    #: Heatmap quantisation floor in pixels.  MoveNet Lightning decodes a 48x48
    #: heatmap with offset regression; the full-image value additionally depends
    #: on whether the producer applied tracking crop, which FrameLandmarks does
    #: not report.  Left at zero until that interface gap is closed, so the
    #: number is never silently invented.
    absolute_px: float = 0.0
    #: Systematic joint-centre bias for hip and knee as a fraction of body
    #: height; other joints are scaled from it by their COCO sigma ratio.
    bias_per_height: float = NEEDHAM_HIP_KNEE_BIAS_PER_HEIGHT
    #: Set False to reproduce the jitter-only behaviour, for comparison only.
    include_bias: bool = True

    def __post_init__(self) -> None:
        for name, value in (
            ("random_per_height", self.random_per_height),
            ("absolute_px", self.absolute_px),
            ("bias_per_height", self.bias_per_height),
        ):
            if not math.isfinite(value) or value < 0.0:
                raise BiomechError(f"{name} must be finite and non-negative")

    def bias_profile(self, body_height_px: float) -> np.ndarray:
        """Return per-keypoint systematic bias in pixels.

        Hip and knee are anchored on the measured 30-50 mm; every other joint is
        extrapolated by its COCO sigma relative to the hip, because COCO sigma
        measures how ill-defined a joint centre is and that is the same property
        the mislabelling acts on.  Only hip, knee and ankle have direct
        literature support; the rest is a documented extrapolation.
        """

        if not self.include_bias:
            return np.zeros(len(COCO17_NAMES), dtype=np.float64)
        hip_sigma = COCO_OKS_SIGMA[LEFT_HIP]
        scale = self.bias_per_height * body_height_px / hip_sigma
        profile = np.asarray(COCO_OKS_SIGMA, dtype=np.float64) * scale
        ankle_bias = NEEDHAM_ANKLE_BIAS_PER_HEIGHT * body_height_px
        profile[LEFT_ANKLE] = ankle_bias
        profile[RIGHT_ANKLE] = ankle_bias
        return profile

    def sigma_profile(self, body_height_px: float) -> np.ndarray:
        """Return the total per-keypoint standard uncertainty in pixels."""

        random_term = self.random_per_height * body_height_px
        bias = self.bias_profile(body_height_px)
        total: np.ndarray = np.sqrt(random_term**2 + self.absolute_px**2 + bias**2)
        return total

    def to_payload(self) -> dict[str, object]:
        return {
            "random_per_height": round(self.random_per_height, 6),
            "absolute_px": round(self.absolute_px, 4),
            "bias_per_height": round(self.bias_per_height, 6),
            "include_bias": self.include_bias,
            "bias_source": (
                "Needham 2021 doi:10.1038/s41598-021-00212-x, hip/knee 30-50 mm; "
                "magnitude needs project calibration"
            ),
        }


DEFAULT_UNCERTAINTY = UncertaintyModel()


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
    uncertainty: UncertaintyModel = DEFAULT_UNCERTAINTY

    @property
    def representative_sigma_px(self) -> float:
        """Return the median sigma over usable keypoints, for scale gating."""

        if not bool(self.usable.any()):
            return float(np.median(self.sigma_px))
        return float(np.median(self.sigma_px[self.usable]))

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
    uncertainty: UncertaintyModel = DEFAULT_UNCERTAINTY,
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
    sigma_profile = _resolve_sigma_profile(
        coords, usable, sigma_px=sigma_px, uncertainty=uncertainty
    )

    return FrameGeometry(
        scene_id=_text(record.get("scene_id", "unknown-scene"), "scene_id"),
        frame_index=_index(record.get("frame_index"), "frame_index"),
        timestamp_ms=_finite(record.get("timestamp_ms"), "timestamp_ms"),
        person_detected=detected,
        landmark_quality=str(quality),
        xy=coords,
        score=scores,
        usable=usable,
        sigma_px=sigma_profile,
        image=image,
        uncertainty=uncertainty,
    )


def _resolve_sigma_profile(
    coords: np.ndarray,
    usable: np.ndarray,
    *,
    sigma_px: float | None,
    uncertainty: UncertaintyModel,
) -> np.ndarray:
    """Return the per-keypoint localisation sigma in pixels.

    MoveNet's ``score`` correlates only weakly with actual localisation error
    (measured -0.31 on this project's clip), so it is used as a usability filter
    and never converted into a sigma.  The uncertainty instead scales with the
    person's observed pixel height, so a subject further from the camera
    correctly becomes less certain rather than falsely more precise.

    Passing ``sigma_px`` overrides everything with one flat value; it exists for
    tests and for comparing against the jitter-only behaviour, not for
    production use.
    """

    if sigma_px is not None:
        if not math.isfinite(sigma_px) or sigma_px <= 0.0:
            raise BiomechError("sigma_px must be finite and positive")
        return np.full(len(COCO17_NAMES), float(sigma_px), dtype=np.float64)
    return uncertainty.sigma_profile(body_scale_px(coords, usable))


def body_scale_px(coords: np.ndarray, usable: np.ndarray) -> float:
    """Return a posture-invariant body scale in pixels.

    Vertical extent is the obvious choice and the wrong one: a seated or lying
    person occupies fewer rows, which would shrink the estimated scale and make
    every derived uncertainty *smaller* exactly in the postures the classifier is
    least sure about -- confidence rising because the person lay down.

    The maximum pairwise distance across the core skeleton is used instead.  It
    measures the same body span whichever way the body is oriented, and it
    excludes the arms, whose reach would otherwise inflate the scale whenever
    someone stretches.
    """

    indices = [index for index in BODY_AXIS_INDICES if bool(usable[index])]
    if len(indices) < 2:
        return MEASURED_BODY_HEIGHT_PX
    points = coords[indices]
    differences = points[:, None, :] - points[None, :, :]
    span = float(np.sqrt((differences**2).sum(axis=2)).max())
    return span if span > 1.0 else MEASURED_BODY_HEIGHT_PX


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
    representative = float(np.sqrt(np.mean(frame.sigma_px[usable_indices] ** 2)))
    sigma_axis = math.degrees(representative / math.sqrt(spread))

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
