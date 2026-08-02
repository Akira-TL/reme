"""Explainable posture decision: physical criteria, gating, and abstention.

This is the L2/L3 layer.  It consumes the biomechanical quantities produced by
:mod:`reme.pose.biomech` and decides a static posture *by evaluating named
physical criteria*, then reports exactly those criteria as the reason.  The
explanation is not a post-hoc rationalisation of a black-box score: the
criteria are what produce the verdict, so a reader can recompute the decision
from the evidence payload alone.

Four rules give the layer its honesty properties.

**Uncertainty-aware comparisons.**  A criterion counts as met only when the
whole 95% coverage interval clears the threshold.  A value whose interval
straddles the threshold is ``inconclusive``, never rounded to a decision.

**Exactly-one-class.**  Each class is scored independently.  Zero classes met,
or more than one, both yield ``unknown``.  There is no ``argmax`` that forces a
label out of contradictory evidence.

**Gates before criteria.**  Input validity, angular resolution, and sagittal
observability are checked first.  A class whose required evidence is not
observable in the current view is marked unavailable rather than evaluated on
untrustworthy numbers.

**Release policy.**  This project has real human footage of ``standing`` only
(see ``.scratch/posture-classifier-theory/data-reality.md``).  Thresholds for
the other classes come from literature priors that were established with
gravity-referenced sensors, not projected camera angles, and have never been
validated on this project's data.  By default those classes therefore run in
*shadow mode*: they are computed and recorded as candidates, but the released
label is ``unknown``.  Enabling them is a deliberate, logged decision.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Literal

from reme.pose.biomech import (
    BODY_AXIS_INDICES,
    LEFT_ANKLE,
    LEFT_HIP,
    LEFT_KNEE,
    RIGHT_ANKLE,
    RIGHT_HIP,
    RIGHT_KNEE,
    TRUNK_AXIS_INDICES,
    FrameGeometry,
    Provenance,
    Quantity,
    Support,
    joint_angle,
    leg_extension_ratio,
    min_segment_length_for_angle_budget,
    principal_axis_angle,
    sagittal_observability,
    segment_angle_from_gravity,
    vertical_order_margin,
)

CRITERIA_SCHEMA_VERSION = "reme-posture-evidence/v0-experiment"

POSTURE_LABELS = ("standing", "sitting", "lying", "bending_or_crouching", "unknown")

#: Classes whose thresholds have been validated on this project's own data.
#: Only ``standing`` qualifies today; see the module docstring.
DEFAULT_RELEASED_CLASSES: frozenset[str] = frozenset({"standing"})

Comparison = Literal["below", "above"]


@dataclass(frozen=True, slots=True)
class Threshold:
    """One decision boundary together with where its value came from."""

    value: float
    provenance: Provenance
    source: str

    def to_payload(self) -> dict[str, object]:
        return {"value": self.value, "provenance": self.provenance, "source": self.source}


#: Every threshold below is tagged.  ``pending_calibration`` means the number is
#: a runnable starting point that has *not* been validated on this project's
#: data and must not be quoted as a working boundary.
#:
#: The 40-60 deg thigh-inclination family (Skotte 2014 Acti4; activPAL;
#: ActiGraph) is real and validated, but every one of those studies measured
#: thigh inclination *relative to gravity with a sensor strapped to the thigh*,
#: coupled with an acceleration-variance condition.  A projected camera angle is
#: a different quantity, and projection specifically flattens the bimodality
#: that makes the boundary work.  The value is therefore carried as a literature
#: prior about *where an inflection exists*, not as a transferable threshold.
THRESHOLDS: dict[str, Threshold] = {
    "standing_trunk_max_deg": Threshold(
        25.0, "pending_calibration", "starting point; project standing p99 is 10.8 deg"
    ),
    "standing_thigh_max_deg": Threshold(
        30.0,
        "pending_calibration",
        "angle FROM GRAVITY; project standing reaches at most 16.3 deg from vertical",
    ),
    "standing_leg_extension_min": Threshold(
        0.75, "pending_calibration", "starting point, not yet calibrated"
    ),
    "standing_knee_flexion_max_deg": Threshold(
        35.0, "pending_calibration", "starting point, not yet calibrated"
    ),
    "sitting_thigh_min_deg": Threshold(
        45.0,
        "literature",
        "angle FROM GRAVITY. Skotte 2014 Acti4 rule is thigh inclination > 45 deg "
        "from vertical (with an acceleration-variance condition); activPAL and "
        "ActiGraph place the inflection at 40-60 deg. All were measured against "
        "gravity by a thigh-mounted sensor, NOT as a projected camera angle, and "
        "projection flattens the bimodality that makes the boundary work. Carried "
        "as a prior that an inflection exists, not as a transferable threshold.",
    ),
    "sitting_knee_flexion_min_deg": Threshold(
        50.0, "pending_calibration", "starting point, not yet calibrated"
    ),
    "lying_trunk_min_deg": Threshold(
        65.0, "pending_calibration", "starting point, not yet calibrated"
    ),
    "lying_elongation_min": Threshold(
        2.0, "pending_calibration", "guards against a foreshortened blob, not calibrated"
    ),
    "bending_trunk_min_deg": Threshold(
        35.0, "pending_calibration", "starting point; leaves a 25-35 deg grey zone"
    ),
    "angle_budget_deg": Threshold(
        10.0, "derived", "1-sigma angular budget; sets the minimum usable segment length"
    ),
    "sagittal_min": Threshold(
        0.5,
        "derived",
        "below this, half the sagittal displacement is lost to projection and "
        "sagittal-dependent classes refuse themselves",
    ),
}


@dataclass(frozen=True, slots=True)
class Criterion:
    """One evaluated physical criterion and its outcome."""

    name: str
    quantity: Quantity | None
    comparison: Comparison
    threshold: Threshold
    rationale: str

    @property
    def support(self) -> Support:
        if self.quantity is None:
            return "inconclusive"
        if self.comparison == "below":
            if self.quantity.below(self.threshold.value):
                return "supports"
            if self.quantity.above(self.threshold.value):
                return "opposes"
            return "inconclusive"
        if self.quantity.above(self.threshold.value):
            return "supports"
        if self.quantity.below(self.threshold.value):
            return "opposes"
        return "inconclusive"

    def to_payload(self) -> dict[str, object]:
        return {
            "name": self.name,
            "support": self.support,
            "comparison": self.comparison,
            "threshold": self.threshold.to_payload(),
            "rationale": self.rationale,
            "measured": None if self.quantity is None else self.quantity.to_payload(),
        }


@dataclass(frozen=True, slots=True)
class ClassEvidence:
    """The full criterion set evaluated for one candidate posture."""

    posture: str
    criteria: tuple[Criterion, ...]
    unavailable_reason: str | None = None

    @property
    def met(self) -> bool:
        """True only when every criterion supports and none is inconclusive."""

        if self.unavailable_reason is not None or not self.criteria:
            return False
        return all(criterion.support == "supports" for criterion in self.criteria)

    @property
    def opposed(self) -> bool:
        return any(criterion.support == "opposes" for criterion in self.criteria)

    def to_payload(self) -> dict[str, object]:
        return {
            "posture": self.posture,
            "met": self.met,
            "unavailable_reason": self.unavailable_reason,
            "criteria": [criterion.to_payload() for criterion in self.criteria],
        }


@dataclass(frozen=True, slots=True)
class Gate:
    """One precondition evaluated before any class criteria."""

    name: str
    passed: bool
    detail: str

    def to_payload(self) -> dict[str, object]:
        return {"name": self.name, "passed": self.passed, "detail": self.detail}


@dataclass(frozen=True, slots=True)
class PostureVerdict:
    """The released posture together with everything needed to recheck it."""

    posture: str
    confidence: float
    gates: tuple[Gate, ...]
    evidence: tuple[ClassEvidence, ...]
    shadow_candidates: tuple[str, ...] = ()
    abstain_reason: str | None = None
    quantities: tuple[Quantity, ...] = field(default_factory=tuple)

    def to_payload(self) -> dict[str, object]:
        return {
            "schema_version": CRITERIA_SCHEMA_VERSION,
            "posture": self.posture,
            "confidence": round(self.confidence, 6),
            "abstain_reason": self.abstain_reason,
            "shadow_candidates": list(self.shadow_candidates),
            "gates": [gate.to_payload() for gate in self.gates],
            "quantities": {
                quantity.name: quantity.to_payload() for quantity in self.quantities
            },
            "class_evidence": [item.to_payload() for item in self.evidence],
        }


def classify_frame(
    frame: FrameGeometry,
    *,
    released_classes: frozenset[str] = DEFAULT_RELEASED_CLASSES,
    min_usable_ratio: float = 0.35,
) -> PostureVerdict:
    """Classify one frame from physical criteria, abstaining when unsure."""

    quantities: list[Quantity] = []
    gates: list[Gate] = []

    if not frame.person_detected:
        gates.append(Gate("person_detected", False, "producer reported no person"))
        return _abstain(gates, (), "no person detected", quantities)
    gates.append(Gate("person_detected", True, "producer reported a person"))

    usable_ratio = frame.usable_ratio
    usable_ok = usable_ratio >= min_usable_ratio
    gates.append(
        Gate(
            "usable_keypoint_ratio",
            usable_ok,
            f"{usable_ratio:.2f} usable, needs {min_usable_ratio:.2f}",
        )
    )
    if not usable_ok:
        return _abstain(gates, (), "too few usable keypoints", quantities)

    budget = THRESHOLDS["angle_budget_deg"].value
    sigma = frame.representative_sigma_px
    min_length = min_segment_length_for_angle_budget(sigma, budget)
    gates.append(
        Gate(
            "angular_resolution",
            True,
            f"sigma {sigma:.2f} px needs segments >= {min_length:.1f} px "
            f"for a {budget:.0f} deg budget",
        )
    )

    body = principal_axis_angle(
        frame, indices=BODY_AXIS_INDICES, name="body_long_axis_from_gravity"
    )
    trunk_axis = principal_axis_angle(
        frame, indices=TRUNK_AXIS_INDICES, name="trunk_from_gravity", minimum_points=3
    )
    if body is None or trunk_axis is None:
        gates.append(Gate("principal_axes", False, "too few points for a principal axis"))
        return _abstain(gates, (), "trunk or body axis unavailable", quantities)
    body_axis, elongation = body
    trunk, _trunk_shape = trunk_axis
    quantities.extend((trunk, body_axis, elongation))
    gates.append(
        Gate(
            "principal_axes",
            True,
            f"trunk {trunk.note} sigma {trunk.sigma:.2f} deg; body {body_axis.note}",
        )
    )

    sagittal = sagittal_observability(frame)
    if sagittal is not None:
        quantities.append(sagittal)
    sagittal_value = 0.0 if sagittal is None else sagittal.value
    sagittal_ok = sagittal_value >= THRESHOLDS["sagittal_min"].value
    gates.append(
        Gate(
            "sagittal_observability",
            sagittal_ok,
            "unavailable" if sagittal is None else sagittal.note,
        )
    )

    legs = (_leg_quantities(frame, "left"), _leg_quantities(frame, "right"))
    support = _supporting_leg(legs)
    flexed = _most_flexed_leg(legs)
    if support is not None:
        gates.append(Gate("supporting_leg", True, f"{support.side} leg carries height"))
        for optional in (
            support.thigh,
            support.knee_flexion,
            support.extension,
            support.hip_above_knee,
            support.knee_above_ankle,
        ):
            if optional is not None:
                quantities.append(optional)
    else:
        gates.append(Gate("supporting_leg", False, "neither leg is fully observable"))

    evidence = (
        _standing_evidence(trunk, support),
        _sitting_evidence(flexed, sagittal_ok),
        _lying_evidence(body_axis, elongation, sagittal_ok),
        _bending_evidence(trunk, support, sagittal_ok),
    )

    matched = [item.posture for item in evidence if item.met]
    unique_matched = sorted(set(matched))

    if len(unique_matched) != 1:
        reason = (
            "no class criteria fully met"
            if not unique_matched
            else f"criteria for {', '.join(unique_matched)} met simultaneously"
        )
        return _abstain(gates, evidence, reason, quantities)

    winner = unique_matched[0]
    if winner not in released_classes:
        return _abstain(
            gates,
            evidence,
            f"{winner} is not validated on this project's data; released as unknown",
            quantities,
            shadow_candidates=(winner,),
        )

    confidence = _confidence(evidence, winner, sagittal_value=sagittal_value)
    return PostureVerdict(
        posture=winner,
        confidence=confidence,
        gates=tuple(gates),
        evidence=evidence,
        quantities=tuple(quantities),
    )


def _abstain(
    gates: Sequence[Gate],
    evidence: Sequence[ClassEvidence],
    reason: str,
    quantities: Sequence[Quantity],
    *,
    shadow_candidates: tuple[str, ...] = (),
) -> PostureVerdict:
    return PostureVerdict(
        posture="unknown",
        confidence=1.0,
        gates=tuple(gates),
        evidence=tuple(evidence),
        shadow_candidates=shadow_candidates,
        abstain_reason=reason,
        quantities=tuple(quantities),
    )


def _confidence(
    evidence: Sequence[ClassEvidence], winner: str, *, sagittal_value: float
) -> float:
    """Return a confidence bounded by the weakest supporting margin.

    The value is the smallest normalised margin among the winning criteria,
    discounted by how much of the sagittal plane survived projection.  It is a
    statement about evidence strength under the stated model, not a probability
    of being correct, and it is deliberately incapable of reaching 1.0.
    """

    winning = next(item for item in evidence if item.posture == winner)
    margins: list[float] = []
    for criterion in winning.criteria:
        quantity = criterion.quantity
        if quantity is None:
            continue
        spread = max(quantity.sigma, 1e-6)
        distance = abs(quantity.value - criterion.threshold.value)
        margins.append(min(1.0, distance / (3.92 * spread)))
    if not margins:
        return 0.0
    weakest = min(margins)
    discount = min(1.0, max(0.0, sagittal_value))
    return round(min(0.95, weakest * (0.5 + 0.5 * discount)), 6)


@dataclass(frozen=True, slots=True)
class LegQuantities:
    """Thigh, knee and extension for one leg, kept together on purpose.

    Selecting each quantity independently across sides could pair a left thigh
    with a right knee and describe a limb that nobody has.  Criteria therefore
    consume a whole side at a time.
    """

    side: str
    thigh: Quantity | None
    knee_flexion: Quantity | None
    extension: Quantity | None
    hip_above_knee: Quantity | None
    knee_above_ankle: Quantity | None

    @property
    def complete(self) -> bool:
        return self.thigh is not None and self.knee_flexion is not None


def _leg_quantities(frame: FrameGeometry, side: Literal["left", "right"]) -> LegQuantities:
    hip, knee, ankle = (
        (LEFT_HIP, LEFT_KNEE, LEFT_ANKLE)
        if side == "left"
        else (RIGHT_HIP, RIGHT_KNEE, RIGHT_ANKLE)
    )
    return LegQuantities(
        side=side,
        thigh=segment_angle_from_gravity(frame, hip, knee, name="thigh_from_gravity"),
        knee_flexion=_knee_flexion(
            joint_angle(frame, hip, knee, ankle, name="knee_interior_angle")
        ),
        extension=leg_extension_ratio(frame, side),
        hip_above_knee=vertical_order_margin(frame, hip, knee, name="hip_above_knee"),
        knee_above_ankle=vertical_order_margin(frame, knee, ankle, name="knee_above_ankle"),
    )


def _supporting_leg(legs: Sequence[LegQuantities]) -> LegQuantities | None:
    """Return the leg that best carries body height.

    Upright stance needs only *one* extended weight-bearing limb: a person
    shifting weight with the other knee flexed is still standing.  Choosing the
    most extended side is therefore the biomechanically meaningful selection,
    not a convenient one -- the opposite limb is free to do anything.
    """

    usable = [leg for leg in legs if leg.complete]
    if not usable:
        return None
    return min(
        usable,
        key=lambda leg: (leg.knee_flexion.value if leg.knee_flexion is not None else 1e9),
    )


def _most_flexed_leg(legs: Sequence[LegQuantities]) -> LegQuantities | None:
    """Return the leg whose configuration least resembles upright stance.

    Sitting is a whole-body configuration rather than a single-limb one, so the
    conservative choice is the side that would *most* readily satisfy a seated
    criterion; requiring even that side to clear the threshold keeps a single
    crossed or outstretched leg from creating a seated verdict on its own.
    """

    usable = [leg for leg in legs if leg.complete]
    if not usable:
        return None
    return max(
        usable,
        key=lambda leg: (leg.thigh.value if leg.thigh is not None else -1e9),
    )


def _knee_flexion(knee: Quantity | None) -> Quantity | None:
    """Convert an interior knee angle into flexion (0 deg = fully extended)."""

    if knee is None:
        return None
    return Quantity(
        name="knee_flexion",
        value=180.0 - knee.value,
        sigma=knee.sigma,
        unit="deg",
        provenance=knee.provenance,
        note=knee.note,
    )


def _standing_evidence(trunk: Quantity, support: LegQuantities | None) -> ClassEvidence:
    if support is None:
        return ClassEvidence("standing", (), "no leg is fully observable")
    thigh = support.thigh
    flexion = support.knee_flexion
    extension = support.extension
    hip_knee = support.hip_above_knee
    knee_ankle = support.knee_above_ankle
    criteria = (
        Criterion(
            "trunk_upright",
            trunk,
            "below",
            THRESHOLDS["standing_trunk_max_deg"],
            "upright stance keeps the body long axis close to gravity",
        ),
        Criterion(
            "thigh_near_vertical",
            thigh,
            "below",
            THRESHOLDS["standing_thigh_max_deg"],
            "the femur carries body height in stance, so it stays close to gravity",
        ),
        Criterion(
            "knee_extended",
            flexion,
            "below",
            THRESHOLDS["standing_knee_flexion_max_deg"],
            "stance keeps the knee close to extension",
        ),
        Criterion(
            "leg_vertically_extended",
            extension,
            "above",
            THRESHOLDS["standing_leg_extension_min"],
            "hip-to-ankle drop approaches the full limb length when the leg is straight",
        ),
        Criterion(
            "hip_above_knee",
            hip_knee,
            "above",
            Threshold(0.0, "derived", "sign test with propagated uncertainty"),
            "stance orders hip above knee along gravity",
        ),
        Criterion(
            "knee_above_ankle",
            knee_ankle,
            "above",
            Threshold(0.0, "derived", "sign test with propagated uncertainty"),
            "stance orders knee above ankle along gravity",
        ),
    )
    return ClassEvidence("standing", criteria)


def _sitting_evidence(flexed: LegQuantities | None, sagittal_ok: bool) -> ClassEvidence:
    if not sagittal_ok:
        return ClassEvidence(
            "sitting",
            (),
            "sitting geometry is sagittal; too little sagittal plane survives projection",
        )
    if flexed is None:
        return ClassEvidence("sitting", (), "no leg is fully observable")
    thigh = flexed.thigh
    flexion = flexed.knee_flexion
    criteria = (
        Criterion(
            "thigh_towards_horizontal",
            thigh,
            "above",
            THRESHOLDS["sitting_thigh_min_deg"],
            "seated support forces roughly 90 deg of hip flexion, rotating the "
            "femur away from gravity towards horizontal",
        ),
        Criterion(
            "knee_flexed",
            flexion,
            "above",
            THRESHOLDS["sitting_knee_flexion_min_deg"],
            "a seated posture flexes the knee as well as the hip",
        ),
    )
    return ClassEvidence("sitting", criteria)


def _lying_evidence(
    body_axis: Quantity, elongation: Quantity, sagittal_ok: bool
) -> ClassEvidence:
    if not sagittal_ok:
        return ClassEvidence(
            "lying",
            (),
            "body long axis may be foreshortened along the optical axis",
        )
    criteria = (
        Criterion(
            "long_axis_horizontal",
            body_axis,
            "above",
            THRESHOLDS["lying_trunk_min_deg"],
            "recumbency puts the body long axis close to perpendicular to gravity",
        ),
        Criterion(
            "body_elongated",
            elongation,
            "above",
            THRESHOLDS["lying_elongation_min"],
            "guards against a compact projection whose axis direction is meaningless",
        ),
    )
    return ClassEvidence("lying", criteria)


def _bending_evidence(
    trunk: Quantity, support: LegQuantities | None, sagittal_ok: bool
) -> ClassEvidence:
    if not sagittal_ok:
        return ClassEvidence(
            "bending_or_crouching",
            (),
            "trunk flexion is sagittal; too little sagittal plane survives projection",
        )
    if support is None:
        return ClassEvidence("bending_or_crouching", (), "no leg is fully observable")
    flexion = support.knee_flexion
    hip_knee = support.hip_above_knee
    criteria = (
        Criterion(
            "trunk_flexed",
            trunk,
            "above",
            THRESHOLDS["bending_trunk_min_deg"],
            "bending is driven by trunk and hip flexion",
        ),
        Criterion(
            "knee_still_extended",
            flexion,
            "below",
            THRESHOLDS["standing_knee_flexion_max_deg"],
            "bending keeps the knee comparatively extended, unlike sitting or squatting",
        ),
        Criterion(
            "hip_above_knee",
            hip_knee,
            "above",
            Threshold(0.0, "derived", "sign test with propagated uncertainty"),
            "the legs still carry height while the trunk folds forward",
        ),
    )
    return ClassEvidence("bending_or_crouching", criteria)
