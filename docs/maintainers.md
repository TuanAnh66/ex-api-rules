# Maintainer workflow

Collect -> candidate/diff -> PR -> maintainer review -> offline tests -> release. All operations run on request. CODEOWNERS requests review but repository branch protection must be configured separately to require it. No cron, automatic candidate approval, automatic consumer pin or automatic source-driven commits.

Review every changed rule against the public original and retained snapshot, including scope, date, precision, permission, error and retry implications. Record the candidate ID, bundle hash, reviewer and decision in release metadata/PR. Term matches only show an anchor still exists. Keep documented, observed and inference separate, including contradictory evidence.

approve --candidate ID --reviewed-by NAME is an explicit maintainer decision. Do not impersonate another reviewer. It installs immutable external artifacts, records the decision and publishes maintainer-active; pin is a separate consumer decision. No consuming project lock changes. Collection reports structural added/removed/changed/unchanged over both rule lists, including before/after and history issues. Always review the actual sources even when structure is unchanged.

Approved IDs remain in later bundles: retire with deprecated or superseded rather than deletion. A stable ID keeps scope, kind and introducedIn; changed rule content or lifecycle requires an increased revision. Superseded successors must exist and must not form self-references/cycles. The exact legacy snapshots stay untouched when lifecycle metadata is introduced into a new bundle. A new evidence kind/scope needs a new ID rather than rebinding an existing one.

Approval holds bundles/write.lock from candidate verification through artifact/index writes, immutable approval creation, active replacement and readback. The record ID is a- plus SHA-256 of the UTF-8 candidate ID, so a candidate cannot be reapproved with different bytes or reviewer. Its envelope contains schemaVersion:1, approval and sha256; sha256 covers core.stringify(approval), independently of the portable bundle's digest algorithm. A schemaVersion:1 active pointer carries id, artifactSha256, approvalId and approvalSha256. Records retain the prior pointer and exact baseline; readers verify the chain. Hashes establish integrity, not proof of an author's identity against an attacker who can rewrite the whole store.

Recovery is explicit:

- Before active replacement, artifacts/index entries or an unreferenced approval can remain. These are prepared/orphan data, not activation. After a caught error with no stale lock, the same requested candidate/reviewer may be retried; existing artifacts/records are verified and reused, not overwritten. An orphan whose baseline changed is rejected and needs a newly reviewed candidate.
- After active replacement, the pointer and its history determine commit. Retrying a committed candidate returns already-committed without a new timestamp, record, or activation. A -> B -> retry A keeps B active. Import cannot bypass approval using activate:true.
- The library distinguishes APPROVAL_NOT_COMMITTED, APPROVAL_COMMITTED and APPROVAL_STATE_UNKNOWN after pointer publication is attempted. CLI messages state the distinction and operational failures exit 2. A committed error means finalization failed after commit; an unknown state requires inspection before retry. Neither means an automatic rollback occurred.
- Process termination, lock-release failure, or interrupted cleanup may leave bundles/write.lock or temporary files. Inspect the pointer, referenced record/checksum, artifact/index and history before explicitly clearing a stale lock. No age timeout, automatic lock removal, orphan activation, repair of corrupted data or implicit approval is provided. Legacy maintainer pointers without approval references fail closed and require an explicitly authorized migration; imported portable bundles and consuming project locks remain usable.

Files are fsynced before rename; POSIX directory entries are synced. Windows directory fsync is unavailable through this implementation's Node filesystem API. Tests inject synchronous filesystem faults, not physical power loss. Treat filesystem/platform durability limits and a state-unknown error as operator recovery cases.

## Releases

The report v2/input-budget work is not a new release. Tool metadata remains at the current development snapshot by request; before any separately authorized publication, assign/review the appropriate next version and release artifacts. Never overwrite or reissue the already published 0.2.1 assets. Both report schemas and the language-neutral report vectors are included by build/contract packaging; executing release/package smoke remains a separate explicitly requested step.

pnpm build && pnpm validate && pnpm test
pnpm release
pnpm --filter ex-api-rules-core pack --pack-destination ../../dist
pnpm --filter ex-api-rules pack --pack-destination ../../dist
node scripts/release.cjs --checksums
node scripts/package-smoke.cjs

These commands prepare files only. Manual release.yml runs equivalent validation, packages both tarballs, creates a draft GitHub Release and attaches artifacts. Review the draft before publication. Never replace release assets in place: issue a new version if content changes. An existing tag/release causes an error rather than clobbering assets. Release provenance includes Git revision and artifact digests.

For a newly approved bundle run release.cjs --bundle-file /external/export.json. By default it exports the exact preserved v0.1.0 bundle. Commit only the descriptor/citations/change note to catalog/releases, not new source blobs. Tool SemVer and bundle change notes are independent; list rules whose changes alter review outcomes.

## npm later

The user has no npm account yet. Packages are prepared but **not published**. A maintainer must choose package ownership/scope and a code license, make the first authorized publication, configure each package's trusted publisher to this repo and npm-publish.yml, and enable protected environment npm-production. Then set repository variable NPM_PUBLISH_ENABLED=true and dispatch the gated workflow for an existing reviewed tag. Use npm >=11.5.1 on Node 24, GitHub-hosted runners, OIDC id-token:write and provenance; do not store a long-lived npm token. The workflow stays disabled until these prerequisites exist.

Official references: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/), [GitHub Releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases), [SARIF support](https://docs.github.com/en/code-security/reference/code-scanning/sarif-support). No scheduled source checker is configured.
