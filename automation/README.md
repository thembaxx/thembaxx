# Engineering automation

This repository provides shared, read-only portfolio monitoring and failure triage for public projects. No private repo secrets or customer data are aggregated.

- `automation/sites.json`: explicitly verified public deployment URLs. Modify deliberately; never add private or authenticated endpoints.
- `portfolio-site-health.yml`: four checks daily; HTTP 401/403 is labeled PROTECTED, not confirmed healthy.
- `portfolio-visual-snapshots.yml`: weekly actual desktop 1440x900, mobile 390x844 and tablet 820x1180 screenshots uploaded as Actions artifacts. Screenshots are **not** automatically committed, because updates need visual review.
- `weekly-project-digest.yml`: Monday public GitHub Actions and issue statistics. Product usage and financial metrics are not connected.
- `reusable-failure-triage.yml`: called by repository-local workflow_run hooks. Creates or updates one open issue per failing workflow on the default branch; it does not run untrusted PR code, apply fixes, or merge anything.

## Call shared triage from an application repository

```yaml
name: CI failure triage
on:
  workflow_run:
    workflows: [CI]
    types: [completed]
permissions:
  contents: read
  actions: read
  issues: write
jobs:
  triage:
    if: github.event.workflow_run.conclusion == 'failure' && github.event.workflow_run.head_branch == github.event.repository.default_branch
    uses: thembaxx/thembaxx/.github/workflows/reusable-failure-triage.yml@main
```

Caller workflow name must match its existing CI check exactly. GitHub Actions must be enabled and Issues must be available. Ensure any workflow_call permissions do not exceed the caller. This intentionally produces actionable diagnostics, not unreviewed changes.

## Safety

Never fetch user private data or use protected services from public status checks. Do not add production credentials to these workflows. GitHub scheduled events can be delayed; time-sensitive product operations should use a dedicated queue/cron provider with idempotent jobs.
