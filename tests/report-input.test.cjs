'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
const core=require('../packages/core/src/index.cjs'),cli=require('../packages/cli/src/main.cjs');
const {reviewFiles,reviewPolicy}=require('../packages/cli/src/review-files.cjs');
const {analyze}=require('../packages/cli/src/adapters/javascript.cjs');
const {createGit,gitEnvironment}=require('../packages/cli/src/git.cjs');
const vectors=require('./fixtures/report-protocol-v2.json');
const root=path.resolve(__dirname,'..');
const spec={
  openapi:'3.1.1',info:{title:'Sanitized string fixture',version:'1'},paths:{'/v1/transfers':{post:{}}},
  components:{schemas:{TransferRequest:{
    type:'object',additionalProperties:false,required:['destination_type','source_account','destination_account','amount'],
    properties:{destination_type:{type:'string'},source_account:{type:'string'},destination_account:{type:'string'},amount:{type:'string'}}
  }}}
};
const ids=['COMMON-SIGN-001','PAY-REQUEST-001','PAY-AMOUNT-002','PAY-ACCOUNT-ID-010','PAY-UUID-003','TRADE-HOST-001','TRADE-ACK-002','TRADE-PRECISION-005','OBS-TRANSFER-ID-002'];
const rules=ids.map(id=>({id,kind:id.startsWith('OBS-')?'observed':'documented',scope:id.startsWith('COMMON-')?'common':id.startsWith('TRADE-')?'trading':'payments',statement:'Sanitized checker contract fixture.',evidence:[{sourceId:'payments-spec',terms:['string']}],lifecycle:{status:'approved',revision:1,introducedIn:'fixture'}}));
function temp(t){
  const parent=fs.realpathSync(os.tmpdir()),dir=fs.mkdtempSync(path.join(parent,'ex-api-input-'));
  t.after(()=>{const real=fs.realpathSync(dir);if(path.dirname(real)!==parent||!path.basename(real).startsWith('ex-api-input-'))throw Error('Unsafe cleanup');fs.rmSync(real,{recursive:true,force:true});});return dir;
}
function setup(t){
  const dir=temp(t),project=path.join(dir,'project'),data=path.join(dir,'data');fs.mkdirSync(project);
  const raw=JSON.stringify(spec),sha256=core.hash(raw),sources=[{id:'payments-spec',kind:'openapi',scope:'payments',url:'https://www.exness-api.com/openapi/payments.public.yaml',snapshot:'sources/'+sha256+'.yaml',sha256,fetchedAt:'2026-11-03T00:00:00Z'}];
  const allRules=[...rules,{...rules[0],id:'INF-FIXTURE-001',kind:'inference'},{...rules[1],id:'PAY-RETIRED-099',lifecycle:{...rules[1].lifecycle,status:'deprecated'}}];
  const portable={schemaVersion:2,manifest:{schemaVersion:1,id:'report-fixture',sources,bundleHash:core.hash(core.legacyStringify({sources,rules:allRules}))},rules:allRules,blobs:{[sha256]:Buffer.from(raw).toString('base64')}};
  const ctx=cli.context({'project-root':project,'data-dir':data},{distributionRoot:root});ctx.store.importBundle(portable);
  return {dir,project,data,portable,run:options=>cli.review(project,{'data-dir':data,bundle:portable.manifest.id,...options},root)};
}
function write(f,file,text){fs.writeFileSync(path.join(f.project,file),text);}
function withReads(target,hook,run){
  const originals=Object.fromEntries(['openSync','closeSync','readSync','readFileSync'].map(name=>[name,fs[name]])),handles=new Set(),reads=[];let actual=0,opened=0;
  fs.openSync=function(file,...args){const fd=originals.openSync.call(fs,file,...args);if(file===target){handles.add(fd);opened++;}return fd;};
  fs.closeSync=function(fd){const value=originals.closeSync.call(fs,fd);handles.delete(fd);return value;};
  fs.readFileSync=function(file,...args){if(file===target)throw Error('UNBOUNDED_TARGET_READ');return originals.readFileSync.call(fs,file,...args);};
  fs.readSync=function(fd,buffer,offset,length,position){
    if(!handles.has(fd))return originals.readSync.call(fs,fd,buffer,offset,length,position);
    const entry={requested:length,before:actual};reads.push(entry);hook?.before?.(reads.length);
    const count=originals.readSync.call(fs,fd,buffer,offset,length,position);actual+=count;entry.count=count;hook?.after?.(count,reads.length);return count;
  };
  try{return {value:run(),reads,bytes:()=>actual,opened:()=>opened};}finally{Object.assign(fs,originals);}
}

test('report v1 schema bytes and v1 reader/SARIF remain compatible',()=>{
  // Git stores LF; Windows may check this existing text file out as CRLF.
  // Accept only the two exact historical byte sequences, not arbitrary reformatting.
  const schema=fs.readFileSync(path.join(root,'schemas/report.schema.json'));
  assert(['f7c27d164444f79cb3865730999d91bb1f43efd42279c63f2326b73e74b6651e','ef5db63594aedbaaff91ced201ba3c226fbb81c208ec2ae212a6775e608bae9a'].includes(core.hash(schema)),'Historical v1 schema bytes changed');
  assert.deepEqual(fs.readFileSync(path.join(root,'packages/core/schemas/report.schema.json')),schema,'Packaged v1 schema preserves checkout bytes');
  assert.equal(core.validate('report',vectors.reports.v1).schemaVersion,1);
  const sarif=core.toSarif(vectors.reports.v1);assert.equal(sarif.version,'2.1.0');assert.equal(sarif.runs[0].results[0].locations[0].physicalLocation.region.startLine,1);
  assert.doesNotThrow(()=>core.stringify(sarif));assert(!('schemaVersion' in sarif.runs[0].properties));
  const legacy=structuredClone(vectors.reports.v1);legacy.findings[0].column=0;
  assert(!('startColumn' in core.toSarif(legacy).runs[0].results[0].locations[0].physicalLocation.region),'V1 continues to ignore fields outside its historical location contract');
  legacy.findings[0].severity='P1';assert.equal(core.toSarif(legacy).runs[0].results[0].level,'error','Documented P1 remains an error in V1');
  legacy.findings[0].kind='observed';const stored=core.stringify(legacy);
  assert.equal(core.toSarif(legacy).runs[0].results[0].level,'warning','Observed P1 cannot become a blocking error when reading V1');
  assert.equal(core.stringify(legacy),stored,'SARIF policy correction does not rewrite the V1 report or its fingerprint');
});

test('language-neutral report v2 has verifiable complete hash, partial status and fingerprint',()=>{
  const report=core.validate('report',vectors.reports.v2);assert.equal(report.resultFingerprint,core.reportFingerprint(report));
  assert.equal(report.codeVersion.files[0].sha256,core.hash(vectors.file.content));
  const sarif=core.toSarif(report);assert.equal(sarif.runs[0].properties.schemaVersion,2);assert.equal(sarif.runs[0].properties.outcome,'PARTIAL_REVIEW_REQUIRES_HUMAN');
  assert.deepEqual(sarif.runs[0].properties.codeVersion,report.codeVersion);assert.deepEqual(sarif.runs[0].properties.manualChecks,report.manualChecks);assert.deepEqual(sarif.runs[0].results,[]);
  assert.equal(require('../schemas/report-v2.schema.json').$id,vectors.schemaUrns.v2);
});

for(const mutation of vectors.invalidV2)test('v2 rejects '+mutation.name,()=>{
  const report=structuredClone(vectors.reports.v2),keys=mutation.remove||mutation.set;let object=report;
  for(const key of keys.slice(0,-1))object=object[key];
  if(mutation.remove)delete object[keys.at(-1)];else object[keys.at(-1)]=mutation.value;
  if(report.schemaVersion===2)report.resultFingerprint=core.reportFingerprint(report);
  assert.throws(()=>core.validate('report',report),/schema|consistency/);
});

test('malformed finding evidence, locations and inference kinds are rejected by v2',t=>{
  const f=setup(t);write(f,'client.cjs','const amount=Number(input.amount);');
  const original=f.run({files:['client.cjs']});assert.equal(original.findings.length,1);
  for(const mutate of [r=>{delete r.findings[0].evidence;},r=>{r.findings[0].evidence=[{}];},r=>{r.findings[0].evidence[0].sha256='bad';},r=>{r.findings[0].evidence[0].snapshot='../outside';},r=>{r.findings[0].line=0;},r=>{r.findings[0].file='missing.cjs';},r=>{r.findings[0].kind='inference';},r=>{delete r.codeVersion.files[0].adapterStatus;},r=>{r.coverage.unanalyzedFiles=['client.cjs'];},r=>{r.coverage.checkApplicability=[];}]){
    const report=structuredClone(original);mutate(report);report.resultFingerprint=core.reportFingerprint(report);
    assert.throws(()=>core.validate('report',report),/schema|consistency/);
  }
  const sarif=core.toSarif(original);assert.equal(sarif.runs[0].results[0].level,'warning');assert(sarif.runs[0].results[0].properties.evidence[0].sha256);
});

test('coverage records checks without findings and preserves selected/excluded inventory',t=>{
  const f=setup(t);write(f,'client.cjs',"fetch('https://api.exness.com/v1/transfers',{method:'POST',body:JSON.stringify({destination_type:'own_account',source_account:'100',destination_account:'200',amount:'1'})});");
  const report=f.run({files:['client.cjs']});assert.equal(report.findings.length,0);
  assert.equal(report.codeVersion.files[0].analysisStatus,'analyzed');assert.equal(report.coverage.ruleCount,ids.length);
  assert(report.coverage.excludedRules.some(r=>r.kind==='inference'));assert(report.coverage.excludedRules.some(r=>r.status==='deprecated'));
  assert(report.coverage.checkApplicability.some(c=>c.checkId==='JS-TRANSFER-BODY'&&c.status==='ran'));
  assert(report.coverage.checkApplicability.some(c=>c.checkId==='JS-RETRY-ID'&&c.status==='manual-only'));
  assert(report.coverage.checkApplicability.some(c=>c.checkId==='JS-HOST'&&c.status==='not-applicable'));
  assert.equal(report.outcome,'PARTIAL_REVIEW_REQUIRES_HUMAN');
});

for(const invalid of [false,true])test(`schema-unavailable transfer checks are partial ${invalid?'with':'without'} findings`,()=>{
  const code=`fetch('https://api.exness.com/v1/transfers',{method:'POST',body:JSON.stringify({destination_type:'own_account',source_account:${invalid?'100':"'100'"},destination_account:'200',amount:${invalid?'0':"'1'"}})});`;
  const result=analyze(code,'fixture.cjs',rules,null);
  assert.equal(result.checkRuns.find(c=>c.checkId==='JS-TRANSFER-BODY').status,'partial');
  assert.equal(result.findings.length>0,invalid);assert(result.manual.some(m=>/schema is unavailable/.test(m.reason)));
});

test('known non-transfer requests do not make transfer body checks applicable',()=>{
  const result=analyze("fetch('https://api.exness.com/v1/accounts/example/balance',options);",'fixture.cjs',rules,null);
  assert.equal(result.checkRuns.find(check=>check.checkId==='JS-TRANSFER-BODY').status,'not-applicable');
  assert(result.checkRuns.some(check=>check.checkId==='JS-SIGNING'&&check.status==='manual-only'));
});

test('unsupported files hash in bounded chunks, never via whole-file target reads',t=>{
  const f=setup(t),text='x'.repeat(150000);write(f,'data.bin',text);
  const observed=withReads(path.join(f.project,'data.bin'),null,()=>f.run({files:['data.bin']})),file=observed.value.codeVersion.files[0];
  assert.equal(file.analysisStatus,'unsupported');assert.equal(file.adapterStatus,'not-run');assert.equal(file.sha256,core.hash(text));assert.equal(observed.bytes(),text.length);
  assert(observed.reads.length>=3);assert(observed.reads.every(read=>read.requested<=65536));
  assert(observed.value.coverage.checkApplicability.every(check=>check.status==='not-run'));
  assert(observed.value.manualChecks.some(m=>m.category==='unanalyzed'&&/not been analyzed/.test(m.reason)));
});

test('oversized JS and unsupported files skip reads and publish no fake/partial hash',t=>{
  const f=setup(t);for(const file of ['large.cjs','large.bin'])write(f,file,'x'.repeat(128));
  for(const file of ['large.cjs','large.bin']){
    const observed=withReads(path.join(f.project,file),null,()=>f.run({files:[file],'max-file-bytes':64})),entry=observed.value.codeVersion.files[0];
    assert.equal(entry.analysisStatus,'budget-exceeded');assert.equal(entry.sha256,null);assert.equal(entry.hashStatus,'not-computed');assert.equal(observed.bytes(),0);assert.equal(entry.adapterStatus,'not-run');
  }
});

test('aggregate budget is deterministic by sorted path and skips whole files that do not fit',t=>{
  const f=setup(t);write(f,'a.bin','123456');write(f,'b.bin','123456');write(f,'c.bin','12');
  const a=f.run({files:['c.bin','b.bin','a.bin'],'max-file-bytes':10,'max-total-bytes':8});
  const b=f.run({files:['a.bin','b.bin','c.bin'],'max-file-bytes':10,'max-total-bytes':8});
  assert.equal(a.resultFingerprint,b.resultFingerprint);assert.deepEqual(a.codeVersion.files.map(file=>[file.file,file.analysisStatus,file.bytesRead]),[['a.bin','unsupported',6],['b.bin','budget-exceeded',0],['c.bin','unsupported',2]]);
  assert.equal(a.codeVersion.files.reduce((sum,file)=>sum+file.budgetBytesCharged,0),8);
});

test('exact byte caps and empty files still produce complete hashes',t=>{
  const f=setup(t);write(f,'a.bin','12345678');write(f,'empty.cjs','');
  const report=f.run({files:['a.bin','empty.cjs'],'max-file-bytes':8,'max-total-bytes':8});
  assert.equal(report.codeVersion.files[0].sha256,core.hash('12345678'));assert.equal(report.codeVersion.files[1].sha256,core.hash(''));assert.equal(report.codeVersion.files[1].analysisStatus,'analyzed');
});

for(const beyondCap of [false,true])test(`growing file ${beyondCap?'past':'within'} cap is not analyzed or partially hashed`,t=>{
  const f=setup(t),file='growing.cjs',target=path.join(f.project,file);write(f,file,'const x=1;');let appended=false;
  const observed=withReads(target,{after:count=>{if(count>0&&!appended){appended=true;fs.appendFileSync(target,beyondCap?'x'.repeat(200):' // appended');}}},()=>f.run({files:[file],'max-file-bytes':64,'max-total-bytes':64}));
  const entry=observed.value.codeVersion.files[0];assert.equal(entry.analysisStatus,beyondCap?'budget-exceeded':'changed-during-read');assert.equal(entry.sha256,null);assert.equal(entry.adapterStatus,'not-run');
  assert(observed.bytes()<=64);assert(observed.reads.every(read=>read.before+read.requested<=64));assert.deepEqual(observed.value.findings,[]);
});

test('growth after EOF discards hash even if the new file would fit the cap',t=>{
  const f=setup(t),target=path.join(f.project,'grow.bin');write(f,'grow.bin','original');let appended=false;
  const observed=withReads(target,{after:count=>{if(count===0&&!appended){appended=true;fs.appendFileSync(target,'new');}}},()=>f.run({files:['grow.bin'],'max-file-bytes':64}));
  assert.equal(observed.value.codeVersion.files[0].analysisStatus,'changed-during-read');assert.equal(observed.value.codeVersion.files[0].sha256,null);
});

test('truncation while reading discards the complete-content identity claim',t=>{
  const f=setup(t),target=path.join(f.project,'shrink.bin');write(f,'shrink.bin','original data');let truncated=false;
  const observed=withReads(target,{after:count=>{if(count>0&&!truncated){truncated=true;fs.truncateSync(target,1);}}},()=>f.run({files:['shrink.bin']}));
  assert.equal(observed.value.codeVersion.files[0].analysisStatus,'changed-during-read');assert.equal(observed.value.codeVersion.files[0].sha256,null);
});

test('invalid UTF-8 and interrupted adapter analysis remain manual without partial findings',t=>{
  const f=setup(t);write(f,'invalid.cjs',Buffer.from([255]));
  const parsed=f.run({files:['invalid.cjs']});assert.equal(parsed.codeVersion.files[0].analysisStatus,'parse-failed');assert.equal(parsed.codeVersion.files[0].hashStatus,'complete');
  write(f,'interrupt.cjs',"fetch('https://api.exness.com/v1/trading/accounts/example');fetch('https://api.exness.com/v1/transfers',{method:'POST',body:JSON.stringify({amount:'1'})});");
  const [interrupted]=reviewFiles(f.project,['interrupt.cjs'],{rules},()=>{throw Error('Synthetic validator interruption');});
  assert.equal(interrupted.analysisStatus,'analysis-failed');assert.equal(interrupted.adapterStatus,'failed');assert.equal(interrupted.hashStatus,'complete');assert.deepEqual(interrupted.findings,[]);assert(interrupted.manual.length);
});

test('read failures reserve uncertain bytes and do not leak partial findings/hash',t=>{
  const f=setup(t),target=path.join(f.project,'a.bin');write(f,'a.bin','x'.repeat(80000));write(f,'b.bin','x');
  const observed=withReads(target,{before:call=>{if(call===2)throw Object.assign(Error('Injected read failure'),{code:'EIO'});}},()=>f.run({files:['a.bin','b.bin'],'max-file-bytes':131072,'max-total-bytes':131072}));
  const [a,b]=observed.value.codeVersion.files;assert.equal(a.analysisStatus,'read-failed');assert.equal(a.bytesRead,65536);assert.equal(a.budgetBytesCharged,131072);assert.equal(a.sha256,null);assert.equal(b.analysisStatus,'budget-exceeded');
});

test('parse failure, missing file and non-regular input remain explicitly unanalyzed',t=>{
  const f=setup(t);write(f,'bad.cjs','const = ;');fs.mkdirSync(path.join(f.project,'directory'));
  const report=f.run({files:['bad.cjs','missing.cjs','directory']});
  assert.deepEqual(report.codeVersion.files.map(file=>[file.file,file.analysisStatus]),[['bad.cjs','parse-failed'],['directory','not-regular'],['missing.cjs','missing']]);
  assert.equal(report.codeVersion.files[0].hashStatus,'complete');assert.equal(report.codeVersion.files[0].adapterStatus,'parse-failed');
  assert.deepEqual(report.coverage.parseFailedFiles,['bad.cjs']);assert.equal(report.coverage.unanalyzedFiles.length,3);assert(report.coverage.checkApplicability.every(check=>check.status==='not-run'));
});

test('fingerprint covers policy/conclusions but excludes freshness and timestamps',t=>{
  const f=setup(t);write(f,'client.cjs','const x=1;');const a=f.run({files:['client.cjs']}),b=f.run({files:['client.cjs'],'max-file-bytes':4096});
  assert.notEqual(a.resultFingerprint,b.resultFingerprint);
  const changed=structuredClone(a);changed.createdAt='2026-11-04T23:59:00Z';changed.sourceFreshness.latestCheck={checkedAt:'2026-11-04T23:59:00Z',status:'complete',summary:{}};
  assert.equal(core.reportFingerprint(changed),a.resultFingerprint);assert.doesNotThrow(()=>core.validate('report',changed));
  changed.codeVersion.files[0].sha256=core.hash('different bytes');assert.throws(()=>core.validate('report',changed),/fingerprint mismatch/);
});

test('budget CLI flags reject malformed/range values before starting review',()=>{
  for(const value of ['0','-1','1.5','1e3','NaN','9007199254740992','16777217'])assert.throws(()=>cli.parse(['review','--files','a.cjs','--max-file-bytes',value]),/integer/);
  for(const value of ['0','268435457','Infinity'])assert.throws(()=>cli.parse(['review','--files','a.cjs','--max-total-bytes',value]),/integer/);
  assert.throws(()=>cli.parse(['collect','--max-file-bytes','64']),/only to review/);assert.equal(reviewPolicy({'max-file-bytes':'64'}).maxFileBytes,64);
});

test('--base reports changed, untracked, deleted and private exclusions with no private reads',t=>{
  const f=setup(t),git=createGit(f.project),template=path.join(f.dir,'empty-template');fs.mkdirSync(template);
  git(['init','-b','main','--template='+template]);write(f,'client.cjs','const x=1;');write(f,'delete.cjs','const x=1;');write(f,'.gitignore','ignored.bin\n');
  git(['add','--','client.cjs','delete.cjs','.gitignore']);git(['-c','user.name=Offline Fixture','-c','user.email=offline@example.invalid','commit','-m','Sanitized boundary fixture']);
  write(f,'client.cjs','const x=2;');fs.unlinkSync(path.join(f.project,'delete.cjs'));write(f,'extra.ts','throw Error("MUST NOT EXECUTE")');write(f,'.env.fixture','SANITIZED_SENTINEL');write(f,'ignored.bin','ignored');
  const inspection=withReads(path.join(f.project,'.env.fixture'),null,()=>f.run({base:'HEAD'})),report=inspection.value;
  assert.equal(inspection.opened(),0);assert.equal(inspection.bytes(),0);assert.deepEqual(report.codeVersion.files.map(file=>file.file),['.env.fixture','client.cjs','delete.cjs','extra.ts']);
  assert.equal(report.codeVersion.files[0].analysisStatus,'excluded');assert.equal(report.codeVersion.files[0].bytesRead,0);assert.equal(report.codeVersion.files[2].analysisStatus,'missing');
  assert.equal(report.inputPolicy.untrackedIgnored,'exclude-in-base-only');assert(report.manualChecks.some(item=>item.file==='.env.fixture'&&item.category==='excluded'));
  assert.throws(()=>f.run({files:['.env.fixture']}),/Private/);
  assert.equal(f.run({files:['ignored.bin']}).codeVersion.files[0].analysisStatus,'unsupported');
});

test('CLI JSON/SARIF preserve partial budgets and only documented P1 blocks',t=>{
  const f=setup(t);write(f,'large.cjs','x'.repeat(128));
  const run=(file,format,args=[])=>spawnSync(process.execPath,[path.join(root,'tools/exness-rules.cjs'),'review','--project-root',f.project,'--data-dir',f.data,'--bundle',f.portable.manifest.id,'--files',file,'--format',format,...args],{env:gitEnvironment(),encoding:'utf8',timeout:30000,windowsHide:true});
  for(const format of ['json','sarif']){
    const result=run('large.cjs',format,['--max-file-bytes','64']);assert.equal(result.status,0,result.stderr);const output=JSON.parse(result.stdout),report=format==='json'?output:output.runs[0].properties;
    assert.equal(report.schemaVersion,2);assert.equal(report.codeVersion.files[0].analysisStatus,'budget-exceeded');assert.equal(report.outcome,'PARTIAL_REVIEW_REQUIRES_HUMAN');assert(report.manualChecks.length);
  }
  write(f,'bad.cjs',"fetch('https://api.exness.com/v1/trading/accounts/example');");assert.equal(run('bad.cjs','json').status,1);
  const blocked=run('bad.cjs','sarif');assert.equal(blocked.status,1);assert(JSON.parse(blocked.stdout).runs[0].results.some(result=>result.level==='error'&&result.properties.kind==='documented'));
  write(f,'observation.cjs','if(response.transfer_id!==record.transferId){}');const observed=run('observation.cjs','json');assert.equal(observed.status,0,observed.stderr);assert(JSON.parse(observed.stdout).findings.some(f=>f.kind==='observed'));
  const observation=JSON.parse(observed.stdout);observation.findings[0].severity='P1';observation.resultFingerprint=core.reportFingerprint(observation);
  assert.equal(core.toSarif(observation).runs[0].results[0].level,'warning','V2 observations cannot become blocking SARIF errors');
});
