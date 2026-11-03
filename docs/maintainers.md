# Maintainer workflow

Collect -> candidate/diff -> PR -> maintainer review -> offline tests -> release. All operations run on request. CODEOWNERS requests review but repository branch protection must be configured separately to require it. No cron, automatic candidate approval, automatic consumer pin or automatic source-driven commits.

Review every changed rule against the public original and retained snapshot, including scope, date, precision, permission, error and retry implications. Record the candidate ID, bundle hash, reviewer and decision in release metadata/PR. Term matches only show an anchor still exists. Keep documented, observed and inference separate, including contradictory evidence.

approve --candidate ID --reviewed-by NAME is an explicit maintainer decision. Do not impersonate another reviewer. It writes external approvals and maintainer-active only. pin is a separate consumer decision. Approval interruption leaves a lock rather than silently retrying an unknown partial operation; inspect store artifacts/approvals before clearing a stale write.lock.

## Releases

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
