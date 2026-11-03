# Contributing

Read AGENTS.md, docs/architecture.md and agents/exness-api-reviewer.md. Use Node.js 22+ and pnpm 11.25.0. Run pnpm install --frozen-lockfile --ignore-scripts, pnpm build, pnpm validate and pnpm test. Tests are offline and use only sanitized fixtures/mock transports.

Propose rule edits in catalog/rules.json with stable ID, lifecycle, scope/kind, exact official URL and pointer/quotation anchor, change meaning, applicability, open contradictions and regression coverage. Never reuse an ID for a different requirement. Mark replacement with supersededBy; inference cannot become blocking just by passing CI. An observation needs date, scope, sanitized provenance and limits on generalization.

Keep checks separate in catalog/checks.json. Add a meaningful failing example and a correct example; link actual test file/title. Unsupported languages require an adapter proposal and common protocol fixtures. Core must not acquire crawler, filesystem or language-parser dependencies.

Open a PR containing candidate/diff references and review evidence, not raw production journals, credentials or new snapshot blobs. New snapshots are content-addressed external data and release assets. Never modify a released bundle, including v0.1.0. Avoid individual machine paths/configurations. Use .github/pull_request_template.md. CI checks integrity and regressions; a maintainer must still assess semantics.
