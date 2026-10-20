# my-software-factory

## Agent skills

### Issue tracker

Issues live in GitHub Issues (repo `Sanmoo/my-software-factory`), via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default triage labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` + `docs/adr/`. See `docs/agents/domain.md`.

### Pull request contents

Do not include review reports, attempt notes, or other temporary `revisao/` artifacts in pull requests. Keep review evidence outside the repository; remove any such artifacts before committing or pushing.

## Conventions

### Quality gateway

Before declaring a Work ready, run `npm run gateway` (README: prerequisites,
scope, exit status) and commit only while it passes. A new deterministic check
required for readiness joins the gateway and shares its budget; a required
check is never removed, skipped or optionalized to fit the ceiling.

### Comments

Comment only what is essential: the non-obvious *why* and the contracts a reader cannot infer from names and types.

### Documentation

`README.md` and `docs/RUNBOOK.md` serve the operator and stay extremely succinct: only what the operator needs, each fact in a single place. Implementation detail belongs in the code, and the README never lists the file structure.
