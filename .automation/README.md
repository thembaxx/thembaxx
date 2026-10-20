# Shared portfolio automation

- sites.json lists the verified, public, opted-in production origins. Excludes MatricMaster AI and both Lumni repositories.
- check-sites.mjs checks HTTPS, HTML availability and reports PWA manifest problems without exposing customer information.
- capture-sites.mjs uses real Chromium renders at 1440×900, 390×844 and 820×1180; image artifacts are for review, not fabricated mockups.
- Workflow runs are informational evidence, not uptime SLAs. GitHub scheduled workflows can be delayed.
- Adding private apps, protected previews or authenticated pages requires explicit consent and appropriately scoped, short-lived credentials.

Automation MUST NOT issue customer-facing financial actions or send user messages from this repository. No automated merge or production rollback is authorized. Keep protected account/session data out of screenshots. Review exceptions before broadening coverage.
