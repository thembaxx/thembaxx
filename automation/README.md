# Repository and product automation

The GitHub profile repository coordinates **public** operational diagnostics for maintained projects. It does not access customer financial data, credentials or private repository source code.

## Active workflows

| Workflow | Purpose | Schedule |
| --- | --- | --- |
| `portfolio-site-health.yml` | Validate configured production websites, manifests and HTTP response status; upload a health report | Daily |
| `site-visual-audit.yml` | Capture actual 1440×900, 390×844 and 820×1180 production screenshots, compare with the previous successful artifact and upload diff images for review | Weekly, Tuesday |
| `weekly-project-digest.yml` | Summarize public repo CI, open issues and recent failures; upload Markdown report | Weekly, Monday |
| `reusable-failure-triage.yml` | Deduplicate failure issues for default-branch CI runs; consumed by application workflows | Event-driven |
| `ci-triage-reusable.yml` | Additional targeted failure triage for data refresh and release workflows | Event-driven |

Public endpoint and screenshot configuration is in `.automation/sites.json`. The health checker and screenshot tooling are in `.automation/`. The weekly engineering digest implementation is `scripts/project-digest.mjs`.

## Limitations and safeguards

- Visual differences are review signals, not automatic deploy blockers. Dynamic application data and fonts can legitimately change screenshots.
- GitHub-scheduled runs can be delayed and are not a suitable sole scheduler for customer-facing financial or transactional operations.
- Website authentication challenges are not proof of production downtime; inspect protected URLs separately.
- Product usage, revenue, retention and conversion figures are not accessible here and must remain **unavailable** until a consent-respecting analytics source is connected.
- Automated failure triage only creates diagnostic issues. It does not execute untrusted pull-request code, push speculative fixes or merge PRs.
- Existing per-repository CI, releases, content-refresh pipelines and security checks remain authoritative; the central jobs supplement them.
- Never publish secrets, customer identifiers, private report contents or unpublished product details into public workflows or artifacts.

## Future operational rollout

Production data jobs such as retailer scraping, bank reconciliation, supplier notifications, paid report fulfilment and account discovery require stable external providers, verified rights to sources, a durable backing service, bounded retries and tested idempotency before scheduling. Keep payment/payout, medical, safety and identity-sensitive decisions behind an explicit approved transaction.
