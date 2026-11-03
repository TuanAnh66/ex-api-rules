'use strict';
const fs=require('node:fs'),path=require('node:path');
const {hash,stringify,readJSON,writeJSON,verifyBundle,publicFile,safePath}=require('./legacy-core.cjs');
const {fetchSources,compareSources}=require('./collector.cjs');
const idNow=()=>new Date().toISOString().replace(/[:.]/g,'-')+'-'+require('node:crypto').randomUUID().slice(0,8);
function layout(root){const base=path.join(root,'knowledge/exness');return {base,candidates:path.join(base,'candidates'),versions:path.join(base,'versions'),cache:path.join(root,'.cache/exness-rules'),active:path.join(base,'active.json')};}
function loadActive(root){const l=layout(root),active=readJSON(l.active);if(!/^v-[a-zA-Z0-9-]+$/.test(active.version))throw Error('Invalid active version');const dir=safePath(l.versions,active.version);return {...verifyBundle(dir),active,dir};}
async function collect(root,{fetcher=fetch}={}){
  const l=layout(root),id=idNow(),dir=path.join(l.candidates,id);
  fs.mkdirSync(dir,{recursive:true});
  const catalog=readJSON(path.join(l.base,'source-catalog.json'));
  const sources=await fetchSources(catalog,dir,fetcher);
  const seeds=readJSON(path.join(l.base,'rule-seeds.json'));
  const rules=seeds.map(seed=>{
    const {localEvidence,...rule}=seed;
    if(localEvidence){
      // Only sanitized, explicitly declared reference artifacts are imported.
      if(!localEvidence.startsWith('archive/')||!localEvidence.endsWith('.sanitized.json'))throw Error('Only sanitized archive evidence can be imported');
      const raw=fs.readFileSync(publicFile(root,localEvidence)),data=JSON.parse(raw);
      if(data.referenceOnly!==true||data.runtimeUsable!==false)throw Error('Evidence is not marked reference-only');
      const snapshot='evidence/'+hash(raw)+'.json';fs.mkdirSync(path.join(dir,'evidence'),{recursive:true});fs.writeFileSync(safePath(dir,snapshot),raw);
      rule.evidence=[{originalPath:localEvidence,snapshot,sha256:hash(raw)}];
    }
    return {...rule,verification:rule.kind==='documented'?'source-anchored-requires-review':rule.kind==='observed'?'case-specific':'unconfirmed-not-enforced'};
  });
  const manifest={schemaVersion:1,id,collectedAt:new Date().toISOString(),catalogHash:hash(stringify(catalog)),sources,bundleHash:hash(stringify({sources,rules}))};
  writeJSON(path.join(dir,'manifest.json'),manifest);writeJSON(path.join(dir,'rules.json'),rules);
  let baseline=null;try{baseline=loadActive(root);}catch(e){if(e.code!=='ENOENT')throw e;}
  const changes=baseline?compareSources(baseline.manifest.sources,baseline.dir,sources,dir,baseline.rules):sources.map(s=>({id:s.id,classification:s.error?'unavailable-or-unparseable':'initial-source',error:s.error}));
  const oldRules=baseline?.rules||[];
  const ruleChanges=[...new Set([...oldRules.map(r=>r.id),...rules.map(r=>r.id)])].map(id=>{
    const before=oldRules.find(r=>r.id===id),after=rules.find(r=>r.id===id);
    return {id,classification:!before?'added':!after?'removed':stringify(before)===stringify(after)?'unchanged':'changed',before:before?.statement,after:after?.statement};
  }).filter(r=>r.classification!=='unchanged');
  let validationError=null;try{verifyBundle(dir);}catch(e){validationError=e.message;}
  const report={candidate:id,baseline:baseline?.active.version||null,createdAt:new Date().toISOString(),changes,ruleChanges,ruleCount:rules.length,validationError,approvalRequired:true};
  writeJSON(path.join(dir,'collection-report.json'),report);
  return {...report,directory:path.relative(root,dir).replace(/\\/g,'/')};
}
function approveUnlocked(root,id,reviewedBy){
  if(!reviewedBy?.trim())throw Error('Approval requires --reviewed-by with an explicit reviewer identity');
  if(!/^[a-zA-Z0-9-]+$/.test(id))throw Error('Invalid candidate ID');
  const l=layout(root),source=safePath(l.candidates,id),bundle=verifyBundle(source);
  const version='v-'+id+'-'+bundle.manifest.bundleHash.slice(0,12),target=path.join(l.versions,version);
  fs.mkdirSync(l.versions,{recursive:true});
  if(!fs.existsSync(target)){
    // Copy verified bytes, never arbitrary extra files or symlinks in a candidate directory.
    fs.mkdirSync(target);
    for(const sourceRecord of bundle.manifest.sources){const to=safePath(target,sourceRecord.snapshot);fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(safePath(source,sourceRecord.snapshot),to);}
    for(const r of bundle.rules)for(const e of r.evidence)if(e.snapshot){const to=safePath(target,e.snapshot);fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(safePath(source,e.snapshot),to);}
    writeJSON(path.join(target,'manifest.json'),bundle.manifest);writeJSON(path.join(target,'rules.json'),bundle.rules);
  }
  verifyBundle(target);
  const approval={version,candidate:id,bundleHash:bundle.manifest.bundleHash,approvedAt:new Date().toISOString(),reviewedBy};
  writeJSON(path.join(l.base,'approvals',idNow()+'.json'),approval);
  // Active pointer replacement is atomic; all referenced snapshots already exist.
  writeJSON(l.active+'.tmp',approval);fs.renameSync(l.active+'.tmp',l.active);
  return approval;
}
function approve(root,id,reviewedBy){
  const lock=path.join(layout(root).base,'approval.lock');
  const fd=fs.openSync(lock,'wx');
  try{return approveUnlocked(root,id,reviewedBy);}finally{fs.closeSync(fd);fs.unlinkSync(lock);}
}
async function checkUpdates(root,{fetcher=fetch}={}){
  const baseline=loadActive(root),l=layout(root),id=idNow(),dir=path.join(l.cache,'checks',id);
  const current=await fetchSources(readJSON(path.join(l.base,'source-catalog.json')),dir,fetcher);
  const changes=compareSources(baseline.manifest.sources,baseline.dir,current,dir,baseline.rules);
  const failed=changes.filter(c=>c.classification==='unavailable-or-unparseable').length;
  const report={id,baseline:baseline.active.version,checkedAt:new Date().toISOString(),status:failed?'incomplete':'complete',sources:current,changes,
    summary:{failed,technical:changes.filter(c=>['technical','new-source','removed-from-catalog'].includes(c.classification)).length,nonTechnical:changes.filter(c=>['presentation','examples','source-moved'].includes(c.classification)).length},activeChanged:false};
  writeJSON(path.join(dir,'report.json'),report);writeJSON(path.join(l.cache,'latest-check.json'),report);
  return report;
}
module.exports={layout,loadActive,collect,approve,checkUpdates};
