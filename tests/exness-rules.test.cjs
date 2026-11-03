'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const core=require('../tools/exness-rules/core.cjs');
const {allowed,download,fetchSources,compareSources}=require('../tools/exness-rules/sources.cjs');
const {layout,collect,approve,loadActive,checkUpdates}=require('../tools/exness-rules/store.cjs');
const {analyze,reviewFiles}=require('../tools/exness-rules/review.cjs');
const {parse,review}=require('../tools/exness-rules.cjs');
const {execFileSync,spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),catalog=core.readJSON(path.join(root,'knowledge/exness/source-catalog.json'));
function sourceFixture(id){const active=loadActive(root),source=active.manifest.sources.find(s=>s.id===id);return fs.readFileSync(path.join(active.dir,source.snapshot));}
const schema={openapi:'3.1.1',info:{title:'fixture',version:'1',description:'Keep same UUID on retry; permission scope and limits 3 requests per second.'},paths:{'/v1/transfers':{post:{'x-public-error-codes':['REQUEST_INVALID_PARAMETERS']}}},components:{schemas:{TransferRequest:{type:'object',additionalProperties:false,required:['destination_type','source_account','destination_account','amount'],properties:{destination_type:{enum:['own_account','another_client']},source_account:{type:'string',minLength:1},destination_account:{type:'string',minLength:1},amount:{type:'string',pattern:'^[0-9]+(\\.[0-9]+)?$'}}}}}};
function temp(t){const d=fs.mkdtempSync(path.join(os.tmpdir(),'exness-rules-test-'));t.after(()=>{const expected=fs.realpathSync(os.tmpdir())+path.sep+'exness-rules-test-';if(!fs.realpathSync(d).startsWith(expected))throw Error('Refuse cleanup outside test directory');fs.rmSync(d,{recursive:true,force:true});});return d;}
function fixture(t){const d=temp(t),base=path.join(d,'knowledge/exness');fs.mkdirSync(base,{recursive:true});core.writeJSON(path.join(base,'source-catalog.json'),{allowedHosts:['www.exness-api.com'],maxSources:10,sources:[{id:'payments-spec',url:'https://www.exness-api.com/openapi/payments.public.yaml',kind:'openapi',scope:'payments'}]});core.writeJSON(path.join(base,'rule-seeds.json'),[{id:'PAY-REQUEST-001',kind:'documented',scope:'payments',statement:'Use required fields.',evidence:[{sourceId:'payments-spec',pointer:'#/components/schemas/TransferRequest',terms:['amount']}],endpoints:['POST /v1/transfers'],reviewTargets:['transfer-*.cjs'],tests:['schema regression']}]);return d;}
const mock=body=>async()=>new Response(typeof body==='string'?body:JSON.stringify(body));
function digestTree(dir){return fs.readdirSync(dir,{recursive:true,withFileTypes:true}).filter(x=>x.isFile()).map(x=>{const file=path.join(x.parentPath,x.name);return [path.relative(dir,file),core.hash(fs.readFileSync(file))];}).sort();}

test('public downloader rejects live API hosts, credentials, private hosts and unsafe redirects',async()=>{
  for(const url of ['http://www.exness-api.com/payments/guides','https://api.exness.com/v1/transfers','https://127.0.0.1/payments/guides','https://user:secret@www.exness-api.com/payments/guides','https://www.exness-api.com:8443/payments/guides'])assert.throws(()=>allowed(url,catalog));
  let calls=0;await assert.rejects(()=>download('https://www.exness-api.com/payments/guides',catalog,async()=>{calls++;return new Response(null,{status:302,headers:{location:'https://api.exness.com/v1/transfers'}});}),/allowed public/);assert.equal(calls,1);
});
test('fetch retries transport errors; HTTP errors and challenge documents are not unchanged',async t=>{
  let calls=0;const fetched=await download('https://www.exness-api.com/openapi/payments.public.yaml',catalog,async()=>{if(calls++===0)throw Error('offline');return new Response(JSON.stringify(schema));});assert.equal(calls,2);assert.equal(core.hash(fetched.raw),core.hash(JSON.stringify(schema)));
  await assert.rejects(()=>download('https://www.exness-api.com/payments/guides',catalog,async()=>new Response('missing',{status:404})),/404/);
  assert.throws(()=>core.normalize('<html>Cloudflare challenge</html>','html'),/No documentation/);
  const records=await fetchSources({...catalog,sources:[catalog.sources[2]]},temp(t),mock('<html>challenge</html>'));assert(records[0].error);
});
test('HTML presentation and example-only edits are separated from normative edits',()=>{
  const old='<article><h1>Rules</h1><p>Use the same key for retries and record every attempt.</p><pre>amount=100</pre></article>';
  assert.equal(core.classify(old,'<nav>new menu</nav>'+old,'html').classification,'presentation');
  assert.equal(core.classify(old,old.replace('amount=100','amount=200'),'html').classification,'examples');
  assert.equal(core.classify(old,old.replace('same key','new key'),'html').classification,'technical');
});
test('OpenAPI changes distinguish examples, formatting, schemas, scopes, errors, rate and retry',()=>{
  const raw=JSON.stringify(schema);
  assert.equal(core.classify(raw,JSON.stringify(schema,null,2),'openapi').classification,'presentation');
  const examples=structuredClone(schema);examples.components.schemas.TransferRequest.examples=[{amount:'50'}];assert.equal(core.classify(raw,JSON.stringify(examples),'openapi').classification,'examples');
  for(const mutate of [s=>s.components.schemas.TransferRequest.properties.amount.type='number',s=>s.info.description=s.info.description.replace('permission scope','partner scope'),s=>s.paths['/v1/transfers'].post['x-public-error-codes'].push('NEW_ERROR'),s=>s.info.description=s.info.description.replace('3 requests','2 requests'),s=>s.info.description=s.info.description.replace('same UUID','new UUID')]){
    const next=structuredClone(schema);mutate(next);const diff=core.classify(raw,JSON.stringify(next),'openapi');assert.equal(diff.classification,'technical');assert(diff.paths.length);
  }
});
test('discovery fetches appended sources even when the initial batch is partial',async t=>{
  const records=await fetchSources({allowedHosts:['www.exness-api.com'],maxSources:5,sources:[{id:'guides',kind:'html',scope:'payments',discover:true,url:'https://www.exness-api.com/payments/guides'}]},temp(t),async url=>new Response('<article><h1>Documentation</h1><p>These are enough source words to be a real article fixture.</p>'+(url.endsWith('/guides')?'<a href="/payments/guides/troubleshooting">Errors</a><a href="https://api.exness.com/v1/transfers">Forbidden</a>':'')+'</article>'));
  assert.equal(records.length,2);assert(records.every(r=>r.sha256));
});
test('collect creates candidates only; explicit approval verifies hashes and retains prior versions',async t=>{
  const d=fixture(t),candidate=await collect(d,{fetcher:mock(schema)});assert.equal(candidate.validationError,null);assert(!fs.existsSync(layout(d).active));
  assert.throws(()=>approve(d,candidate.candidate,''),/reviewer/);
  const approval=approve(d,candidate.candidate,'offline-test-reviewer');assert.equal(loadActive(d).active.version,approval.version);
  const second=await collect(d,{fetcher:mock(schema)});approve(d,second.candidate,'offline-test-reviewer');assert.equal(fs.readdirSync(layout(d).versions).length,2);
});
test('tampered or partial candidates cannot be approved',async t=>{
  const d=fixture(t),candidate=await collect(d,{fetcher:mock(schema)}),dir=path.join(layout(d).candidates,candidate.candidate),manifest=core.readJSON(path.join(dir,'manifest.json'));
  fs.appendFileSync(path.join(dir,manifest.sources[0].snapshot),'tamper');assert.throws(()=>approve(d,candidate.candidate,'reviewer'),/digest mismatch/);
  const failed=await collect(d,{fetcher:async()=>new Response('missing',{status:404})});assert(failed.validationError);assert.throws(()=>approve(d,failed.candidate,'reviewer'),/Incomplete source/);
});
test('check-updates reports impacted rules/endpoints/tests and never changes approved state',async t=>{
  const d=fixture(t),candidate=await collect(d,{fetcher:mock(schema)});approve(d,candidate.candidate,'reviewer');const before=digestTree(layout(d).base);
  const next=structuredClone(schema);next.info.description='Changed retry rules and limits';const report=await checkUpdates(d,{fetcher:mock(next)});
  assert.equal(report.summary.technical,1);assert.deepEqual(report.changes[0].affectedRules,['PAY-REQUEST-001']);assert(report.changes[0].endpoints.includes('POST /v1/transfers'));assert(report.changes[0].tests.includes('schema regression'));assert.deepEqual(digestTree(layout(d).base),before);
  const failed=await checkUpdates(d,{fetcher:async()=>new Response('missing',{status:404})});assert.equal(failed.status,'incomplete');assert.equal(failed.changes[0].classification,'unavailable-or-unparseable');assert.equal(failed.changes[0].failureType,'removed');assert.deepEqual(digestTree(layout(d).base),before);
});
test('unparseable changed source and moved source are explicitly reported',async t=>{
  const d=fixture(t),candidate=await collect(d,{fetcher:mock(schema)});approve(d,candidate.candidate,'reviewer');
  const broken=await checkUpdates(d,{fetcher:mock('not an openapi document')});assert.equal(broken.status,'incomplete');assert.equal(broken.changes[0].failureType,'parse-error');
  const moved=await checkUpdates(d,{fetcher:async url=>url.includes('www.')?new Response(null,{status:302,headers:{location:'https://www.exness-api.com/openapi/trading.public.yaml'}}):new Response(JSON.stringify(schema))});
  assert.equal(moved.status,'incomplete'); // redirect loop is not success
  const redirected=await checkUpdates(d,{fetcher:async url=>url.endsWith('/payments.public.yaml')?new Response(null,{status:302,headers:{location:'https://www.exness-api.com/openapi/trading.public.yaml'}}):new Response(JSON.stringify(schema))});
  assert.equal(redirected.changes[0].classification,'source-moved');
});

const seeds=core.readJSON(path.join(root,'knowledge/exness/rule-seeds.json')).map(r=>({...r,evidence:r.evidence||[{originalPath:r.localEvidence}]}));
const validate=core.validator(JSON.stringify(schema),'TransferRequest');
test('review detects wrong signed body/path, wrong host, retry UUID, ACK finality and precision',()=>{
  const cases=[
    ["function sign(body,requestPath){return {body_hash:crypto.createHash('sha256').update('wrong').digest('base64url'),path:'/wrong'};}",'COMMON-SIGN-001'],
    ["fetch('https://api.exness.com/v1/trading/accounts/90000000001/orders');",'TRADE-HOST-001'],
    ["function retry(){return crypto.randomUUID();}",'PAY-UUID-003'],
    ["if(ack.operation_id){record.state='done';}",'TRADE-ACK-002'],
    ["const price = parseFloat(input.price);",'TRADE-PRECISION-005'],
    ["const amount = Number(input.amount);",'PAY-AMOUNT-002'],
    ["if(r.json.transfer_id !== record.transferId){throw Error('bad');}",'OBS-TRANSFER-ID-002'],
    ["const body={destination_type:'own_account',source_account:123,destination_account:'456',amount:600};",'PAY-REQUEST-001']
  ];
  for(const [code,id]of cases){const report=analyze(code,'fixture.cjs',seeds,validate);assert(report.findings.some(f=>f.ruleId===id),id);assert(report.findings.every(f=>f.line>0&&f.evidence.length&&f.recommendation));}
});
test('valid-looking code is not declared fully compliant; comments do not produce findings',()=>{
  const report=analyze("// function retry(){return crypto.randomUUID();}\nconst body={destination_type:'own_account',source_account:'123',destination_account:'456',amount:'600'};",'fixture.cjs',seeds,validate);
  assert.equal(report.findings.length,0);assert(report.manual.length>0);
  assert.equal(analyze('const broken = ;','bad.cjs',seeds,validate).manual.length,1);
});
test('review never imports source code and blocks private paths, traversal and secret aliases',t=>{
  const d=temp(t);fs.writeFileSync(path.join(d,'safe.cjs'),"throw Error('MUST NOT EXECUTE');");assert.equal(reviewFiles(d,['safe.cjs'],{rules:seeds},validate).length,1);
  for(const name of ['../outside.cjs','exness-custom-key/private.pem','config.local.json','.env.secret','keys.key'])assert.throws(()=>core.publicFile(d,name));
  fs.writeFileSync(path.join(d,'config.local.json'),'private');try{fs.symlinkSync(path.join(d,'config.local.json'),path.join(d,'alias.cjs'));assert.throws(()=>core.publicFile(d,'alias.cjs'));}catch(e){if(e.code!=='EPERM')throw e;}
});
test('schema response and observed response conflicts remain separate evidence, including unsafe IDs',()=>{
  const raw=sourceFixture('payments-spec');
  const balance=core.validator(raw,'AccountBalance'),id=core.validator(raw,'TransferId');
  assert(balance({account_id:'90000000001',balance:'546',currency:'USC'}));assert(!balance({amount:'546',currency:'USC'}));
  assert(id('123'));assert(!id(123));assert(!id(Number.MAX_SAFE_INTEGER+1));
  const evidence=core.readJSON(path.join(root,'archive/first-success-600-usc.sanitized.json'));assert(evidence.runtimeObservations.some(x=>x.includes('number')));assert.equal(evidence.runtimeUsable,false);
  assert(seeds.find(r=>r.id==='OBS-BALANCE-001').conflictsWith.includes('PAY-BALANCE-012'));
});
test('actual Payments request schema preserves decimal strings and forbids extra currency',()=>{
  const validateBody=core.validator(sourceFixture('payments-spec'),'TransferRequest');
  const body={destination_type:'own_account',source_account:'90000000001',destination_account:'90000000002',amount:'600.00'};
  assert(validateBody(body));assert(!validateBody({...body,amount:600}));assert(!validateBody({...body,currency:'USC'}));
});
test('Trader ACK and final operation status have separate schemas and states',()=>{
  const raw=sourceFixture('trading-spec'),ack=core.validator(raw,'AckResponse'),operation=core.validator(raw,'OperationStatusResponse');
  assert(ack({status:'accepted',operation_id:'123'}));assert(!ack({status:'done'}));
  const result={operation_id:'123',status:'confirmed',created_at:'2026-11-03T00:00:00Z',updated_at:'2026-11-03T00:00:01Z'};
  assert(operation(result));assert(!operation({...result,status:'accepted'}));
});
test('CLI rejects ambiguous and missing arguments',()=>{
  assert.deepEqual(parse(['review','--files','a.cjs','b.cjs']).files,['a.cjs','b.cjs']);assert.throws(()=>parse(['approve','--candidate']),/Missing/);assert.throws(()=>parse(['review','--execute']),/Unknown/);
});
test('review uses target project Git HEAD and files while keeping module knowledge separate',t=>{
  const project=temp(t),run=args=>execFileSync('git',['-c','safe.directory='+project,...args],{cwd:project,encoding:'utf8'}).trim();
  run(['init','-b','main']);fs.writeFileSync(path.join(project,'client.cjs'),"const body={destination_type:'own_account',source_account:'90000000001',destination_account:'90000000002',amount:'600'};\n");
  run(['add','client.cjs']);run(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','fixture']);
  const head=run(['rev-parse','HEAD']);
  const report=review(project,{files:['client.cjs']});assert.equal(report.codeVersion.head,head);assert.equal(report.ruleVersion,loadActive(root).active.version);assert(!fs.existsSync(path.join(project,'knowledge')));
  const unchanged=review(project,{files:[],base:'HEAD'});assert.deepEqual(unchanged.codeVersion.files,[]);
  fs.appendFileSync(path.join(project,'client.cjs'),'// edited target project\n');
  const changed=review(project,{files:[],base:'HEAD'});assert.equal(changed.codeVersion.head,head);assert.deepEqual(changed.codeVersion.files.map(f=>f.file),['client.cjs']);
  const cli=path.join(root,'tools/exness-rules.cjs');
  const result=spawnSync(process.execPath,[cli,'review','--project-root',project,'--files','client.cjs','--out','.cache/exness-rules/migration-review.json'],{cwd:root,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).codeVersion.head,head);assert(fs.existsSync(path.join(project,'.cache/exness-rules/migration-review.json')));
  const implicit=spawnSync(process.execPath,[cli,'review','--files','client.cjs'],{cwd:project,encoding:'utf8'});assert.equal(implicit.status,0,implicit.stderr);assert.equal(JSON.parse(implicit.stdout).codeVersion.head,head);
});
test('published module keeps its approved bundle and case-specific fixture reproducible',()=>{
  const active=loadActive(root);assert.equal(active.active.bundleHash,'e3a79f510ff6364440e5e7d9832f48c9f5ee99ceee5f62e73905d1fe8c0b4e37');assert.equal(active.rules.length,29);assert.equal(active.manifest.sources.length,27);
  assert(core.readJSON(path.join(root,'archive/first-success-600-usc.sanitized.json')).referenceOnly);
});
