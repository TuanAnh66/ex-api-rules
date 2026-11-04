# Changes

## Tool 0.2.1 — 2026-11-04

Released as [v0.2.1](https://github.com/TuanAnh66/ex-api-rules/releases/tag/v0.2.1) from commit [`24240c1`](https://github.com/TuanAnh66/ex-api-rules/commit/24240c161dfe0c0e543c65c03a28a95f6ada3de2), based on source commit `77bf823ff9f0186a2f37a3ebf46af295623d0bc8`. This patch synchronizes workspace, package and runtime versions.

### Changes

- Improve signing checks, deterministic canonical JSON handling and OpenAPI parsing.
- Harden CLI review and runtime write boundaries, with additional offline regression coverage.
- Keep unsupported inputs explicitly reported as unanalyzed.

### Compatibility and rule impact

Node.js 22 or later and Git 2.36 or later are required. Existing project locks include the exact tool version; upgrading to this tool requires an explicit project pin decision. No project lock or approved rule is upgraded automatically.

The approved bundle `2026-11-03T16-00-20-366Z-47729188` retains hash `e3a79f510ff6364440e5e7d9832f48c9f5ee99ceee5f62e73905d1fe8c0b4e37`. Original v0.1.0 evidence, stable rule IDs, 27 source snapshots and the sanitized milestone are unchanged. No live account API or source collection is part of this release preparation.

### Distribution

The GitHub Release includes both package tarballs, the preserved portable rule bundle, protocol contracts, source revision metadata and SHA-256 checksums. npm publication is deferred.

## Tool 0.2.0

Split pure core and CLI into independently packed workspaces. Add language-neutral schemas, explicit lifecycle and check/test catalog, external content-addressed store, per-project lock, deterministic offline reports, unsupported-language accounting and SARIF. Add maintainer/PR/CI/manual-release workflows. npm publication is deferred.

### Rule impact

No approved requirement changes. Original v0.1.0 bundle hash e3a79f510ff6364440e5e7d9832f48c9f5ee99ceee5f62e73905d1fe8c0b4e37, IDs, 27 source snapshots and sanitized 600 USC milestone are unchanged. New lifecycle fields exist only in authoring catalog, not in legacy approved evidence. Tool 0.2.0 excludes inference from findings and explicitly reports unsupported files; consumers must review these behavior changes and pin deliberately.

### Migration

Install both packages or reinstall submodule workspace dependencies, import legacy release bundle if using packages, run pin in each consuming project, commit its lock. Existing wrapper commands remain supported with explicit unlocked-legacy metadata until pinned. Runtime cache/candidates/approvals move outside installation; old temporary candidate/cache data is not migrated implicitly.
