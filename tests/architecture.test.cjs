'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const core=require('../packages/core/src/index.cjs'),store=require('../packages/cli/src/store.cjs'),cli=require('../packages/cli/src/main.cjs');
const root=path.resolve(__dirname,'..');
function temp(t){const parent=fs.realpathSync(os.tmpdir()),dir=fs.mkdtempSync(path.join(parent,'ex-api-architecture-'));t.after(()=>{const real=fs.realpathSync(dir);if(path.dirname(real)!==parent||!path.basename(real).startsWith('ex-api-architecture-'))throw Error('Unsafe cleanup');fs.rmSync(real,{recursive:true,force:true});});return dir;}
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

test('canonical integer and UTF-16 keys agree with both explicit protocol algorithms',()=>{
  for(const vector of require('./fixtures/protocol-v1.json').canonicalCases){
    assert.equal(core.stringify(vector.input),vector.canonical,vector.name);
    assert.equal(core.legacyStringify(vector.input),vector.legacyCanonical,vector.name);
  }
  assert.throws(()=>core.stringify(Array(1)),/JSON protocol value/);
});

test('numeric-key portable bundles retain their declared digest algorithm across store round trips',t=>{
  const {ctx}=setup(t);
  for(const algorithm of ['utf16-v1','ecmascript-v0',undefined]){
    const p=fixture('numeric-'+(algorithm||'unmarked'));
    if(algorithm)p.manifest.canonicalization=algorithm;
    p.rules[0].metadata={'2':'two','10':'ten'};
    const encode=algorithm==='utf16-v1'?core.stringify:core.legacyStringify;
    p.manifest.bundleHash=core.hash(encode({sources:p.manifest.sources,rules:p.rules}));
    const artifact=core.hash(encode(p));
    assert.equal(core.verifyPortable(p).artifactSha256,artifact);
    assert.notEqual(core.hash((algorithm==='utf16-v1'?core.legacyStringify:core.stringify)(p)),artifact);
    ctx.store.importBundle(p);const loaded=ctx.store.load(p.manifest.id,artifact);
    assert.equal(loaded.artifactSha256,artifact);assert.equal(loaded.manifest.bundleHash,p.manifest.bundleHash);
    require('../packages/cli/src/legacy-core.cjs').verifyBundle(ctx.store.materialize(loaded));
    const wrong=structuredClone(p);wrong.manifest.canonicalization=algorithm==='utf16-v1'?'ecmascript-v0':'utf16-v1';
    assert.throws(()=>core.verifyPortable(wrong),/digest mismatch/);
    const unknown=structuredClone(p);unknown.manifest.canonicalization='future-v2';assert.throws(()=>core.verifyPortable(unknown),/schema validation/);
  }
});

test('preserved v0.1.0 bundle and portable artifact match the approved release descriptor',()=>{
  const descriptor=require('../catalog/releases/v0.1.0.json'),active=require('../knowledge/exness/active.json');
  const p=store.portableFromDirectory(path.join(root,'knowledge/exness/versions',active.version));
  assert.equal(p.manifest.canonicalization,undefined);
  assert.equal(p.manifest.bundleHash,descriptor.bundleHash);
  assert.equal(core.verifyPortable(p).artifactSha256,descriptor.artifactSha256);
});
test('runtime rejects data/output inside installation',t=>{
  const {project,ctx}=setup(t);assert.throws(()=>cli.context({'project-root':project,'data-dir':path.join(root,'.cache')},{distributionRoot:root}),/outside/);assert.throws(()=>cli.outputPath(ctx,path.join(root,'.cache/report.json')),/--out|installation/);
});

test('runtime validates missing ancestors and rejects submodule and private destinations',t=>{
  const {dir,ctx,project}=setup(t),writes=require('../packages/cli/src/write-path.cjs');
  const missing=path.join(dir,'new','nested','store');assert.equal(writes.assertRuntimePath(missing),missing);assert(!fs.existsSync(missing));
  const submodule=path.join(dir,'submodule');fs.mkdirSync(submodule);fs.writeFileSync(path.join(submodule,'.git'),'gitdir: ../super/.git/modules/fixture\n');
  assert.throws(()=>cli.context({'project-root':project,'data-dir':path.join(submodule,'missing/store')},{distributionRoot:root}),/submodule/);
  const subctx={...ctx,projectRoot:submodule};assert.throws(()=>cli.outputPath(subctx,'.cache/exness-rules/report.json'),/submodule/);
  assert.throws(()=>store.atomic(path.join(submodule,'missing/report.json'),{}),/submodule/);assert(!fs.existsSync(path.join(submodule,'missing')));
  for(const name of ['node_modules','.git','exness-custom-key','.env.test'])assert.throws(()=>writes.assertRuntimePath(path.join(dir,name,'new/report.json')),/Private/);
  assert.throws(()=>store.createStore(path.join(root,'new-runtime-store')),/installation/);
  assert.throws(()=>cli.outputPath(ctx,'../outside.json'),/outside/);
  assert.equal(cli.outputPath(ctx,'.cache/exness-rules/report.json'),path.join(project,'.cache/exness-rules/report.json'));
  const worktree=path.join(dir,'worktree');fs.mkdirSync(worktree);fs.writeFileSync(path.join(worktree,'.git'),'gitdir: ../super/.git/worktrees/fixture\n');
  assert.equal(writes.assertRuntimePath(path.join(worktree,'.cache/report.json')),path.join(worktree,'.cache/report.json'));
});

test('installed CLI does not mistake its consuming pnpm workspace for the tool checkout',t=>{
  const consumer=temp(t),src=path.join(consumer,'node_modules/ex-api-rules/src');fs.mkdirSync(src,{recursive:true});
  fs.writeFileSync(path.join(consumer,'pnpm-workspace.yaml'),'packages: ["packages/*"]\n');
  const installed=path.join(src,'write-path.cjs');fs.copyFileSync(path.join(root,'packages/cli/src/write-path.cjs'),installed);
  const writes=require(installed),report=path.join(consumer,'.cache/exness-rules/report.json');
  assert.equal(writes.assertRuntimePath(report),report);
  assert.equal(writes.assertRuntimePath(path.join(consumer,'.ex-api-rules.lock.json')),path.join(consumer,'.ex-api-rules.lock.json'));
  assert.throws(()=>writes.assertRuntimePath(path.join(src,'new/report.json')),/Private|installation/);
});

function directoryLink(t,target,alias){
  try{fs.symlinkSync(target,alias,process.platform==='win32'?'junction':'dir');return true;}
  catch(e){if(!['EPERM','EACCES','ENOTSUP'].includes(e.code))throw e;t.skip('Filesystem links are unavailable in this environment: '+e.code);return false;}
}
test('runtime rejects linked data roots even when the child store does not exist',t=>{
  const {dir,project}=setup(t),installation=path.join(dir,'installation'),alias=path.join(dir,'alias');fs.mkdirSync(installation);
  if(!directoryLink(t,installation,alias))return;
  assert.throws(()=>cli.context({'project-root':project,'data-dir':path.join(alias,'missing/store')},{distributionRoot:installation}),/installation|link/);
  assert(!fs.existsSync(path.join(installation,'missing')));
});
test('runtime rejects a linked project cache without writing to its target',t=>{
  const {dir,ctx,project}=setup(t),outside=path.join(dir,'outside');fs.mkdirSync(outside);fs.mkdirSync(path.join(project,'.cache'));
  if(!directoryLink(t,outside,path.join(project,'.cache/exness-rules')))return;
  assert.throws(()=>cli.outputPath(ctx,'.cache/exness-rules/new/report.json'),/link|outside/);
  assert(!fs.existsSync(path.join(outside,'new')));
});
test('runtime rechecks store children immediately before writes',t=>{
  const {dir,data}=setup(t),outside=path.join(dir,'outside');fs.mkdirSync(outside);fs.mkdirSync(data);
  const persistent=store.createStore(data);
  if(!directoryLink(t,outside,path.join(data,'bundles')))return;
  assert.throws(()=>persistent.importBundle(fixture()),/link/);
  assert.throws(()=>store.atomic(path.join(data,'bundles/new/report.json'),{}),/link/);
  assert.deepEqual(fs.readdirSync(outside),[]);
});

test('runtime rejects existing output file links and preserves the linked file bytes',t=>{
  const {dir,data}=setup(t),outside=path.join(dir,'outside.json');fs.mkdirSync(data);fs.writeFileSync(outside,'sanitized sentinel');
  const alias=path.join(data,'report.json');
  try{fs.symlinkSync(outside,alias,'file');}
  catch(e){if(!['EPERM','EACCES','ENOTSUP'].includes(e.code))throw e;t.skip('Filesystem links are unavailable in this environment: '+e.code);return;}
  assert.throws(()=>store.atomic(alias,{changed:true}),/link/);assert.equal(fs.readFileSync(outside,'utf8'),'sanitized sentinel');
});

test('runtime rejects dangling links with missing descendant destinations',t=>{
  const {dir,project}=setup(t),alias=path.join(dir,'dangling'),target=path.join(dir,'missing-target');
  fs.mkdirSync(target);
  if(!directoryLink(t,target,alias))return;
  fs.rmdirSync(target);
  assert.throws(()=>cli.context({'project-root':project,'data-dir':path.join(alias,'missing/store')},{distributionRoot:root}),/Dangling|ENOENT/);
  assert(!fs.existsSync(target));
});

test('CLI signing review keeps uncertain hashes non-blocking and still blocks a fixed wrong input',t=>{
  const {project,data}=setup(t),{spawnSync}=require('node:child_process');
  const run=code=>{
    fs.writeFileSync(path.join(project,'client.cjs'),code);
    const result=spawnSync(process.execPath,[path.join(root,'tools/exness-rules.cjs'),'review','--project-root',project,'--data-dir',data,'--files','client.cjs'],{encoding:'utf8'});
    assert(result.stdout,result.stderr);return {status:result.status,report:JSON.parse(result.stdout)};
  };
  const good=run("function sign(body){const hash=crypto.createHash('sha256').update(body).digest('base64url');return {body_hash:hash};}");
  assert.equal(good.status,0);assert.equal(good.report.findings.length,0);
  const unknown=run("function sign(body){return {body_hash:hashBody(body)};}");
  assert.equal(unknown.status,0);assert(unknown.report.manualChecks.some(m=>m.ruleId==='COMMON-SIGN-001'&&/unresolved/.test(m.reason)));
  const {signing,hash}=require('./fixtures/adapter-confidence.cjs');
  const bad=run(signing(`{body_hash:${hash('wrong')},path:'/v1/accounts/example/balance?fixture=1'}`));
  assert.equal(bad.status,1);assert(bad.report.findings.some(f=>f.ruleId==='COMMON-SIGN-001'&&f.kind==='documented'));
});
