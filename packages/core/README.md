# ex-api-rules-core

Pure data protocol for ex-api-rules: JSON Schema 2020-12 validation, portable bundle integrity, canonical JSON/hashes, profile selection and SARIF. No filesystem, HTTP, YAML or language parsers. Exports CommonJS plus TypeScript declarations and schemas/*.schema.json. See the repository's docs/protocol.md and NOTICE. Version 0.2.1 is being prepared as a draft release; npm publication pending.

const core = require('ex-api-rules-core');
const verified = core.verifyPortable(portableBundle);
const applicable = core.selectRules(verified.rules, 'payments');

Integrity validation does not establish semantic accuracy or maintainer trust. Consumers must verify the release provenance and declared compatible schema/tool versions.

`stringify(value)` emits UTF-16 member order even for numeric keys. For bundle digests use `bundleStringify(manifest, value)`: `manifest.canonicalization: "utf16-v1"` selects that order; unmarked bundles retain `ecmascript-v0` via `legacyStringify(value)`. `canonical(value)` returns validated data, not serialized bytes. See docs/protocol.md for compatibility and cross-language vectors.
