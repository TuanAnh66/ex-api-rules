# ex-api-rules

On-demand Exness Payments and Trading API rule collection, change detection and
offline code review. This is a standalone rules repository; it does not execute
account API requests, transfers, orders or positions.

The initial approved bundle contains 29 rules backed by 27 public documentation
sources. Documented contracts, sanitized case-specific observations and unconfirmed
inferences remain distinct. The approved snapshots, rule IDs and bundle hash are
preserved from the original ExTransfer implementation.

## Setup

Node.js >=22 and pnpm are required.

```powershell
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
node tools/exness-rules.cjs check-updates
node tools/exness-rules.cjs review --project-root PATH_TO_PROJECT --files client.cjs
node tools/exness-rules.cjs review --project-root PATH_TO_PROJECT --base HEAD
```

`--project-root` defaults to the current working directory. Review reads source
files and Git metadata from that project. It loads rules from this repository;
the target project does not need its own copy of the knowledge directory.
Review reports requested with `--out .cache/exness-rules/report.json` are written
inside the target project. Source-download cache, candidates and approvals belong
to this repository. `--project-root` applies only to `review`.

`collect` creates a local candidate. `check-updates` only reports changes.
`approve --candidate ID --reviewed-by NAME` is a separate, explicit review decision.
None of these actions automatically commits, pushes or updates a consuming project.

## Use as a submodule

```powershell
git submodule add https://github.com/TuanAnh66/ex-api-rules.git modules/ex-api-rules
pnpm --dir modules/ex-api-rules install --frozen-lockfile --ignore-scripts
node modules/ex-api-rules/tools/exness-rules.cjs review --project-root . --files client.cjs
```

The consuming repository pins one commit. Publish rule changes here first; then
explicitly select the desired commit/tag in the consuming project, run its tests
and commit the updated submodule pointer there. Clone consumers with
`--recurse-submodules`, or run `git submodule update --init --recursive` afterward.

Read [the agent instructions](agents/exness-api-reviewer.md) and
[the knowledge workflow](knowledge/exness/README.md) before reviewing or approving.
Static checks provide partial coverage and always identify remaining manual work.
No finding does not mean full API compliance.

## Provenance

The source catalog links to official Exness documentation. Downloaded third-party
documentation retains its original content and attribution; this repository does
not claim ownership of it or grant additional rights to that content. The archived
Cent example is sanitized, reference-only evidence, not runtime transaction state.
