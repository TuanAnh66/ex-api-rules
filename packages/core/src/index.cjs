'use strict';
const crypto=require('node:crypto');
const Ajv=require('ajv/dist/2020');
const {fingerprintInputs,validateReportData}=require('./report.cjs');
const VERSION='0.2.1';
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
function canonical(value){
  if(value===undefined||typeof value==='bigint'||typeof value==='function'||typeof value==='symbol')throw Error('Not a JSON protocol value');
  if(typeof value==='number'&&!Number.isSafeInteger(value))throw Error('Protocol numbers must be safe integers; use decimal strings');
  if(Array.isArray(value))return Array.from(value,canonical);
  if(value&&typeof value==='object'){if(![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw Error('Expected a plain JSON object');return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));}
  return value;
}
// Emit object members directly: JSON.stringify(object) reorders integer keys.
function encode(value){
  if(Array.isArray(value))return '['+value.map(encode).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+encode(value[k])).join(',')+'}';
  return JSON.stringify(value);
}
const stringify=value=>encode(canonical(value));
const legacyStringify=value=>JSON.stringify(canonical(value));
function bundleStringify(manifest,value){
  const algorithm=manifest.canonicalization??'ecmascript-v0';
  if(algorithm==='ecmascript-v0')return legacyStringify(value);
  if(algorithm==='utf16-v1')return stringify(value);
  throw Error('Unsupported bundle canonicalization '+algorithm);
}
const ajv=new Ajv({strict:false,allErrors:true,validateFormats:false});
for(const name of ['rule','bundle','report','lock','catalog','checks'])ajv.addSchema(require('../schemas/'+name+'.schema.json'));
ajv.addSchema(require('../schemas/report-v2.schema.json'));
function validate(name,value){
  const version=name==='report'?value?.schemaVersion:1;
  if(name==='report'&&![1,2].includes(version))throw Error('Unsupported report schemaVersion');
  const check=ajv.getSchema('urn:ex-api-rules:'+name+':'+version);
  if(!check(value))throw Error(name+' schema validation failed: '+ajv.errorsText(check.errors));
  if(name==='report'&&version===2){
    validateReportData(value);
    if(value.resultFingerprint!==reportFingerprint(value))throw Error('report v2 result fingerprint mismatch');
  }
  return value;
}
function reportFingerprint(report){return hash(stringify(fingerprintInputs(report)));}
function pointer(document,ref){
  if(!ref.startsWith('#/'))throw Error('Only local schema references are supported');
  let value=document;for(const segment of ref.slice(2).split('/'))value=value?.[segment.replace(/~1/g,'/').replace(/~0/g,'~')];
  if(value===undefined)throw Error('Missing schema reference '+ref);return value;
}
function openApiValidator(document,schemaName){
  if(!document?.components?.schemas?.[schemaName])throw Error('Missing component schema '+schemaName);
  const validator=new Ajv({strict:false,allErrors:true,validateFormats:false});
  return validator.compile({$schema:'https://json-schema.org/draft/2020-12/schema',components:document.components,$ref:'#/components/schemas/'+schemaName});
}
function referencedDigests(manifest,rules){return [...new Set([...manifest.sources.map(s=>s.sha256),...rules.flatMap(r=>r.evidence.filter(e=>e.snapshot&&!e.sourceId).map(e=>e.sha256))])].sort();}
function decodeBlob(encoded){
  if(typeof encoded!=='string')throw Error('Blob must be base64 text');
  const bytes=Buffer.from(encoded,'base64');if(bytes.toString('base64')!==encoded)throw Error('Invalid canonical base64 blob');return bytes;
}
function verifyPortable(input){
  validate('bundle',input);
  const {manifest,rules,blobs}=input;
  if(rules.some(r=>!Array.isArray(r.evidence)))throw Error('Bundle rules require resolved evidence');
  if(new Set(rules.map(r=>r.id)).size!==rules.length||new Set(manifest.sources.map(s=>s.id)).size!==manifest.sources.length)throw Error('Duplicate identifiers');
  if(manifest.bundleHash!==hash(bundleStringify(manifest,{sources:manifest.sources,rules})))throw Error('Bundle digest mismatch');
  const refs=referencedDigests(manifest,rules);
  if(JSON.stringify(refs)!==JSON.stringify(Object.keys(blobs).sort()))throw Error('Missing or unreferenced blob');
  for(const digest of refs)if(hash(decodeBlob(blobs[digest]))!==digest)throw Error('Blob digest mismatch');
  for(const rule of rules){
    for(const e of rule.evidence){if(e.sourceId&&!manifest.sources.some(s=>s.id===e.sourceId))throw Error('Missing evidence source');}
    for(const id of rule.conflictsWith||[])if(!rules.some(r=>r.id===id))throw Error('Missing conflicting rule');
    if(rule.lifecycle?.status==='superseded'&&!rules.some(r=>r.id===rule.lifecycle.supersededBy))throw Error('Missing successor rule');
  }
  return {manifest,rules,artifactSha256:hash(bundleStringify(manifest,input)),blobDigests:refs};
}
function selectRules(rules,profile='default'){
  if(!['default','payments','trading'].includes(profile))throw Error('Unknown profile');
  return rules.filter(r=>r.kind!=='inference'&&(!r.lifecycle||r.lifecycle.status==='approved')&&(profile==='default'||r.scope==='common'||r.scope===profile));
}
function ruleChanges(before,after){
  const previous=new Map(before.map(rule=>[rule.id,rule])),current=new Map(after.map(rule=>[rule.id,rule]));
  return [...new Set([...previous.keys(),...current.keys()])].sort().map(id=>{
    const old=previous.get(id)||null,next=current.get(id)||null;
    return {id,classification:!old?'added':!next?'removed':stringify(old)===stringify(next)?'unchanged':'changed',before:old,after:next};
  });
}
function ruleHistoryIssues(before,after){
  const issues=[],current=new Map(after.map(rule=>[rule.id,rule]));
  const issue=(ruleId,reason)=>issues.push({ruleId,reason});
  for(const old of before){
    const next=current.get(old.id);
    if(!next){issue(old.id,'Approved rule history cannot disappear; retain the ID with deprecated/superseded lifecycle.');continue;}
    if(next.scope!==old.scope||next.kind!==old.kind)issue(old.id,'Stable rule ID cannot be rebound to a different scope or evidence kind.');
    if(old.lifecycle){
      if(next.lifecycle?.introducedIn!==old.lifecycle.introducedIn)issue(old.id,'Lifecycle introducedIn must remain stable.');
      const withoutRevision=rule=>({...rule,lifecycle:{...rule.lifecycle,revision:0}});
      const changed=stringify(withoutRevision(old))!==stringify(withoutRevision(next));
      if(!next.lifecycle||next.lifecycle.revision<old.lifecycle.revision||(changed&&next.lifecycle.revision===old.lifecycle.revision))issue(old.id,'Changed rules/lifecycle require an increased revision; revisions cannot decrease.');
    }
  }
  for(const rule of after){
    const seen=new Set([rule.id]);let cursor=rule;
    while(cursor?.lifecycle?.status==='superseded'){
      const id=cursor.lifecycle.supersededBy;
      if(!current.has(id)){issue(rule.id,'Superseded successor must exist in the same bundle.');break;}
      if(seen.has(id)){issue(rule.id,'Superseded successor must not reference itself or form a cycle.');break;}
      seen.add(id);cursor=current.get(id);
    }
  }
  return issues;
}
function toSarif(report){
  validate('report',report);
  const ids=[...new Set(report.findings.map(f=>f.ruleId))];
  const properties={ruleVersion:report.ruleVersion,bundleHash:report.bundleHash,resultFingerprint:report.resultFingerprint,coverage:report.coverage,manualChecks:report.manualChecks,...(report.outcome===undefined?{}:{outcome:report.outcome})};
  if(report.schemaVersion===2)Object.assign(properties,{schemaVersion:2,codeVersion:report.codeVersion,inputPolicy:report.inputPolicy});
  return {$schema:'https://json.schemastore.org/sarif-2.1.0.json',version:'2.1.0',runs:[{
    tool:{driver:{name:'ex-api-rules',version:report.toolVersion,rules:ids.map(id=>({id,shortDescription:{text:id}}))}},properties,
    results:report.findings.map(f=>({
      ruleId:f.ruleId,level:f.severity==='P1'&&f.kind==='documented'?'error':'warning',message:{text:f.title+' '+f.recommendation},
      locations:[{physicalLocation:{artifactLocation:{uri:f.file.replace(/\\/g,'/').split('/').map(encodeURIComponent).join('/'),uriBaseId:'%SRCROOT%'},region:{startLine:f.line,...(report.schemaVersion!==2||f.column===undefined?{}:{startColumn:f.column})}}}],
      partialFingerprints:{primaryLocationLineHash:hash(stringify({ruleId:f.ruleId,file:f.file,line:f.line,title:f.title}))},
      properties:{kind:f.kind,confidence:f.confidence||'static-review-required',evidence:f.evidence}
    }))
  }]};
}
module.exports={VERSION,hash,canonical,stringify,legacyStringify,bundleStringify,validate,reportFingerprint,pointer,openApiValidator,referencedDigests,decodeBlob,verifyPortable,selectRules,ruleChanges,ruleHistoryIssues,toSarif};
