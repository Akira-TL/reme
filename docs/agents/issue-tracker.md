# Issue tracker: Local Markdown

Issues and specs for this repository live as Markdown files in `.scratch/`.

## Conventions

- One feature or investigation per directory: `.scratch/<feature-slug>/`
- The spec is `.scratch/<feature-slug>/spec.md`
- Implementation issues are one file per ticket at `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`
- Triage state is recorded as a `Status:` line near the top of each issue file
- Comments and conversation history append under a `## Comments` heading
- Research notes, prototypes, handoffs, and measurement logs stay inside the relevant feature directory

## Publishing work

When a skill says "publish to the issue tracker," create a Markdown file under `.scratch/<feature-slug>/`, creating the directory if needed.

When a skill says "fetch the relevant ticket," read the referenced file directly.

## Wayfinding operations

- **Map:** `.scratch/<effort>/map.md`
- **Child ticket:** `.scratch/<effort>/issues/NN-<slug>.md`
- **Type:** record `research`, `prototype`, `grilling`, or `task` on a `Type:` line
- **Status:** record `open`, `claimed`, or `resolved` on a `Status:` line
- **Blocking:** record `Blocked by: NN, NN`; a ticket is unblocked when all listed tickets are resolved
- **Frontier:** the first numbered open, unblocked, unclaimed ticket
- **Claim:** set `Status: claimed` before work begins
- **Resolve:** append the answer under `## Answer`, set `Status: resolved`, and add a linked gist to the map's Decisions-so-far section
