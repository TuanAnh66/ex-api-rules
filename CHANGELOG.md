# Changes

## Tool 0.2.0

Split pure core and CLI into independently packed workspaces. Add language-neutral schemas, explicit lifecycle and check/test catalog, external content-addressed store, per-project lock, deterministic offline reports, unsupported-language accounting and SARIF. Add maintainer/PR/CI/manual-release workflows. npm publication is deferred.

### Rule impact

No approved requirement changes. Original v0.1.0 bundle hash e3a79f510ff6364440e5e7d9832f48c9f5ee99ceee5f62e73905d1fe8c0b4e37, IDs, 27 source snapshots and sanitized 600 USC milestone are unchanged. New lifecycle fields exist only in authoring catalog, not in legacy approved evidence. Tool 0.2.0 excludes inference from findings and explicitly reports unsupported files; consumers must review these behavior changes and pin deliberately.

### Migration

Install both packages or reinstall submodule workspace dependencies, import legacy release bundle if using packages, run pin in each consuming project, commit its lock. Existing wrapper commands remain supported with explicit unlocked-legacy metadata until pinned. Runtime cache/candidates/approvals move outside installation; old temporary candidate/cache data is not migrated implicitly.
