# Architecture and boundaries

- catalog/: editable rules, official source allowlist, check–test registry. Authoring status is draft; changing this directory never changes an approved bundle.
- schemas/: language-neutral JSON Schema 2020-12 contracts; copied verbatim into the core package by build.
- packages/core/: canonicalization, integrity, schemas, profile selection and report serialization. It imports neither filesystem/crawler nor JavaScript syntax parsers.
- packages/cli/: filesystem, public HTTP collector, external store and language adapters. JavaScript is the first adapter; unsupported files are hashed and reported as unanalyzed.
- agents/: human/agent interpretation and mandatory behavioral checklist. The agent does not repair reviewed code.
- tests/fixtures/: sanitized offline cases and language-neutral vectors.
- .github/: offline CI, PR checklist, CODEOWNERS, manually dispatched release.

A rule describes a requirement; a check describes one way of finding violations. catalog/checks.json maps checks to stable IDs and regression cases. No check or schema claims complete business correctness. Retired rules retain IDs; superseded rules point to a successor. Inference is excluded from conformance selection.

## Mutable data outside installation

Default store: EX_API_RULES_DATA_DIR, otherwise Windows LOCALAPPDATA/ex-api-rules or XDG_STATE_HOME/ex-api-rules (~/.local/state/ex-api-rules on other systems). Override with --data-dir. CLI refuses a store/output inside its installation or submodule.

Store layout: blobs/<prefix>/<SHA-256>, bundles/<artifactSHA>.json, bundles/index.json, candidates/<ID>, approvals/<ID>.json, maintainer-active.json, cache/checks/<ID>, cache/views/<artifactSHA>, cache/latest-<artifactSHA>.json. Bundle IDs cannot be rebound. Index writes are serialized with an exclusive lock; interrupted writes leave a visible lock requiring maintainer inspection rather than guessing completion. Disposable views are verified against content hashes.

Each target project owns .ex-api-rules.lock.json and .cache/exness-rules reports. Lock selects exact tool version, bundle ID, bundle hash, portable artifact hash, schema version and profile. Two projects can select different bundles and source-check timestamps using one store. A mismatching tool/profile/bundle errors until explicitly pinned. Review never updates the lock.

## Migration and distribution

Tool 0.2.0 packages and schema version 2 portable envelopes wrap the original schema version 1 manifest/rules without changing their bytes or bundle hash. Only the exact legacy hash is allowed to lack new lifecycle fields. New approved bundles require lifecycle metadata.

Legacy snapshots remain in Git for v0.1.0 compatibility. New snapshots live in external content-addressed storage and portable release assets. Git carries authoring rules, source catalog, release descriptors, citations and review decisions. Importing a release verifies hashes but does not establish trust in its author: obtain assets/checksums from a reviewed maintainer release.

Submodule pinning and project rule locks serve different purposes. Updating a Git pointer does not approve a candidate or upgrade a project's locked tool/bundle. No background server or scheduler is required.
