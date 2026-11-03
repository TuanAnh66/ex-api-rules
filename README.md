# ex-api-rules

Versioned Exness Payments/Trading evidence and offline code review. One repository maintains language-neutral knowledge, a pure core, a Node.js CLI and an on-demand agent workflow.

Tool **0.2.0** retains the approved **v0.1.0 rule bundle unchanged** (29 rules, 27 sources). This release changes distribution and reproducibility, not Exness requirements. npm publication is deferred; install release tarballs or use the pinned submodule.

## Start from a checkout

Use Node.js 22+ and pnpm 11.25.0:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
pnpm validate
pnpm test
node tools/exness-rules.cjs --help
node tools/exness-rules.cjs pin --project-root /path/to/your/project
node tools/exness-rules.cjs review --project-root /path/to/your/project --files client.cjs --out .cache/exness-rules/review.json
```

Use your actual project path on Windows. Git targets the reviewed project, never the rule checkout. ExTransfer's existing wrapper continues to work.

## Start from GitHub Release tarballs

Download both package tarballs, the portable bundle and SHA256SUMS from the same release. Verify raw file checksums before installation. Until npm publication, install both local tarballs together:

```sh
npm install --ignore-scripts ./ex-api-rules-core-0.2.0.tgz ./ex-api-rules-0.2.0.tgz
npx --no-install ex-api-rules bundle import --file /path/to/exness-bundle-v0.1.0.json
npx --no-install ex-api-rules pin --bundle 2026-11-03T16-00-20-366Z-47729188
npx --no-install ex-api-rules review --files client.cjs
```

The packages contain schemas and authoring resources; source snapshots travel in the separate portable bundle. Existing submodule users may bootstrap the unchanged local legacy snapshot offline.

## Commands

| Command | Effect |
|---|---|
| collect | Public allowlisted downloads; candidate and diff only |
| check-updates | Compare pinned evidence with public sources; report only |
| approve --candidate ID --reviewed-by NAME | Explicit maintainer approval in external store; never changes project lock |
| pin --bundle ID --profile payments | Explicitly write this project's lock |
| review --base REF / --files PATH... | Offline review of target code; JSON by default |
| review ... --format sarif | SARIF 2.1.0 output |
| bundle import/export/verify --file PATH | Verify and move portable immutable evidence |

Common options: --project-root, --data-dir, --bundle, --profile and --out. Runtime output must be in the project's .cache/exness-rules or external data directory. No scheduler, automatic rule approval, automatic lock update, live account API, or credential use.

Review is **partial**: JavaScript AST checks identify selected mistakes, remaining rules need human assessment. Other languages are explicitly unanalyzed. Documented P1 findings exit 1; incomplete source checks or operational errors exit 2. Observations remain scoped evidence; inference never blocks code.

Read [user guide](docs/users.md), [architecture](docs/architecture.md), [data protocol](docs/protocol.md), [contributor guide](CONTRIBUTING.md), [maintainer guide](docs/maintainers.md), [agent instructions](agents/exness-api-reviewer.md), and [release notes](CHANGELOG.md).

## Source and licensing

Official source entry points: [Payments Guides](https://www.exness-api.com/payments/guides) and [Trading Guides](https://www.exness-api.com/trading/guides). Read NOTICE: source material belongs to its owners; this project currently declares no open-source license for its own code. A public repository alone does not establish a reuse license. A maintainer license decision remains necessary before npm publication.
