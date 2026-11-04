'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {spawnSync} = require('node:child_process');
const core = require('../packages/core/src/index.cjs');
const legacy = require('../packages/cli/src/legacy-core.cjs');
const store = require('../packages/cli/src/store.cjs');
const {analyze} = require('../packages/cli/src/adapters/javascript.cjs');
const {gitEnvironment} = require('../packages/cli/src/git.cjs');
const {benign, violations, transfer} = require('./fixtures/adapter-confidence.cjs');
const root = path.resolve(__dirname, '..');
const active = legacy.readJSON(path.join(root, 'knowledge/exness/active.json'));
const portable = store.portableFromDirectory(path.join(root, 'knowledge/exness/versions', active.version));
const legacyHash = 'e3a79f510ff6364440e5e7d9832f48c9f5ee99ceee5f62e73905d1fe8c0b4e37';
assert.equal(portable.manifest.bundleHash, legacyHash);
const rules = core.selectRules(portable.rules);
const spec = portable.manifest.sources.find(s => s.id === 'payments-spec');
const validate = legacy.validator(core.decodeBlob(portable.blobs[spec.sha256]), 'TransferRequest');

for (const [name, source] of benign) test(`adapter leaves ${name} non-blocking`, () => {
  const report = analyze(source, name + '.cjs', rules, validate);
  assert.deepEqual(report.findings, [], JSON.stringify(report.findings));
  assert(report.manual.length > 0, 'No findings must not imply proven compliance');
});
for (const [name, source, ruleId] of violations) test(`adapter detects request-context violation ${name}`, () => {
  const report = analyze(source, name + '.cjs', rules, validate);
  const finding = report.findings.find(f => f.ruleId === ruleId);
  assert(finding, JSON.stringify(report));
  assert.equal(finding.kind, 'documented'); assert.equal(finding.severity, 'P1');
  assert(finding.evidence.length && finding.line > 0 && finding.recommendation);
});

test('unresolved retry, ACK, transfer and signing flow has a located manual reason', () => {
  for (const [source, ruleId] of [
    ['function retry(){return crypto.randomUUID();}', 'PAY-UUID-003'],
    ['if(ack.operation_id){record.state="done";}', 'TRADE-ACK-002'],
    [transfer('{...unknown,destination_type:"own_account"}'), 'PAY-REQUEST-001'],
    ['function sign(body){return {body_hash:hashBody(body),path:requestPath};}', 'COMMON-SIGN-001']
  ]) {
    const report = analyze(source, 'unresolved.cjs', rules, validate);
    assert.equal(report.findings.length, 0);
    assert(report.manual.some(m => m.ruleId === ruleId && m.line > 0 && /unresolved/.test(m.reason)));
  }
});

test('a body_hash getter that can rewrite path leaves all signing metadata manual', () => {
  const source = "fetch('https://api.exness.com/v1/accounts/example/balance?fixture=1',{headers:{'EXN-DATA':Buffer.from(JSON.stringify({get body_hash(){this.path='/v1/accounts/example/balance?fixture=1';return '47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU';},path:'/wrong'})).toString('base64url')}});";
  const report = analyze(source, 'getter-mutates-path.cjs', rules, validate);
  assert.deepEqual(report.findings, []);
  assert(report.manual.some(m => m.ruleId === 'COMMON-SIGN-001' && /final serialized metadata is unresolved/.test(m.reason)));
});

test('CLI and SARIF agree on benign, unresolved and proven request-context fixtures', t => {
  const parent = fs.realpathSync(os.tmpdir()), dir = fs.mkdtempSync(path.join(parent, 'ex-api-confidence-'));
  t.after(() => {
    const real = fs.realpathSync(dir);
    if (path.dirname(real) !== parent || !path.basename(real).startsWith('ex-api-confidence-')) throw Error('Unsafe cleanup');
    fs.rmSync(real, {recursive: true, force: true});
  });
  const project = path.join(dir, 'project'), data = path.join(dir, 'data');
  fs.mkdirSync(project);
  // Import the already approved immutable baseline; no approval or pin.
  store.createStore(data).importBundle(portable);
  const guard = path.join(dir, 'offline.cjs');
  fs.writeFileSync(guard, "const deny=()=>{throw Error('OFFLINE_FIXTURE_NETWORK_BLOCKED')};globalThis.fetch=deny;for(const id of ['node:net','node:tls','node:http','node:https','node:dns']){const m=require(id);for(const k of ['connect','createConnection','request','get','lookup','resolve'])if(typeof m[k]==='function')m[k]=deny;if(m.Socket)m.Socket.prototype.connect=deny;}\n");
  const run = (cases, format) => {
    const files = cases.map(([name, source]) => {
      const file = name + '.cjs'; fs.writeFileSync(path.join(project, file), source); return file;
    });
    const result = spawnSync(process.execPath, ['--require', guard, path.join(root, 'tools/exness-rules.cjs'), 'review',
      '--project-root', project, '--data-dir', data, '--bundle', portable.manifest.id, '--files', ...files, '--format', format],
    {env: gitEnvironment(), cwd: dir, encoding: 'utf8', timeout: 60000, windowsHide: true, maxBuffer: 16 * 1024 * 1024});
    assert.equal(result.error, undefined); assert(result.stdout, result.stderr);
    return {status: result.status, report: JSON.parse(result.stdout)};
  };
  const good = run(benign, 'json'), goodSarif = run(benign, 'sarif');
  assert.equal(good.status, 0); assert.equal(goodSarif.status, 0);
  assert.equal(good.report.bundleHash, legacyHash);
  assert.equal(good.report.sourceFreshness.latestClaim, false);
  assert.equal(good.report.outcome, 'PARTIAL_REVIEW_REQUIRES_HUMAN');
  assert.deepEqual(good.report.findings, []); assert.deepEqual(goodSarif.report.runs[0].results, []);
  assert.deepEqual(goodSarif.report.runs[0].properties.manualChecks, good.report.manualChecks);
  assert.equal(goodSarif.report.runs[0].properties.outcome, good.report.outcome);
  const olderReport = {...good.report,schemaVersion:1}; delete olderReport.outcome;
  assert.doesNotThrow(() => core.stringify(core.toSarif(olderReport)), 'Reports without the optional outcome remain serializable');
  assert.equal(goodSarif.report.runs[0].properties.resultFingerprint, good.report.resultFingerprint);
  for (const [name] of benign) assert(good.report.manualChecks.some(m => m.file === name + '.cjs'));
  const bad = run(violations, 'json'), badSarif = run(violations, 'sarif');
  assert.equal(bad.status, 1); assert.equal(badSarif.status, 1);
  for (const [name, , ruleId] of violations) assert(bad.report.findings.some(f => f.file === name + '.cjs' && f.ruleId === ruleId));
  const findings = bad.report.findings.map(f => [f.ruleId, f.file, f.line, f.kind]).sort();
  const sarifFindings = badSarif.report.runs[0].results.map(f => {
    assert.equal(f.level, 'error'); assert(f.properties.evidence.length);
    const location = f.locations[0].physicalLocation;
    return [f.ruleId, decodeURIComponent(location.artifactLocation.uri), location.region.startLine, f.properties.kind];
  }).sort();
  assert.deepEqual(sarifFindings, findings);
  assert.equal(badSarif.report.runs[0].properties.resultFingerprint, bad.report.resultFingerprint);
  assert(!fs.existsSync(path.join(project, '.ex-api-rules.lock.json')));
  assert(!fs.existsSync(path.join(data, 'maintainer-active.json')));
});
