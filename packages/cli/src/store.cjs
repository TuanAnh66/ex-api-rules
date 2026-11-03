'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const core=require('ex-api-rules-core');
const legacy=require('./legacy-core.cjs');
const {fetchSources,compareSources}=require('./collector.cjs');
const LEGACY_HASH='e3a79f510ff6364440e5e7d9832f48c9f5ee99ceee5f62e73905d1fe8c0b4e37';
const idNow=()=>new Date().toISOString().replace(/[:.]/g,'-')+'-'+crypto.randomUUID().slice(0,8);
function defaultDataDir(){return process.env.EX_API_RULES_DATA_DIR||(process.platform==='win32'?path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData/Local'),'ex-api-rules'):path.join(process.env.XDG_STATE_HOME||path.join(os.homedir(),'.local/state'),'ex-api-rules'));}
function within(root,file){const rel=path.relative(path.resolve(root),path.resolve(file));return rel===''||(!rel.startsWith('..')&&!path.isAbsolute(rel));}
function atomic(file,value){
  fs.mkdirSync(path.dirname(file),{recursive:true});const temporary=file+'.tmp-'+crypto.randomUUID();
  const fd=fs.openSync(temporary,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  try{fs.renameSync(temporary,file);}catch(e){try{fs.unlinkSync(temporary);}catch{}throw e;}
}
function assertUsable(bundle){
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
  const root=path.resolve(directory),registryFile=path.join(root,'bundles/index.json');
  function readRegistry(){try{return legacy.readJSON(registryFile);}catch(e){if(e.code!=='ENOENT')throw e;return {};}}
  function blobPath(digest){if(!/^[0-9a-f]{64}$/.test(digest))throw Error('Invalid blob digest');return path.join(root,'blobs',digest.slice(0,2),digest);}
  function artifactPath(digest){if(!/^[0-9a-f]{64}$/.test(digest))throw Error('Invalid artifact digest');return path.join(root,'bundles',digest+'.json');}
  function importBundle(portable,{activate=false}={}){
    const verified=core.verifyPortable(portable);assertUsable(verified);
    fs.mkdirSync(path.join(root,'bundles'),{recursive:true});const lock=path.join(root,'bundles/write.lock');const fd=fs.openSync(lock,'wx');
    try{
      const registry=readRegistry(),previous=registry[verified.manifest.id];
      if(previous&&previous!==verified.artifactSha256)throw Error('Bundle ID is immutable; use a new ID');
      for(const digest of verified.blobDigests){const target=blobPath(digest),bytes=core.decodeBlob(portable.blobs[digest]);fs.mkdirSync(path.dirname(target),{recursive:true});if(fs.existsSync(target)){if(core.hash(fs.readFileSync(target))!==digest)throw Error('Existing blob is corrupted');}else fs.writeFileSync(target,bytes,{flag:'wx',mode:0o600});}
      const target=artifactPath(verified.artifactSha256),record={schemaVersion:2,manifest:portable.manifest,rules:portable.rules,blobDigests:verified.blobDigests};
      if(!fs.existsSync(target))atomic(target,record);
      registry[verified.manifest.id]=verified.artifactSha256;atomic(registryFile,registry);
      if(activate)atomic(path.join(root,'maintainer-active.json'),{id:verified.manifest.id,artifactSha256:verified.artifactSha256});
      return verified;
    }finally{fs.closeSync(fd);fs.unlinkSync(lock);}
  }
  function load(id,expectedArtifact){
    const digest=expectedArtifact||readRegistry()[id];if(!digest)throw Error('Bundle not installed; run bundle import, then pin');
    const record=legacy.readJSON(artifactPath(digest)),blobs=Object.fromEntries(record.blobDigests.map(h=>[h,fs.readFileSync(blobPath(h)).toString('base64')]));
    const portable={schemaVersion:2,manifest:record.manifest,rules:record.rules,blobs},verified=core.verifyPortable(portable);
    if(verified.artifactSha256!==digest||verified.manifest.id!==id)throw Error('Stored artifact does not match selected bundle');assertUsable(verified);return {...verified,portable};
  }
  function materialize(bundle){
    const dir=path.join(root,'cache/views',bundle.artifactSha256);fs.mkdirSync(dir,{recursive:true});
    for(const source of bundle.manifest.sources){const target=legacy.safePath(dir,source.snapshot);fs.mkdirSync(path.dirname(target),{recursive:true});if(!fs.existsSync(target))fs.copyFileSync(blobPath(source.sha256),target);}
    for(const rule of bundle.rules)for(const e of rule.evidence)if(e.snapshot&&!e.sourceId){const target=legacy.safePath(dir,e.snapshot);fs.mkdirSync(path.dirname(target),{recursive:true});if(!fs.existsSync(target))fs.copyFileSync(blobPath(e.sha256),target);}
    // Cache is disposable and is verified again before use.
    atomic(path.join(dir,'manifest.json'),bundle.manifest);atomic(path.join(dir,'rules.json'),bundle.rules);legacy.verifyBundle(dir);return dir;
  }
  return {root,importBundle,load,materialize,readRegistry,blobPath};
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
  fs.mkdirSync(dir,{recursive:true});const sources=await fetchSources(catalog,dir,fetcher),seeds=legacy.readJSON(path.join(assets.catalog,'rules.json'));core.validate('catalog',seeds);
  const rules=seeds.map(seed=>{const {localEvidence,...rule}=seed;if(localEvidence){if(!/^archive\/[a-zA-Z0-9.-]+\.sanitized\.json$/.test(localEvidence))throw Error('Only declared sanitized evidence can be imported');const raw=fs.readFileSync(path.join(assets.archive,path.basename(localEvidence))),value=JSON.parse(raw);if(value.referenceOnly!==true||value.runtimeUsable!==false)throw Error('Evidence is not reference-only');const snapshot='evidence/'+core.hash(raw)+'.json';fs.mkdirSync(path.join(dir,'evidence'),{recursive:true});fs.writeFileSync(legacy.safePath(dir,snapshot),raw);rule.evidence=[{originalPath:localEvidence,snapshot,sha256:core.hash(raw)}];}return rule;});
  const manifest={schemaVersion:1,id,collectedAt:new Date().toISOString(),catalogHash:core.hash(core.stringify(catalog)),sources,bundleHash:core.hash(core.stringify({sources,rules}))};
  atomic(path.join(dir,'manifest.json'),manifest);atomic(path.join(dir,'rules.json'),rules);
  let validationError=null;try{portableFromDirectory(dir);}catch(e){validationError=e.message;}
  let baseline=null;try{const active=legacy.readJSON(path.join(context.store.root,'maintainer-active.json'));baseline=context.store.load(active.id,active.artifactSha256);}catch(e){if(e.code!=='ENOENT')throw e;}
  if(!baseline)try{baseline=bootstrapLegacy(context.store,context.distributionRoot);}catch(e){if(!e.message.startsWith('No project lock'))throw e;}
  const changes=baseline?compareSources(baseline.manifest.sources,context.store.materialize(baseline),sources,dir,baseline.rules):sources.map(s=>({id:s.id,classification:s.error?'unavailable-or-unparseable':'initial-source',error:s.error}));
  const ruleChanges=rules.map(r=>({id:r.id,classification:baseline?.rules.some(old=>old.id===r.id)?'requires-semantic-review':'added',statement:r.statement}));
  const report={candidate:id,baseline:baseline?.manifest.id||null,changes,ruleChanges,ruleCount:rules.length,validationError,approvalRequired:true};atomic(path.join(dir,'collection-report.json'),report);return report;
}
function approve(context,id,reviewedBy){
  if(!/^[A-Za-z0-9-]+$/.test(id||''))throw Error('Invalid candidate ID');if(!reviewedBy?.trim())throw Error('Approval requires --reviewed-by');
  const candidate=path.join(context.store.root,'candidates',id),portable=portableFromDirectory(candidate);
  const rules=portable.rules.map(rule=>({...rule,lifecycle:{...rule.lifecycle,status:['draft','in_review'].includes(rule.lifecycle.status)?'approved':rule.lifecycle.status}}));
  const manifest={...portable.manifest,bundleHash:core.hash(core.stringify({sources:portable.manifest.sources,rules}))};manifest.id='v-'+id+'-'+manifest.bundleHash.slice(0,12);
  const final={schemaVersion:2,manifest,rules,blobs:portable.blobs};const verified=context.store.importBundle(final,{activate:true});
  const approval={version:manifest.id,candidate:id,bundleHash:manifest.bundleHash,artifactSha256:verified.artifactSha256,approvedAt:new Date().toISOString(),reviewedBy};atomic(path.join(context.store.root,'approvals',idNow()+'.json'),approval);return approval;
}
async function checkUpdates(context,options={},fetcher=fetch){
  const {bundle}=selectBundle(context,options),dir=path.join(context.store.root,'cache/checks',idNow()),assets=resources(context.distributionRoot);
  const current=await fetchSources(legacy.readJSON(path.join(assets.catalog,'sources.json')),dir,fetcher),changes=compareSources(bundle.manifest.sources,context.store.materialize(bundle),current,dir,bundle.rules);
  const failed=changes.filter(c=>c.classification==='unavailable-or-unparseable').length;
  const report={baseline:bundle.manifest.id,artifactSha256:bundle.artifactSha256,checkedAt:new Date().toISOString(),status:failed?'incomplete':'complete',changes,summary:{failed,technical:changes.filter(c=>['technical','new-source','removed-from-catalog'].includes(c.classification)).length,nonTechnical:changes.filter(c=>['presentation','examples','source-moved'].includes(c.classification)).length},activeChanged:false,projectLockChanged:false};
  atomic(path.join(dir,'report.json'),report);atomic(path.join(context.store.root,'cache','latest-'+bundle.artifactSha256+'.json'),report);return report;
}
module.exports={LEGACY_HASH,idNow,defaultDataDir,within,atomic,createStore,portableFromDirectory,resources,bootstrapLegacy,selectBundle,pin,collect,approve,checkUpdates};
