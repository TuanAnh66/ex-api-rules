'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const core=require('ex-api-rules-core');
const legacy=require('./legacy-core.cjs');
const {fetchSources,compareSources}=require('./collector.cjs');
const writes=require('./write-path.cjs');
const LEGACY_HASH='e3a79f510ff6364440e5e7d9832f48c9f5ee99ceee5f62e73905d1fe8c0b4e37';
const idNow=()=>new Date().toISOString().replace(/[:.]/g,'-')+'-'+crypto.randomUUID().slice(0,8);
function defaultDataDir(){return process.env.EX_API_RULES_DATA_DIR||(process.platform==='win32'?path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData/Local'),'ex-api-rules'):path.join(process.env.XDG_STATE_HOME||path.join(os.homedir(),'.local/state'),'ex-api-rules'));}
const within=writes.within;
function syncDirectory(directory){
  // Windows does not expose portable directory fsync through Node. File fsync
  // and rename ordering still apply; this is not a power-loss guarantee.
  if(process.platform==='win32')return;
  const fd=fs.openSync(writes.assertRuntimePath(directory),'r');
  try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
function syncAncestors(directory){
  if(process.platform==='win32')return;
  for(let cursor=directory;;cursor=path.dirname(cursor)){
    syncDirectory(cursor);if(path.dirname(cursor)===cursor)break;
  }
}
function durableDirectory(directory){
  directory=writes.assertRuntimePath(directory);writes.mkdir(directory);
  // Also resync existing ancestors: a prior failed directory fsync may have
  // left a newly created ancestor visible but not durably linked.
  syncAncestors(directory);
}
function atomicBytes(file,bytes){
  file=writes.assertRuntimePath(file);durableDirectory(path.dirname(file));
  const temporary=file+'.tmp-'+crypto.randomUUID();let fd;
  try{
    fd=fs.openSync(writes.assertRuntimePath(temporary),'wx',0o600);
    fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    fs.renameSync(writes.assertRuntimePath(temporary),writes.assertRuntimePath(file));
    syncAncestors(path.dirname(file));
  }finally{
    if(fd!==undefined)fs.closeSync(fd);
    if(fs.existsSync(temporary))fs.unlinkSync(writes.assertRuntimePath(temporary));
  }
}
function atomic(file,value){atomicBytes(file,JSON.stringify(value,null,2)+'\n');}
function assertUsable(bundle){
  const issues=core.ruleHistoryIssues([],bundle.rules);if(issues.length)throw Error('Invalid rule history: '+issues.map(issue=>issue.ruleId+': '+issue.reason).join('; '));
  for(const rule of bundle.rules){
    if(!rule.lifecycle){if(bundle.manifest.bundleHash!==LEGACY_HASH)throw Error('Non-legacy rule is missing lifecycle metadata');}
    else if(['draft','in_review'].includes(rule.lifecycle.status))throw Error('Draft bundle cannot be pinned or used for review');
  }
}
function portableFromDirectory(dir){
  const {manifest,rules}=legacy.verifyBundle(dir),blobs={};
  for(const source of manifest.sources)blobs[source.sha256]=fs.readFileSync(legacy.safePath(dir,source.snapshot)).toString('base64');
  for(const rule of rules)for(const evidence of rule.evidence)if(evidence.snapshot&&!evidence.sourceId)blobs[evidence.sha256]=fs.readFileSync(legacy.safePath(dir,evidence.snapshot)).toString('base64');
  const portable={schemaVersion:2,manifest,rules,blobs};core.verifyPortable(portable);return portable;
}
function createStore(directory){
  const root=writes.assertRuntimePath(directory),registryFile=path.join(root,'bundles/index.json');
  function readRegistry(){
    let value;try{value=legacy.readJSON(registryFile);}catch(e){if(e.code!=='ENOENT')throw e;return Object.create(null);}
    if(!value||Array.isArray(value)||typeof value!=='object'||Object.entries(value).some(([id,digest])=>!/^[A-Za-z0-9-]+$/.test(id)||!/^[0-9a-f]{64}$/.test(digest)))throw Error('Corrupted bundle registry');
    return Object.assign(Object.create(null),value);
  }
  function blobPath(digest){if(!/^[0-9a-f]{64}$/.test(digest))throw Error('Invalid blob digest');return path.join(root,'blobs',digest.slice(0,2),digest);}
  function artifactPath(digest){if(!/^[0-9a-f]{64}$/.test(digest))throw Error('Invalid artifact digest');return path.join(root,'bundles',digest+'.json');}
  function resyncFile(file){
    const fd=fs.openSync(writes.assertRuntimePath(file),'r+');
    try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    syncAncestors(path.dirname(file));
  }
  function withWriteLock(operation){
    durableDirectory(path.join(root,'bundles'));
    const lock=writes.assertRuntimePath(path.join(root,'bundles/write.lock')),fd=fs.openSync(lock,'wx',0o600);
    try{
      fs.writeFileSync(fd,JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()})+'\n');fs.fsyncSync(fd);syncAncestors(path.dirname(lock));
      return operation();
    }finally{fs.closeSync(fd);fs.unlinkSync(writes.assertRuntimePath(lock));syncAncestors(path.dirname(lock));}
  }
  function importLocked(portable){
    const verified=core.verifyPortable(portable);assertUsable(verified);
    const registry=readRegistry(),previous=registry[verified.manifest.id];
    if(previous&&previous!==verified.artifactSha256)throw Error('Bundle ID is immutable; use a new ID');
    for(const digest of verified.blobDigests){
      const target=writes.assertRuntimePath(blobPath(digest));
      if(fs.existsSync(target)){if(core.hash(fs.readFileSync(target))!==digest)throw Error('Existing blob is corrupted');resyncFile(target);}
      else atomicBytes(target,core.decodeBlob(portable.blobs[digest]));
    }
    const target=artifactPath(verified.artifactSha256),record={schemaVersion:2,manifest:portable.manifest,rules:portable.rules,blobDigests:verified.blobDigests};
    if(fs.existsSync(target)){
      if(core.stringify(legacy.readJSON(target))!==core.stringify(record))throw Error('Existing immutable artifact is corrupted');resyncFile(target);
    }else atomic(target,record);
    registry[verified.manifest.id]=verified.artifactSha256;atomic(registryFile,registry);
    return verified;
  }
  function importBundle(portable,{activate=false}={}){
    if(activate)throw Error('Activation requires an approval transaction; import cannot activate');
    return withWriteLock(()=>importLocked(portable));
  }
  function load(id,expectedArtifact){
    const registry=readRegistry(),digest=expectedArtifact||registry[id];if(!digest)throw Error('Bundle not installed; run bundle import, then pin');
    if(expectedArtifact&&registry[id]&&registry[id]!==expectedArtifact)throw Error('Bundle ID is immutable; registry does not match selected artifact');
    const record=legacy.readJSON(writes.assertRuntimePath(artifactPath(digest))),blobs=Object.fromEntries(record.blobDigests.map(h=>[h,fs.readFileSync(writes.assertRuntimePath(blobPath(h))).toString('base64')]));
    const portable={schemaVersion:2,manifest:record.manifest,rules:record.rules,blobs},verified=core.verifyPortable(portable);
    if(record.schemaVersion!==2||JSON.stringify(record.blobDigests)!==JSON.stringify(verified.blobDigests)||verified.artifactSha256!==digest||verified.manifest.id!==id)throw Error('Stored artifact does not match selected bundle');assertUsable(verified);return {...verified,portable};
  }
  const activeFile=path.join(root,'maintainer-active.json');
  const digest=value=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);
  const identifier=value=>typeof value==='string'&&/^[A-Za-z0-9-]+$/.test(value);
  const keysAre=(value,names)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===names.slice().sort().join(',');
  function validPointer(value){
    return keysAre(value,['schemaVersion','id','artifactSha256','approvalId','approvalSha256'])&&value.schemaVersion===1&&identifier(value.id)&&digest(value.artifactSha256)&&digest(value.approvalSha256)&&typeof value.approvalId==='string'&&/^a-[0-9a-f]{64}$/.test(value.approvalId);
  }
  function validReference(value){return keysAre(value,['id','artifactSha256','bundleHash'])&&identifier(value.id)&&digest(value.artifactSha256)&&digest(value.bundleHash);}
  const reference=bundle=>bundle?{id:bundle.manifest.id,artifactSha256:bundle.artifactSha256,bundleHash:bundle.manifest.bundleHash}:null;
  function approvalPath(id){
    if(typeof id!=='string'||!/^a-[0-9a-f]{64}$/.test(id))throw Error('Invalid approval record ID');
    return writes.assertRuntimePath(path.join(root,'approvals',id+'.json'));
  }
  function readApproval(id,expectedHash){
    const envelope=legacy.readJSON(approvalPath(id));
    if(!keysAre(envelope,['schemaVersion','approval','sha256'])||envelope.schemaVersion!==1||!digest(envelope.sha256)||core.hash(core.stringify(envelope.approval))!==envelope.sha256||(expectedHash&&envelope.sha256!==expectedHash))throw Error('Approval record checksum mismatch');
    const record=envelope.approval;
    if(!keysAre(record,['schemaVersion','id','candidate','candidateArtifactSha256','version','bundleHash','artifactSha256','approvedAt','reviewedBy','previousActive','baseline'])||record.schemaVersion!==1||record.id!==id||!identifier(record.candidate)||record.id!=='a-'+core.hash(record.candidate)||!digest(record.candidateArtifactSha256)||!digest(record.bundleHash)||!digest(record.artifactSha256)||record.version!=='v-'+record.candidate+'-'+record.bundleHash.slice(0,12)||typeof record.reviewedBy!=='string'||!record.reviewedBy.trim()||typeof record.approvedAt!=='string'||!Number.isFinite(Date.parse(record.approvedAt))||(record.previousActive!==null&&!validPointer(record.previousActive))||(record.baseline!==null&&!validReference(record.baseline)))throw Error('Invalid approval record');
    const bundle=load(record.version,record.artifactSha256);
    if(bundle.manifest.bundleHash!==record.bundleHash)throw Error('Approval does not match bundle hash');
    const baseline=record.baseline?load(record.baseline.id,record.baseline.artifactSha256):null;
    if(baseline&&baseline.manifest.bundleHash!==record.baseline.bundleHash)throw Error('Approval baseline hash mismatch');
    if(record.previousActive&&(!record.baseline||record.previousActive.id!==record.baseline.id||record.previousActive.artifactSha256!==record.baseline.artifactSha256))throw Error('Approval previous pointer does not match baseline');
    if(!record.previousActive&&record.baseline&&record.baseline.bundleHash!==LEGACY_HASH)throw Error('Non-legacy approval baseline requires a previous approval pointer');
    const issues=core.ruleHistoryIssues(baseline?.rules||[],bundle.rules);
    if(issues.length)throw Error('Invalid approved rule history: '+issues.map(issue=>issue.ruleId+': '+issue.reason).join('; '));
    return {record,sha256:envelope.sha256,bundle};
  }
  function readActive(){
    let pointer;try{pointer=legacy.readJSON(writes.assertRuntimePath(activeFile));}catch(e){if(e.code==='ENOENT')return null;throw e;}
    if(!validPointer(pointer))throw Error('Invalid maintainer-active pointer; an approval ID/hash is required. Legacy pointers need explicit maintainer inspection, not automatic migration.');
    const chain=[],seen=new Set();let cursor=pointer;
    while(cursor!==null){
      if(!validPointer(cursor))throw Error('Invalid maintainer-active pointer; an approval ID/hash is required. Legacy pointers need explicit maintainer inspection, not automatic migration.');
      if(seen.has(cursor.approvalId))throw Error('Approval history contains a cycle');seen.add(cursor.approvalId);
      const entry=readApproval(cursor.approvalId,cursor.approvalSha256);
      if(entry.record.version!==cursor.id||entry.record.artifactSha256!==cursor.artifactSha256)throw Error('Active pointer does not match approval');
      chain.push({pointer:cursor,...entry});cursor=entry.record.previousActive;
    }
    return {pointer,bundle:chain[0].bundle,approval:chain[0].record,chain};
  }
  function legacyBaseline(distributionRoot){
    const file=path.join(distributionRoot,'knowledge/exness/active.json');
    if(!fs.existsSync(file)){
      // Package installations have no local snapshots. An explicitly imported
      // preserved release still supplies the known historical baseline.
      const id='2026-11-03T16-00-20-366Z-47729188',artifact=readRegistry()[id];
      if(!artifact)return null;
      const bundle=load(id,artifact);
      if(bundle.manifest.bundleHash!==LEGACY_HASH)throw Error('Imported legacy baseline does not match the preserved approved bundle');
      return bundle;
    }
    const active=legacy.readJSON(file),portable=portableFromDirectory(legacy.safePath(path.join(distributionRoot,'knowledge/exness/versions'),active.version));
    const verified=core.verifyPortable(portable);
    if(verified.manifest.bundleHash!==LEGACY_HASH||active.bundleHash!==LEGACY_HASH)throw Error('Legacy approval baseline is not the preserved approved bundle');
    return {...verified,portable};
  }
  function approveCandidate(id,reviewedBy,distributionRoot){
    if(!identifier(id))throw Error('Invalid candidate ID');
    if(typeof reviewedBy!=='string'||!reviewedBy.trim())throw Error('Approval requires --reviewed-by');
    let targetId,commitAttempted=false,knownCommitted=false;
    try{return withWriteLock(()=>{
      const portable=portableFromDirectory(path.join(root,'candidates',id));
      if(portable.manifest.id!==id)throw Error('Candidate directory ID does not match manifest ID');
      const candidateArtifactSha256=core.verifyPortable(portable).artifactSha256;
      const rules=portable.rules.map(rule=>({...rule,lifecycle:{...rule.lifecycle,status:['draft','in_review'].includes(rule.lifecycle.status)?'approved':rule.lifecycle.status}}));
      const manifest={...portable.manifest,bundleHash:core.hash(core.bundleStringify(portable.manifest,{sources:portable.manifest.sources,rules}))};
      manifest.id='v-'+id+'-'+manifest.bundleHash.slice(0,12);
      const final={schemaVersion:2,manifest,rules,blobs:portable.blobs},verified=core.verifyPortable(final);assertUsable(verified);
      targetId='a-'+core.hash(id);
      const current=readActive(),file=approvalPath(targetId);
      let approval,sha256;
      if(fs.existsSync(file)){
        const existing=readApproval(targetId);approval=existing.record;sha256=existing.sha256;
        if(approval.candidate!==id||approval.candidateArtifactSha256!==candidateArtifactSha256||approval.reviewedBy!==reviewedBy||approval.version!==manifest.id||approval.bundleHash!==manifest.bundleHash)throw Error('Existing immutable approval does not match candidate/reviewer; it cannot be rewritten');
        // A committed ancestor is a retry, never a request to roll active back.
        if(current?.chain.some(entry=>entry.record.id===targetId)){
          knownCommitted=true;resyncFile(file);resyncFile(activeFile);
          return {...approval,approvalSha256:sha256,activation:'already-committed',activeChanged:false};
        }
      }
      const baseline=current?.bundle||legacyBaseline(distributionRoot),previousActive=current?.pointer||null;
      if(approval&&(core.stringify(approval.previousActive)!==core.stringify(previousActive)||core.stringify(approval.baseline)!==core.stringify(reference(baseline))))throw Error('Prepared approval baseline changed; review a new candidate rather than activating a stale orphan');
      const issues=core.ruleHistoryIssues(baseline?.rules||[],rules);
      if(issues.length)throw Error('Rule history prevents approval: '+issues.map(issue=>issue.ruleId+': '+issue.reason).join('; '));
      if(baseline&&!current)importLocked(baseline.portable);
      importLocked(final);
      if(!approval){
        approval={schemaVersion:1,id:targetId,candidate:id,candidateArtifactSha256,version:manifest.id,bundleHash:manifest.bundleHash,artifactSha256:verified.artifactSha256,approvedAt:new Date().toISOString(),reviewedBy,previousActive,baseline:reference(baseline)};
        sha256=core.hash(core.stringify(approval));
        atomic(file,{schemaVersion:1,approval,sha256});
      }
      // Read back checksums and bundle/history before publishing the pointer.
      readApproval(targetId,sha256);
      resyncFile(file);
      const pointer={schemaVersion:1,id:manifest.id,artifactSha256:verified.artifactSha256,approvalId:targetId,approvalSha256:sha256};
      commitAttempted=true;atomic(activeFile,pointer);knownCommitted=true;
      readActive();
      return {...approval,approvalSha256:sha256,activation:'committed',activeChanged:true};
    });}catch(error){
      if(commitAttempted||knownCommitted){
        let committed;
        try{committed=!!readActive()?.chain.some(entry=>entry.record.id===targetId);}catch{
          const failure=Error('Approval state is unknown after pointer publication attempt; inspect the store before retrying: '+error.message,{cause:error});failure.code='APPROVAL_STATE_UNKNOWN';throw failure;
        }
        const failure=Error((committed?'Approval committed; finalization failed. Retry the same candidate without reactivating history: ':'Approval not committed; previous active remains selected. Retry the same candidate after resolving the write error: ')+error.message,{cause:error});
        failure.code=committed?'APPROVAL_COMMITTED':'APPROVAL_NOT_COMMITTED';failure.approvalId=targetId;throw failure;
      }
      throw error;
    }
  }
  function materialize(bundle){
    const dir=path.join(root,'cache/views',bundle.artifactSha256);writes.mkdir(dir);
    for(const source of bundle.manifest.sources){const target=writes.assertRuntimePath(legacy.safePath(dir,source.snapshot));writes.mkdir(path.dirname(target));if(!fs.existsSync(target))writes.copyFile(blobPath(source.sha256),target);}
    for(const rule of bundle.rules)for(const e of rule.evidence)if(e.snapshot&&!e.sourceId){const target=writes.assertRuntimePath(legacy.safePath(dir,e.snapshot));writes.mkdir(path.dirname(target));if(!fs.existsSync(target))writes.copyFile(blobPath(e.sha256),target);}
    // Cache is disposable and is verified again before use.
    atomic(path.join(dir,'manifest.json'),bundle.manifest);atomic(path.join(dir,'rules.json'),bundle.rules);legacy.verifyBundle(dir);return dir;
  }
  return {root,importBundle,load,materialize,readRegistry,blobPath,readActive,legacyBaseline,approveCandidate};
}
function resources(distributionRoot){
  if(fs.existsSync(path.join(distributionRoot,'catalog/sources.json')))return {catalog:path.join(distributionRoot,'catalog'),archive:path.join(distributionRoot,'archive')};
  const packaged=path.join(__dirname,'../resources');return {catalog:path.join(packaged,'catalog'),archive:path.join(packaged,'archive')};
}
function bootstrapLegacy(store,distributionRoot){
  const activeFile=path.join(distributionRoot,'knowledge/exness/active.json');
  if(!fs.existsSync(activeFile))throw Error('No project lock/bundle; import a release bundle and run pin --bundle ID');
  const active=legacy.readJSON(activeFile),dir=legacy.safePath(path.join(distributionRoot,'knowledge/exness/versions'),active.version);
  const portable=portableFromDirectory(dir);store.importBundle(portable);return store.load(portable.manifest.id);
}
function selectBundle(context,options={}){
  const file=path.join(context.projectRoot,'.ex-api-rules.lock.json');let lock=null;
  if(fs.existsSync(file)){lock=legacy.readJSON(file);core.validate('lock',lock);}
  if(lock&&options.bundle&&lock.bundleId!==options.bundle)throw Error('Explicit bundle differs from project lock; run pin first');
  if(lock&&options.profile&&lock.profile!==options.profile)throw Error('Explicit profile differs from project lock; run pin first');
  if(lock&&lock.toolVersion!==core.VERSION)throw Error('Tool version differs from project lock; use the pinned tool or explicitly pin again');
  let bundle;
  if(lock){try{bundle=context.store.load(lock.bundleId,lock.artifactSha256);}catch(e){if(e.code!=='ENOENT'&&!e.message.startsWith('Bundle not installed'))throw e;bundle=bootstrapLegacy(context.store,context.distributionRoot);if(bundle.manifest.id!==lock.bundleId||bundle.artifactSha256!==lock.artifactSha256)throw Error('Pinned bundle unavailable; import its exact release artifact');}
    if(bundle.manifest.bundleHash!==lock.bundleHash)throw Error('Project lock bundle hash mismatch');
  }else if(options.bundle)bundle=context.store.load(options.bundle);
  else bundle=bootstrapLegacy(context.store,context.distributionRoot);
  return {bundle,lock,profile:lock?.profile||options.profile||'default'};
}
function pin(context,options){
  const bundle=options.bundle?context.store.load(options.bundle):bootstrapLegacy(context.store,context.distributionRoot);
  const lock={schemaVersion:1,toolVersion:core.VERSION,bundleId:bundle.manifest.id,bundleHash:bundle.manifest.bundleHash,artifactSha256:bundle.artifactSha256,bundleSchemaVersion:2,profile:options.profile||'default'};
  core.validate('lock',lock);atomic(path.join(context.projectRoot,'.ex-api-rules.lock.json'),lock);return lock;
}
async function collect(context,{fetcher=fetch}={}){
  const assets=resources(context.distributionRoot),id=idNow(),dir=path.join(context.store.root,'candidates',id),catalog=legacy.readJSON(path.join(assets.catalog,'sources.json'));
  writes.mkdir(dir);const sources=await fetchSources(catalog,dir,fetcher),seeds=legacy.readJSON(path.join(assets.catalog,'rules.json'));core.validate('catalog',seeds);
  const rules=seeds.map(seed=>{const {localEvidence,...rule}=seed;if(localEvidence){if(!/^archive\/[a-zA-Z0-9.-]+\.sanitized\.json$/.test(localEvidence))throw Error('Only declared sanitized evidence can be imported');const raw=fs.readFileSync(path.join(assets.archive,path.basename(localEvidence))),value=JSON.parse(raw);if(value.referenceOnly!==true||value.runtimeUsable!==false)throw Error('Evidence is not reference-only');const snapshot='evidence/'+core.hash(raw)+'.json';writes.mkdir(path.join(dir,'evidence'));writes.writeFile(legacy.safePath(dir,snapshot),raw);rule.evidence=[{originalPath:localEvidence,snapshot,sha256:core.hash(raw)}];}return rule;});
  const manifest={schemaVersion:1,canonicalization:'utf16-v1',id,collectedAt:new Date().toISOString(),catalogHash:core.hash(core.stringify(catalog)),sources,bundleHash:core.hash(core.stringify({sources,rules}))};
  atomic(path.join(dir,'manifest.json'),manifest);atomic(path.join(dir,'rules.json'),rules);
  let validationError=null;try{portableFromDirectory(dir);}catch(e){validationError=e.message;}
  let baseline=context.store.readActive()?.bundle||null;
  if(!baseline){
    const historical=context.store.legacyBaseline(context.distributionRoot);
    if(historical){context.store.importBundle(historical.portable);baseline=context.store.load(historical.manifest.id,historical.artifactSha256);}
  }
  const changes=baseline?compareSources(baseline.manifest.sources,context.store.materialize(baseline),sources,dir,baseline.rules):sources.map(s=>({id:s.id,classification:s.error?'unavailable-or-unparseable':'initial-source',error:s.error}));
  const ruleChanges=core.ruleChanges(baseline?.rules||[],rules);
  const prospective=rules.map(rule=>({...rule,lifecycle:{...rule.lifecycle,status:['draft','in_review'].includes(rule.lifecycle.status)?'approved':rule.lifecycle.status}}));
  const historyIssues=core.ruleHistoryIssues(baseline?.rules||[],prospective);
  const report={candidate:id,baseline:baseline?.manifest.id||null,baselineArtifactSha256:baseline?.artifactSha256||null,changes,ruleChanges,ruleCount:rules.length,validationError,historyIssues,semanticSourceReviewRequired:true,approvalRequired:true};atomic(path.join(dir,'collection-report.json'),report);return report;
}
function approve(context,id,reviewedBy){
  return context.store.approveCandidate(id,reviewedBy,context.distributionRoot);
}
async function checkUpdates(context,options={},fetcher=fetch){
  const {bundle}=selectBundle(context,options),dir=path.join(context.store.root,'cache/checks',idNow()),assets=resources(context.distributionRoot);
  const current=await fetchSources(legacy.readJSON(path.join(assets.catalog,'sources.json')),dir,fetcher),changes=compareSources(bundle.manifest.sources,context.store.materialize(bundle),current,dir,bundle.rules);
  const failed=changes.filter(c=>c.classification==='unavailable-or-unparseable').length;
  const report={baseline:bundle.manifest.id,artifactSha256:bundle.artifactSha256,checkedAt:new Date().toISOString(),status:failed?'incomplete':'complete',changes,summary:{failed,technical:changes.filter(c=>['technical','new-source','removed-from-catalog'].includes(c.classification)).length,reviewRequired:changes.filter(c=>c.reviewRequired).length,nonTechnical:changes.filter(c=>!c.reviewRequired&&['presentation','examples','source-moved'].includes(c.classification)).length},activeChanged:false,projectLockChanged:false};
  atomic(path.join(dir,'report.json'),report);atomic(path.join(context.store.root,'cache','latest-'+bundle.artifactSha256+'.json'),report);return report;
}
module.exports={LEGACY_HASH,idNow,defaultDataDir,within,atomic,createStore,portableFromDirectory,resources,bootstrapLegacy,selectBundle,pin,collect,approve,checkUpdates};
