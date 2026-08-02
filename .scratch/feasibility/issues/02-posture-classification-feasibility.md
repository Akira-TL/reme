# 02 — Validate posture and transition classification

**What to investigate:** Determine whether pose landmarks extracted from the supplied video can classify privacy-preserving body states and distinguish a fall-like transition from ordinary posture changes well enough for the hackathon demo.

**Blocked by:** 01 — Validate pose extraction on the supplied video.

**Status:** blocked

**Harness ready:** `.scratch/tiny-transition-model/` holds a reproducible baseline-versus-learned-model
comparison for temporal transitions, currently running on synthetic data only. None of its numbers count
towards the acceptance criteria below; they unblock only the tooling, not the evidence.

## Working labels

Static posture labels for the experiment:

- `standing`
- `sitting`
- `lying`
- `bending_or_crouching`
- `unknown`

Temporal transition labels for the experiment:

- `normal_transition`
- `fall_like_transition`
- `uncertain_transition`

These are experiment labels, not yet a permanent product schema.

## Acceptance criteria

- [ ] Annotate the supplied video's relevant time ranges with ground-truth posture and transition labels.
- [ ] Establish a transparent geometric baseline using normalized skeleton features.
- [ ] Evaluate at least one lightweight learned classifier if the amount of labelled data is sufficient.
- [ ] Keep static posture classification separate from temporal transition classification.
- [ ] Report per-class precision, recall, F1, confusion matrix, and an `unknown`/abstention rate; do not report only overall accuracy.
- [ ] Record mistakes between sitting, lying, bending/crouching, ordinary lying-down transitions, and fall-like transitions.
- [ ] Render evaluation output using skeletons, silhouettes, or strongly abstracted imagery so a viewer cannot easily identify the person.
- [ ] Produce a go, conditional-go, or no-go recommendation for automatic posture classification.
- [ ] Define the minimum structured result MiMo needs only after the classification evidence is reviewed.

## Expected answer

A measured recommendation for the smallest defensible classifier: which static states are reliable enough to show, whether fall-like transition classification is credible, where the system must return `unknown`, and which outputs can safely be sent to the MiMo API.
