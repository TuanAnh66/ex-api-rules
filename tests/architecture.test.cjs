'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const core=require('../packages/core/src/index.cjs'),store=require('../packages/cli/src/store.cjs'),cli=require('../packages/cli/src/main.cjs');
const root=path.resolve(__dirname,'..');
function temp(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ex-api-architecture-'));t.after(()=>{if(!path.basename(dir).startsWith('ex-api-architecture-'))throw Error('Unsafe cleanup');fs.rmSync(dir,{recursive:true,force:true});});return dir;}
const spec={openapi:'3.1.1',paths:{'/v1/transfers':{post:{}}},components:{schemas:{TransferRequest:{type:'object',properties:{amount:{type:'string'}},required:['amount']}}}};
function fixture(id='test-one',statement='Use decimal strings.'){
  const raw=JSON.stringify(spec),digest=core.hash(raw),sources=[{id:'payments-spec',kind:'openapi',scope:'payments',url:'https://www.exness-api.com/openapi/payments.public.yaml',snapshot:'sources/'+digest+'.yaml',sha256:digest,fetchedAt:'2026-11-03T00:00:00Z'}];
  const rules=[{id:'PAY-AMOUNT-002',kind:'documented',scope:'payments',statement,evidence:[{sourceId:'payments-spec',terms:['string']}],lifecycle:{status:'approved',revision:1,introducedIn:'test'}}];
  return {schemaVersion:2,manifest:{schemaVersion:1,id,sources,bundleHash:core.hash(core.stringify({sources,rules}))},rules,blobs:{[digest]:Buffer.from(raw).toString('base64')}};
}
function setup(t){const dir=temp(t),data=path.join(dir,'data'),project=path.join(dir,'project');fs.mkdirSync(project);const ctx=cli.context({'project-root':project,'data-dir':data},{distributionRoot:root});return {dir,data,project,ctx};}
test('two projects pin independent immutable bundles and profiles in one store',t=>{
  const {dir,project,ctx,data}=setup(t),other=path.join(dir,'other');fs.mkdirSync(other);
  const one=fixture(),two=fixture('test-two','Use exact decimal strings, never floats.');ctx.store.importBundle(one);ctx.store.importBundle(two);
  store.pin(ctx,{bundle:'test-one',profile:'payments'});const initial=fs.readFileSync(path.join(project,'.ex-api-rules.lock.json'),'utf8');
  const second=cli.context({'project-root':other,'data-dir':data},{distributionRoot:root});store.pin(second,{bundle:'test-two',profile:'trading'});
  assert.equal(store.selectBundle(ctx).bundle.manifest.id,'test-one');assert.equal(store.selectBundle(second).profile,'trading');assert.equal(fs.readFileSync(path.join(project,'.ex-api-rules.lock.json'),'utf8'),initial);
  const mutated=fixture('test-one','Different content.');assert.throws(()=>ctx.store.importBundle(mutated),/immutable/);
  assert.throws(()=>store.selectBundle(ctx,{profile:'trading'}),/differs/);
});
test('portable verification catches missing blobs, tampering and invalid lifecycle',t=>{
  const {ctx}=setup(t),p=fixture();assert.equal(core.verifyPortable(p).blobDigests.length,1);
  const missing=structuredClone(p);missing.blobs={};assert.throws(()=>core.verifyPortable(missing),/blob/);
  const tamper=structuredClone(p);tamper.blobs[Object.keys(p.blobs)[0]]=Buffer.from('changed').toString('base64');assert.throws(()=>core.verifyPortable(tamper),/digest/);
  const draft=fixture('draft');draft.rules[0].lifecycle.status='draft';draft.manifest.bundleHash=core.hash(core.stringify({sources:draft.manifest.sources,rules:draft.rules}));assert.throws(()=>ctx.store.importBundle(draft),/Draft/);
  const malformed=fixture('bad');delete malformed.rules[0].lifecycle;malformed.manifest.bundleHash=core.hash(core.stringify({sources:malformed.manifest.sources,rules:malformed.rules}));assert.throws(()=>ctx.store.importBundle(malformed),/lifecycle/);
});
test('offline review is deterministic, unsupported language is unanalyzed, inference cannot block',t=>{
  const {ctx,project,data}=setup(t),p=fixture();ctx.store.importBundle(p);store.pin(ctx,{bundle:p.manifest.id});
  const vectors=require('./fixtures/protocol-v1.json');fs.writeFileSync(path.join(project,'client.py'),vectors.unsupported.content);fs.writeFileSync(path.join(project,'client.cjs'),'const amount=Number(input.amount);');
  const options={files:['client.py','client.cjs'],'data-dir':data};const a=cli.review(project,options,root),b=cli.review(project,options,root);
  assert.equal(a.resultFingerprint,b.resultFingerprint);assert.deepEqual(a.coverage.unsupportedFiles,['client.py']);assert(a.manualChecks.some(x=>x.file==='client.py'&&/not been analyzed/.test(x.reason)));assert(a.findings.some(x=>x.ruleId==='PAY-AMOUNT-002'));
  const sarif=core.toSarif(a);assert.equal(sarif.version,'2.1.0');assert.equal(sarif.runs[0].results[0].locations[0].physicalLocation.region.startLine,1);
  const inference=fixture('inference');inference.rules[0].kind='inference';inference.manifest.bundleHash=core.hash(core.stringify({sources:inference.manifest.sources,rules:inference.rules}));ctx.store.importBundle(inference);store.pin(ctx,{bundle:'inference'});assert.equal(cli.review(project,options,root).findings.length,0);
  const lock=JSON.parse(fs.readFileSync(path.join(project,'.ex-api-rules.lock.json')));lock.toolVersion='9.0.0';store.atomic(path.join(project,'.ex-api-rules.lock.json'),lock);assert.throws(()=>cli.review(project,options,root),/Tool version/);
});
test('check-updates reports failure/technical changes without altering either pin or approved artifact',async t=>{
  const {ctx,dir,project}=setup(t),p=fixture();ctx.store.importBundle(p);store.pin(ctx,{bundle:p.manifest.id});
  const distribution=path.join(dir,'distribution');fs.mkdirSync(path.join(distribution,'catalog'),{recursive:true});store.atomic(path.join(distribution,'catalog/sources.json'),{allowedHosts:['www.exness-api.com'],maxSources:2,sources:[{...p.manifest.sources[0],discover:false}]});
  const isolated={...ctx,distributionRoot:distribution},lock=fs.readFileSync(path.join(project,'.ex-api-rules.lock.json'),'utf8'),artifact=ctx.store.load(p.manifest.id).artifactSha256;
  const changed=structuredClone(spec);changed.components.schemas.TransferRequest.properties.amount.type='number';
  const report=await store.checkUpdates(isolated,{},async()=>new Response(JSON.stringify(changed)));assert.equal(report.summary.technical,1);assert.deepEqual(report.changes[0].affectedRules,['PAY-AMOUNT-002']);
  const failure=await store.checkUpdates(isolated,{},async()=>{throw Error('fixture offline');});assert.equal(failure.status,'incomplete');assert.equal(failure.summary.failed,1);
  assert.equal(fs.readFileSync(path.join(project,'.ex-api-rules.lock.json'),'utf8'),lock);assert.equal(ctx.store.load(p.manifest.id).artifactSha256,artifact);assert(!fs.existsSync(path.join(ctx.store.root,'maintainer-active.json')));
});
test('collect and approve remain separate; new raw evidence lives outside installation',async t=>{
  const {ctx,dir,project}=setup(t),p=fixture();const distribution=path.join(dir,'distribution');fs.mkdirSync(path.join(distribution,'catalog'),{recursive:true});
  store.atomic(path.join(distribution,'catalog/sources.json'),{allowedHosts:['www.exness-api.com'],maxSources:2,sources:p.manifest.sources});const draft=structuredClone(p.rules);draft[0].lifecycle.status='draft';store.atomic(path.join(distribution,'catalog/rules.json'),draft);
  const isolated={...ctx,distributionRoot:distribution},candidate=await store.collect(isolated,{fetcher:async()=>new Response(JSON.stringify(spec))});assert.equal(candidate.validationError,null);assert(!fs.existsSync(path.join(ctx.store.root,'maintainer-active.json')));assert(!fs.existsSync(path.join(project,'.ex-api-rules.lock.json')));
  assert.throws(()=>store.approve(isolated,candidate.candidate,''),/reviewed-by/);const approved=store.approve(isolated,candidate.candidate,'Fixture maintainer');assert.equal(ctx.store.load(approved.version).rules[0].lifecycle.status,'approved');assert(!fs.existsSync(path.join(distribution,'knowledge')));assert(!fs.existsSync(path.join(project,'.ex-api-rules.lock.json')));
});
test('language-neutral vectors and core dependency boundary are explicit',()=>{
  const vector=require('./fixtures/protocol-v1.json');assert.equal(core.stringify(vector.input),vector.canonical);assert.throws(()=>core.stringify({amount:0.1}),/decimal strings/);
  const text=fs.readFileSync(path.join(root,'packages/core/src/index.cjs'),'utf8');assert(!/require\(['"](?:node:fs|acorn|yaml|cheerio)/.test(text));
});
test('runtime rejects data/output inside installation',t=>{
  const {project,ctx}=setup(t);assert.throws(()=>cli.context({'project-root':project,'data-dir':path.join(root,'.cache')},{distributionRoot:root}),/outside/);assert.throws(()=>cli.outputPath(ctx,path.join(root,'.cache/report.json')),/--out|installation/);
});
