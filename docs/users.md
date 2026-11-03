# User operations

Install the two tarballs from GitHub Releases together as shown in README. Use the bundled executable via npx --no-install so an absent package is never fetched implicitly. The core library is also usable without CLI; Python/Go consumers use the same JSON schemas, protocol and fixtures.

From ExTransfer use node tools/exness-rules.cjs; from a standalone checkout use its own tools/exness-rules.cjs. --project-root defaults to the current working directory unless a project wrapper supplies it. Files are relative to that target. --base resolves a Git commit there and reviews changed/untracked public files; deleted files are not analyzed. It explicitly records excluded private paths and unsupported languages. Explicit private paths are rejected before reading.

Review requires Git 2.36 or newer, including when --files is used to record the target HEAD. Each review invokes Git with fsmonitor disabled, external diff/text conversion disabled for diff, and a separate subprocess environment that ignores inherited GIT_* settings and system/global Git configuration. No persistent Git configuration is changed. Target-local configuration still exists; these controls are not a sandbox for arbitrary hostile Git repositories. A project without Git metadata records HEAD as unavailable.

Before first review import the bundle and pin it. A repository checkout can bootstrap the preserved v0.1.0 bundle for older wrapper calls; reports say legacy-compatibility-unlocked until you run pin. A package installation cannot bootstrap missing snapshots: import the release artifact instead. Never treat an unlocked compatibility review as a reproducible lock.

Commit your .ex-api-rules.lock.json. Keep .cache/exness-rules ignored. A review records target HEAD and file hashes, tool/bundle/schema versions, source freshness, profile, findings and missing checks. resultFingerprint excludes timestamps but covers code, selected rules and conclusions. Use --format sarif for CI; still read JSON/manual checks because no findings does not prove compliance. CI can upload the SARIF using GitHub's supported upload action if repository permissions allow it.

## Updating intentionally

1. check-updates compares live public sources with this project's pinned evidence and writes external cache/report only. Network failure is incomplete, never unchanged. It reports technical, examples/presentation, moved, removed and parse/network failures plus affected rules, endpoints, targets and tests.
2. On request collect creates a new candidate. Maintainer reads the diff and actual citations, edits authoring rules as needed, and reviews through PR.
3. On explicit approval run approve --candidate ID --reviewed-by NAME. This selects a maintainer bundle only; projects stay pinned.
4. Publish a new immutable bundle; consumers import it, choose pin --bundle ID explicitly, review their code and commit the changed lock separately. To roll back, pin the previous immutable bundle with its compatible tool.

For offline use install dependencies and import bundles in advance. Review performs no network access and does not claim sources are current. check-updates is the only comparison command; neither it nor review executes account requests or source code. Never provide account credentials to this tool.
