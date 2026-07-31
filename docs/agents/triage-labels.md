# Triage labels

Use these canonical role strings in the `Status:` field of local Markdown issues:

| Role | Status value | Meaning |
|---|---|---|
| Needs triage | `needs-triage` | Raw incoming request; not yet assessed |
| Needs information | `needs-info` | Blocked on missing context or reproduction details |
| Ready for agent | `ready-for-agent` | Scoped, testable, and safe for an agent to implement |
| Ready for human | `ready-for-human` | Requires a human decision, credential, physical action, or subjective review |
| Won't fix | `wontfix` | Intentionally declined or out of scope |

Tickets produced by `to-tickets` are already agent-ready and should not be re-triaged.
