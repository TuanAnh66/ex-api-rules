# ex-api-rules

On-demand public Exness evidence collection and offline code review. Node.js 22+; review requires Git 2.36+. Install alongside ex-api-rules-core of the same version from GitHub Release tarballs until npm publication is enabled.

ex-api-rules bundle import --file exness-bundle-v0.1.0.json
ex-api-rules pin --bundle 2026-11-03T16-00-20-366Z-47729188
ex-api-rules review --files client.cjs --format json

Run --help for commands/options. Runtime data lives outside installation; use --data-dir or EX_API_RULES_DATA_DIR. Commit .ex-api-rules.lock.json in each consumer. No scheduler, live account access or credential input. JavaScript checks are partial; other languages are explicitly unanalyzed. Read the repository's docs/users.md, docs/maintainers.md and NOTICE. npm publication pending.
