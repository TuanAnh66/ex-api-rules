'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {spawnSync} = require('node:child_process');
const core = require('../packages/core/src/index.cjs');
const store = require('../packages/cli/src/store.cjs');
const cli = require('../packages/cli/src/main.cjs');
const root = path.resolve(__dirname, '..');
const spec = {openapi:'3.1.1', paths:{'/v1/transfers':{post:{}}}, components:{schemas:{TransferRequest:{type:'object',properties:{amount:{type:'string'}}}}}};
const rule = (id = 'PAY-AMOUNT-002') => ({id, kind:'documented', scope:'payments', statement:'Use decimal strings.', evidence:[{sourceId:'payments-spec',terms:['string']}], lifecycle:{status:'draft',revision:1,introducedIn:'fixture'}});
const write = (file,value) => {fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');};
function fixture(t) {
  const parent=fs.realpathSync(os.tmpdir()),dir=fs.mkdtempSync(path.join(parent,'ex-api-transactions-'));
  t.after(()=>{const real=fs.realpathSync(dir);if(path.dirname(real)!==parent||!path.basename(real).startsWith('ex-api-transactions-'))throw Error('Unsafe cleanup');fs.rmSync(real,{recursive:true,force:true});});
  const project=path.join(dir,'project'),data=path.join(dir,'data'),distribution=path.join(dir,'distribution');fs.mkdirSync(project);
  write(path.join(distribution,'catalog/sources.json'),{allowedHosts:['www.exness-api.com'],maxSources:1,sources:[{id:'payments-spec',url:'https://www.exness-api.com/openapi/payments.public.yaml',kind:'openapi',scope:'payments'}]});
  const ctx=cli.context({'project-root':project,'data-dir':data},{distributionRoot:distribution});
  return {dir,project,data,distribution,ctx,activeFile:path.join(data,'maintainer-active.json'),lock:path.join(data,'bundles/write.lock')};
}
async function collect(f,rules=[rule()],document=spec) {
  write(path.join(f.distribution,'catalog/rules.json'),rules);
  return store.collect(f.ctx,{fetcher:async()=>new Response(JSON.stringify(document))});
}
const approve=(f,candidate)=>store.approve(f.ctx,candidate.candidate,'Offline fixture reviewer');
async function baseline(t) {
  const f=fixture(t),candidate=await collect(f);f.first=approve(f,candidate);f.firstCandidate=candidate;
  store.pin(f.ctx,{bundle:f.first.version});f.pin=fs.readFileSync(path.join(f.project,'.ex-api-rules.lock.json'));
  return f;
}
const activeBytes=f=>fs.readFileSync(f.activeFile);
const assertPin=f=>assert(fs.readFileSync(path.join(f.project,'.ex-api-rules.lock.json')).equals(f.pin));
const nextRules=f=>f.ctx.store.readActive().bundle.rules.map(r=>({...r,statement:'Updated decimal string requirement.',lifecycle:{...r.lifecycle,status:'draft',revision:r.lifecycle.revision+1}}));
const approvalFiles=f=>fs.readdirSync(path.join(f.data,'approvals')).filter(name=>name.endsWith('.json')).sort();

// Faults wrap the real fs module used by production. All successful operations
// still run on real files in this test's external temp store. No mocked store.
function inject(target,phase,after,operation) {
  const originals=Object.fromEntries(['openSync','closeSync','writeFileSync','fsyncSync','renameSync'].map(name=>[name,fs[name]]));
  const handles=new Map();let fired=false,error;
  const matches=file=>{
    const normalized=file.split('.tmp-')[0],name=path.basename(normalized),parent=path.basename(path.dirname(normalized));
    return target==='index'?name==='index.json':target==='artifact'?parent==='bundles'&&/^[a-f0-9]{64}\.json$/.test(name):target==='approval'?parent==='approvals'&&/^a-/.test(name):target==='active'?name==='maintainer-active.json':target==='blob'?/^[a-f0-9]{64}$/.test(name):false;
  };
  const hit=(file,stage)=>{if(!fired&&phase===stage&&matches(file)){fired=true;throw Object.assign(Error(`Injected ${target} ${phase} ${after?'after':'before'}`),{code:'ENOSPC'});}};
  fs.openSync=function(file,...args){const fd=originals.openSync.call(fs,file,...args);handles.set(fd,String(file));return fd;};
  fs.closeSync=function(fd){const result=originals.closeSync.call(fs,fd);handles.delete(fd);return result;};
  fs.writeFileSync=function(file,...args){const name=typeof file==='number'?handles.get(file)||'':String(file);if(!after)hit(name,'write');const result=originals.writeFileSync.call(fs,file,...args);if(after)hit(name,'write');return result;};
  fs.fsyncSync=function(fd){const name=handles.get(fd)||'';if(!after)hit(name,'fsync');const result=originals.fsyncSync.call(fs,fd);if(after)hit(name,'fsync');return result;};
  fs.renameSync=function(from,to){if(!after)hit(String(to),'rename');const result=originals.renameSync.call(fs,from,to);if(after)hit(String(to),'rename');return result;};
  try{operation();}catch(e){error=e;}finally{for(const [name,method]of Object.entries(originals))fs[name]=method;}
  assert(fired,`Fault was not reached: ${target}/${phase}`);assert(error,'Expected injected failure');return error;
}

test('collect reports union diff and never approves a missing historical rule',async t=>{
  const f=fixture(t);const initial=await collect(f,[rule(),rule('PAY-REQUEST-001'),rule('PAY-UUID-003')]);approve(f,initial);
  const old=f.ctx.store.readActive(),before=activeBytes(f),rules=structuredClone(old.bundle.rules);
  rules[0].statement='Changed decimal string statement.';rules[0].lifecycle.revision++;
  rules.pop();rules.push(rule('PAY-ACCOUNT-ID-010'));
  const candidate=await collect(f,rules),changes=new Map(candidate.ruleChanges.map(change=>[change.id,change]));
  assert.equal(changes.get('PAY-AMOUNT-002').classification,'changed');
  assert.equal(changes.get('PAY-REQUEST-001').classification,'unchanged');
  assert.equal(changes.get('PAY-UUID-003').classification,'removed');assert.equal(changes.get('PAY-UUID-003').after,null);
  assert.equal(changes.get('PAY-ACCOUNT-ID-010').classification,'added');assert.equal(changes.get('PAY-ACCOUNT-ID-010').before,null);
  assert.equal(changes.get('PAY-AMOUNT-002').before.statement,'Use decimal strings.');
  assert(candidate.semanticSourceReviewRequired);assert(candidate.historyIssues.some(issue=>issue.ruleId==='PAY-UUID-003'));
  assert.throws(()=>approve(f,candidate),/history cannot disappear/);assert(activeBytes(f).equals(before));
});

test('retirement retains stable IDs, revisions, and a valid successor',async t=>{
  const f=await baseline(t),rules=nextRules(f);rules[0].lifecycle.status='superseded';rules[0].lifecycle.supersededBy='PAY-REQUEST-001';rules.push(rule('PAY-REQUEST-001'));
  const retired=approve(f,await collect(f,rules)),bundle=f.ctx.store.readActive().bundle;
  assert.equal(bundle.manifest.id,retired.version);assert.equal(bundle.rules.length,2);
  assert(!core.selectRules(bundle.rules).some(r=>r.id==='PAY-AMOUNT-002'));
  assertPin(f);
  for(const mutate of [r=>{r[0].lifecycle.supersededBy=r[0].id;},r=>{r[0].lifecycle.supersededBy='MISSING-RULE';},r=>{r[1].lifecycle={...r[1].lifecycle,status:'superseded',supersededBy:r[0].id};}]){
    const bad=structuredClone(bundle.rules);bad.forEach(r=>r.lifecycle.revision++);mutate(bad);
    const candidate=await collect(f,bad);assert.throws(()=>approve(f,candidate),/successor|cycle/);
  }
});

test('approval rejects stable-ID rebinding and changes without a revision',async t=>{
  const f=await baseline(t),before=activeBytes(f),original=f.ctx.store.readActive().bundle.rules;
  for(const mutate of [r=>{r[0].scope='trading';},r=>{r[0].kind='inference';},r=>{r[0].statement='Different string requirement.';},r=>{r[0].lifecycle.introducedIn='rebound';},r=>{r[0].lifecycle.revision=0;}]){
    const rules=structuredClone(original);mutate(rules);
    // Invalid catalog revisions fail collection itself; valid but unsafe history
    // is reported in the candidate and rejected at the approval boundary.
    let candidate;try{candidate=await collect(f,rules);}catch(e){assert.match(e.message,/schema validation/);continue;}
    assert.throws(()=>approve(f,candidate),/Stable rule ID|revision|introducedIn/);assert(activeBytes(f).equals(before));
  }
});

for(const target of ['blob','artifact','index','approval','active'])for(const phase of ['write','fsync','rename'])for(const after of [false,true])test(`approval recovers ${target}/${phase}/${after?'after':'before'} fault`,async t=>{
  const f=await baseline(t),previous=activeBytes(f),document=structuredClone(spec);document.info={title:'New source fixture',version:'2'};
  const candidate=await collect(f,nextRules(f),document);
  const error=inject(target,phase,after,()=>approve(f,candidate));
  const committed=target==='active'&&phase==='rename'&&after;
  assert.equal(f.ctx.store.readActive().approval.candidate,committed?candidate.candidate:f.firstCandidate.candidate);
  if(committed)assert.equal(error.code,'APPROVAL_COMMITTED');else assert(activeBytes(f).equals(previous));
  assert(!fs.existsSync(f.lock));assertPin(f);
  const result=approve(f,candidate),recordCount=approvalFiles(f).length;
  assert.equal(result.activation,committed?'already-committed':'committed');assert.equal(result.candidate,candidate.candidate);
  assert.equal(recordCount,2);
  const repeated=approve(f,candidate);assert.equal(repeated.approvedAt,result.approvedAt);assert.equal(repeated.activation,'already-committed');assert.equal(approvalFiles(f).length,recordCount);
  assertPin(f);
});

test('A -> B -> retry A keeps active B and does not create a new approval',async t=>{
  const f=await baseline(t),b=approve(f,await collect(f,nextRules(f))),before=activeBytes(f),records=approvalFiles(f);
  const repeated=approve(f,f.firstCandidate);
  assert.equal(repeated.version,f.first.version);assert.equal(repeated.activation,'already-committed');assert.equal(repeated.activeChanged,false);
  assert(activeBytes(f).equals(before));assert.equal(f.ctx.store.readActive().approval.version,b.version);assert.deepEqual(approvalFiles(f),records);assertPin(f);
});

test('a prepared orphan cannot activate after its baseline changed',async t=>{
  const f=await baseline(t),orphan=await collect(f,nextRules(f));inject('active','rename',false,()=>approve(f,orphan));
  const rules=nextRules(f);rules[0].statement='A different reviewed string requirement.';
  const b=approve(f,await collect(f,rules)),before=activeBytes(f);
  assert.throws(()=>approve(f,orphan),/baseline changed/);assert(activeBytes(f).equals(before));assert.equal(f.ctx.store.readActive().approval.version,b.version);assertPin(f);
});

test('candidate identity and existing reviewer cannot be rebound on retry',async t=>{
  const f=await baseline(t),before=activeBytes(f),dir=path.join(f.data,'candidates',f.firstCandidate.candidate);
  assert.throws(()=>store.approve(f.ctx,f.firstCandidate.candidate,'Another reviewer'),/immutable approval/);
  const rules=JSON.parse(fs.readFileSync(path.join(dir,'rules.json'))),manifest=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json')));
  rules[0].statement='Tampered but rehashed string requirement.';rules[0].lifecycle.revision++;
  manifest.bundleHash=core.hash(core.bundleStringify(manifest,{sources:manifest.sources,rules}));write(path.join(dir,'rules.json'),rules);write(path.join(dir,'manifest.json'),manifest);
  assert.throws(()=>approve(f,f.firstCandidate),/immutable approval/);assert(activeBytes(f).equals(before));assertPin(f);
});

test('import cannot activate and stale locks are never guessed away',async t=>{
  const f=await baseline(t),before=activeBytes(f),portable=f.ctx.store.readActive().bundle.portable;
  assert.throws(()=>f.ctx.store.importBundle(portable,{activate:true}),/import cannot activate/);
  fs.writeFileSync(f.lock,'Synthetic stale lock requiring inspection.');
  assert.throws(()=>approve(f,f.firstCandidate),{code:'EEXIST'});assert.throws(()=>f.ctx.store.importBundle(portable),{code:'EEXIST'});
  assert.equal(fs.readFileSync(f.lock,'utf8'),'Synthetic stale lock requiring inspection.');assert(activeBytes(f).equals(before));assertPin(f);
});

test('reentrant and competing process writers cannot enter an approval transaction',async t=>{
  const f=await baseline(t),candidate=await collect(f,nextRules(f)),original=fs.writeFileSync;let checked=false;
  const portable=f.ctx.store.readActive().bundle.portable,file=path.join(f.dir,'import.json');write(file,portable);
  // Reenter while writing the immutable approval record, after import/index.
  const open=fs.openSync,close=fs.closeSync,handles=new Map();
  fs.openSync=function(file,...args){const fd=open.call(fs,file,...args);handles.set(fd,String(file));return fd;};
  fs.closeSync=function(fd){const result=close.call(fs,fd);handles.delete(fd);return result;};
  fs.writeFileSync=function(fd,...args){
    if(!checked&&typeof fd==='number'&&(handles.get(fd)||'').includes(path.sep+'approvals'+path.sep)){
      checked=true;assert(fs.existsSync(f.lock));assert.throws(()=>approve(f,candidate),{code:'EEXIST'});
      const script="const fs=require('node:fs');const store=require(process.argv[1]).createStore(process.argv[2]);try{store.importBundle(JSON.parse(fs.readFileSync(process.argv[3])));process.exit(3)}catch(e){if(e.code!=='EEXIST')throw e;}";
      const child=spawnSync(process.execPath,['-e',script,path.join(root,'packages/cli/src/store.cjs'),f.data,file],{encoding:'utf8',timeout:10000,windowsHide:true});
      assert.equal(child.status,0,child.stderr);assert(fs.existsSync(f.lock));
    }
    return original.call(fs,fd,...args);
  };
  try{approve(f,candidate);}finally{fs.writeFileSync=original;fs.openSync=open;fs.closeSync=close;}
  assert(checked);assert(!fs.existsSync(f.lock));assert.equal(f.ctx.store.readActive().approval.candidate,candidate.candidate);assertPin(f);
});

test('lock-release failure after commit is explicit and requires manual stale-lock inspection',async t=>{
  const f=await baseline(t),candidate=await collect(f,nextRules(f)),unlink=fs.unlinkSync;let error;
  fs.unlinkSync=function(file){if(file===f.lock)throw Object.assign(Error('Injected lock release failure'),{code:'EACCES'});return unlink.call(fs,file);};
  try{approve(f,candidate);}catch(e){error=e;}finally{fs.unlinkSync=unlink;}
  assert.equal(error?.code,'APPROVAL_COMMITTED');assert(fs.existsSync(f.lock));
  assert.equal(f.ctx.store.readActive().approval.candidate,candidate.candidate);
  assert.throws(()=>approve(f,candidate),{code:'EEXIST'});
  // Simulate an operator's explicit inspection/clear in this synthetic store.
  unlink(f.lock);const repeated=approve(f,candidate);assert.equal(repeated.activation,'already-committed');assertPin(f);
});

test('deprecated history remains present and cannot be dropped in a later approval',async t=>{
  const f=await baseline(t),rules=nextRules(f);rules[0].lifecycle.status='deprecated';
  approve(f,await collect(f,rules));
  assert.equal(f.ctx.store.readActive().bundle.rules[0].lifecycle.status,'deprecated');
  const candidate=await collect(f,[rule('PAY-REQUEST-001')]);assert.throws(()=>approve(f,candidate),/history cannot disappear/);assertPin(f);
});

for(const target of ['approval','approval-rehashed','artifact','blob','registry'])test(`corrupt ${target} fails closed without replacing active`,async t=>{
  const f=await baseline(t),active=f.ctx.store.readActive(),before=activeBytes(f),candidate=await collect(f,nextRules(f));
  if(target.startsWith('approval')){
    const file=path.join(f.data,'approvals',active.pointer.approvalId+'.json'),envelope=JSON.parse(fs.readFileSync(file));
    envelope.approval.reviewedBy='Tampered reviewer';
    if(target==='approval-rehashed')envelope.sha256=core.hash(core.stringify(envelope.approval));
    write(file,envelope);
  }else if(target==='artifact'){
    const file=path.join(f.data,'bundles',active.pointer.artifactSha256+'.json'),record=JSON.parse(fs.readFileSync(file));record.rules[0].statement='Tampered statement';write(file,record);
  }else if(target==='blob')fs.appendFileSync(f.ctx.store.blobPath(active.bundle.manifest.sources[0].sha256),'tamper');
  else write(path.join(f.data,'bundles/index.json'),[]);
  assert.throws(()=>f.ctx.store.readActive(),/checksum|digest|registry|match/);
  assert.throws(()=>approve(f,candidate),/checksum|digest|registry|match/);
  assert(activeBytes(f).equals(before));assert(!fs.existsSync(f.lock));assertPin(f);
});

test('corrupted orphan approval and immutable artifact are not repaired on retry',async t=>{
  for(const target of ['approval','artifact']){
    const f=await baseline(t),before=activeBytes(f),candidate=await collect(f,nextRules(f));inject('active','rename',false,()=>approve(f,candidate));
    const id='a-'+core.hash(candidate.candidate),file=path.join(f.data,'approvals',id+'.json'),envelope=JSON.parse(fs.readFileSync(file));
    if(target==='approval'){envelope.approval.reviewedBy='Tamper';write(file,envelope);}
    else{
      const artifact=path.join(f.data,'bundles',envelope.approval.artifactSha256+'.json'),record=JSON.parse(fs.readFileSync(artifact));record.rules[0].statement='Tamper';write(artifact,record);
    }
    assert.throws(()=>approve(f,candidate),/checksum|digest/);assert(activeBytes(f).equals(before));assert.equal(f.ctx.store.readActive().approval.candidate,f.firstCandidate.candidate);assertPin(f);
  }
});

test('import refuses an existing corrupted immutable artifact instead of overwriting it',async t=>{
  const f=await baseline(t),bundle=f.ctx.store.readActive().bundle,file=path.join(f.data,'bundles',bundle.artifactSha256+'.json'),record=JSON.parse(fs.readFileSync(file));
  record.blobDigests.push(record.blobDigests[0]);write(file,record);const bytes=fs.readFileSync(file);
  assert.throws(()=>f.ctx.store.importBundle(bundle.portable),/immutable artifact is corrupted/);assert(fs.readFileSync(file).equals(bytes));
});

test('active pointers validate approval IDs and hashes before any referenced file read',async t=>{
  const f=await baseline(t),original=JSON.parse(activeBytes(f));
  for(const mutate of [p=>{p.approvalId='../outside';},p=>{p.approvalSha256='../outside';},p=>{p.artifactSha256='../outside';},p=>{delete p.approvalId;},p=>{p.id='../outside';}]){
    const pointer=structuredClone(original);mutate(pointer);write(f.activeFile,pointer);
    const read=fs.readFileSync,seen=[];fs.readFileSync=function(file,...args){seen.push(String(file));return read.call(fs,file,...args);};
    try{assert.throws(()=>f.ctx.store.readActive(),/Invalid maintainer-active/);}finally{fs.readFileSync=read;}
    assert(!seen.some(file=>file.includes('outside')));assert.equal(seen.length,1);
  }
});

test('an imported preserved release remains the initial history baseline without checkout snapshots',async t=>{
  const f=fixture(t),active=require('../knowledge/exness/active.json');
  const portable=store.portableFromDirectory(path.join(root,'knowledge/exness/versions',active.version));
  f.ctx.store.importBundle(portable);
  const candidate=await collect(f);
  assert.equal(candidate.baseline,portable.manifest.id);assert.equal(candidate.ruleChanges.filter(c=>c.classification==='removed').length,28);
  assert.throws(()=>approve(f,candidate),/history cannot disappear/);assert.equal(f.ctx.store.readActive(),null);
});

test('failure verifying the new pointer reports committed or unknown instead of implying rollback',async t=>{
  for(const persistent of [false,true]){
    const f=await baseline(t),candidate=await collect(f,nextRules(f)),rename=fs.renameSync,read=fs.readFileSync;let published=false,hits=0,error;
    fs.renameSync=function(from,to){const result=rename.call(fs,from,to);if(to===f.activeFile)published=true;return result;};
    fs.readFileSync=function(file,...args){if(file===f.activeFile&&published&&(persistent||hits===0)){hits++;throw Object.assign(Error('Injected pointer readback failure'),{code:'EIO'});}return read.call(fs,file,...args);};
    try{approve(f,candidate);}catch(e){error=e;}finally{fs.renameSync=rename;fs.readFileSync=read;}
    assert.equal(error?.code,persistent?'APPROVAL_STATE_UNKNOWN':'APPROVAL_COMMITTED');
    assert.equal(f.ctx.store.readActive().approval.candidate,candidate.candidate);assert.equal(approve(f,candidate).activation,'already-committed');assertPin(f);
  }
});

test('abrupt process exit leaves a real lock and a retryable orphan before active rename',async t=>{
  const f=await baseline(t),candidate=await collect(f,nextRules(f)),previous=activeBytes(f);
  const script="const fs=require('node:fs');const store=require(process.argv[1]);const ctx={store:store.createStore(process.argv[2]),distributionRoot:process.argv[3],projectRoot:process.argv[4]};const rename=fs.renameSync;fs.renameSync=function(from,to){if(to===process.argv[6])process.exit(73);return rename.call(fs,from,to);};store.approve(ctx,process.argv[5],'Offline fixture reviewer');process.exit(74);";
  const child=spawnSync(process.execPath,['-e',script,path.join(root,'packages/cli/src/store.cjs'),f.data,f.distribution,f.project,candidate.candidate,f.activeFile],{encoding:'utf8',timeout:15000,windowsHide:true});
  assert.equal(child.status,73,child.stderr);assert(fs.existsSync(f.lock));assert(activeBytes(f).equals(previous));
  assert.equal(f.ctx.store.readActive().approval.candidate,f.firstCandidate.candidate);
  const id='a-'+core.hash(candidate.candidate),file=path.join(f.data,'approvals',id+'.json'),envelope=JSON.parse(fs.readFileSync(file));
  // Explicit operator inspection in the synthetic fixture before clearing lock.
  assert.equal(core.hash(core.stringify(envelope.approval)),envelope.sha256);
  assert.equal(f.ctx.store.load(envelope.approval.version,envelope.approval.artifactSha256).manifest.bundleHash,envelope.approval.bundleHash);
  assert.deepEqual(envelope.approval.previousActive,JSON.parse(previous));
  assert.throws(()=>approve(f,candidate),{code:'EEXIST'});assertPin(f);
  fs.unlinkSync(f.lock);
  const result=approve(f,candidate);
  assert.equal(result.activation,'committed');assert.equal(result.approvedAt,envelope.approval.approvedAt);assert.equal(result.approvalSha256,envelope.sha256);
  assert.equal(approvalFiles(f).length,2);assert(!fs.existsSync(f.lock));assertPin(f);
});
