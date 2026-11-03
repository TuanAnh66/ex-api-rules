# Preserved v0.1.0 evidence

active.json, approvals and versions preserve the original approved bundle byte for byte. Do not edit these snapshots or rule IDs. Tool 0.2.0 wraps them in a portable release envelope; bundle hash stays e3a79f510ff6364440e5e7d9832f48c9f5ee99ceee5f62e73905d1fe8c0b4e37.

New authoring data is in catalog/. New source blobs, candidates, approvals and checks live in an external writable data directory, never in the installation. Each consumer selects its own bundle with .ex-api-rules.lock.json. Read [user operations](../../docs/users.md), [protocol](../../docs/protocol.md) and [maintainer workflow](../../docs/maintainers.md).

Old temporary candidate/cache directories are not silently migrated. Legacy helper exports under tools/exness-rules/ remain for compatibility/testing; operational commands use packages/cli/src/store.cjs and the external store.
