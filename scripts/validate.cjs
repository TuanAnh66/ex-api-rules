'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),core=require('../packages/core/src/index.cjs'),legacy=require('../packages/cli/src/legacy-core.cjs'),{allowed}=require('../packages/cli/src/collector.cjs');
for(const file of ['package.json','packages/core/package.json','packages/cli/package.json'])assert.equal(legacy.readJSON(path.join(root,file)).version,core.VERSION);
const rules=core.validate('catalog',legacy.readJSON(path.join(root,'catalog/rules.json'))),checks=core.validate('checks',legacy.readJSON(path.join(root,'catalog/checks.json'))),catalog=legacy.readJSON(path.join(root,'catalog/sources.json'));
assert.equal(new Set(rules.map(r=>r.id)).size,rules.length);
for(const source of catalog.sources)allowed(source.url,catalog);
for(const rule of rules){for(const id of rule.conflictsWith||[])assert(rules.some(r=>r.id===id));if(rule.lifecycle.status==='superseded')assert(rules.some(r=>r.id===rule.lifecycle.supersededBy));}
for(const check of checks){for(const id of check.ruleIds)assert(rules.some(r=>r.id===id),id);for(const reference of check.tests){const [file,title]=reference.split('#');assert(fs.readFileSync(path.join(root,file),'utf8').includes(title),reference);}}
for(const name of ['rule','bundle','report','report-v2','lock','catalog','checks'])assert.equal(fs.readFileSync(path.join(root,'schemas',name+'.schema.json'),'utf8'),fs.readFileSync(path.join(root,'packages/core/schemas',name+'.schema.json'),'utf8'));
const active=legacy.readJSON(path.join(root,'knowledge/exness/active.json')),bundle=legacy.verifyBundle(path.join(root,'knowledge/exness/versions',active.version));assert.equal(bundle.manifest.bundleHash,require('../packages/cli/src/store.cjs').LEGACY_HASH);
const reportVectors=legacy.readJSON(path.join(root,'tests/fixtures/report-protocol-v2.json'));
for(const report of Object.values(reportVectors.reports)){core.validate('report',report);core.toSarif(report);}
console.log('Catalog, schemas, check–test links and unchanged v0.1.0 bundle verified.');
