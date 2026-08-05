# README assets

## `reme-hero.svg`

Repository-local Reme hero artwork created for the repository README. It uses an abstract A/B/C
pipeline and does not contain a person, a third-party logo, or a product-accuracy claim.

## `reme-demo.png`

Captured on 2026-08-02 from local `main@aeef9599` after starting the real A/B/C stack on
isolated loopback ports and selecting the bathroom privacy scene. Headless Chrome had no
camera permission, so the orange skeleton is the interface's built-in dynamic demo state; the
capture contains no person or source camera footage. The timeline is static demo copy. This
image is evidence of the runtime interface and service-ready state, not evidence of
pose-classification accuracy.

The empty-room backdrop comes from the repository's existing
`frontend/public/scenes/bathroom.jpg`. Its provenance is not documented on this branch and
must be confirmed before redistribution outside the competition repository.

## Imported local artifacts

On 2026-08-05, the historical decision audit was copied from
`akira@192.168.100.102:/home/akira/Projects/reme/artifacts/decision-audit.jsonl` to:

```text
artifacts/imported/AkiraArch/decision-audit.jsonl
```

It contains 509 JSONL records and has SHA-256
`bacd65a082fbf99fea6d5cb9e46e870af36a1abd6c759337085009f206a8e0cf`.
The file remains Git-ignored. It is a historical runtime trace for debugging and contract
review, not training data, an accuracy report, or evidence of production performance.
