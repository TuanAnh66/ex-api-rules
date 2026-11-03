'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const YAML=require('yaml'),cheerio=require('cheerio');
const pure=require('ex-api-rules-core');
const writes=require('./write-path.cjs');
const hash=pure.hash;
function canonical(value){
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));
  return value;
}
const stringify=value=>JSON.stringify(canonical(value));
// Only follow typed OpenAPI/JSON Schema edges. Dictionary names and literal
// data (const/enum/default, extensions, etc.) are never annotation keywords.
const children={
  openapi:{paths:'patterned:pathItem',webhooks:'map:pathItem',components:'components',tags:'array:tag'},
  components:{schemas:'map:schema',parameters:'map:parameter',headers:'map:parameter',responses:'map:response',requestBodies:'map:requestBody',callbacks:'map:callback',pathItems:'map:pathItem'},
  pathItem:{get:'operation',put:'operation',post:'operation',delete:'operation',options:'operation',head:'operation',patch:'operation',trace:'operation',parameters:'array:parameter'},
  operation:{parameters:'array:parameter',requestBody:'requestBody',responses:'patterned:response',callbacks:'map:callback'},
  parameter:{schema:'schema',content:'map:media'},
  requestBody:{content:'map:media'},
  response:{headers:'map:parameter',content:'map:media'},
  media:{schema:'schema',encoding:'map:encoding'},
  encoding:{headers:'map:parameter'},
  schema:Object.fromEntries([
    ...['properties','patternProperties','$defs','definitions','dependentSchemas','dependencies'].map(k=>[k,'map:schema']),
    ...['items','additionalItems','additionalProperties','unevaluatedItems','unevaluatedProperties','contains','not','if','then','else','propertyNames','contentSchema'].map(k=>[k,'schema']),
    ...['allOf','anyOf','oneOf','prefixItems'].map(k=>[k,'array:schema'])
  ])
};
const annotations={openapi:['externalDocs'],operation:['externalDocs'],tag:['externalDocs'],components:['examples'],schema:['example','examples','externalDocs'],parameter:['example','examples'],media:['example','examples']};
function withoutExamples(value,context='openapi'){
  if(!value||typeof value!=='object')return value;
  if(context.startsWith('array:'))return Array.isArray(value)?value.map(v=>withoutExamples(v,context.slice(6))):value;
  if(Array.isArray(value))return value;
  // Patterned OpenAPI objects admit x-* specification extensions. Plain
  // named maps do not: an x-* schema/property/component name is still typed.
  if(context.startsWith('patterned:'))return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,k.startsWith('x-')?v:withoutExamples(v,context.slice(10))]));
  if(context.startsWith('map:'))return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,withoutExamples(v,context.slice(4))]));
  if(context==='callback')return withoutExamples(value,'patterned:pathItem');
  const edges=children[context]||{};
  return Object.fromEntries(Object.entries(value).filter(([k])=>!annotations[context]?.includes(k)).map(([k,v])=>[k,Object.hasOwn(edges,k)?withoutExamples(v,edges[k]):v]));
}
function normalize(raw,kind){
  const text=Buffer.isBuffer(raw)?raw.toString('utf8'):raw;
  if(kind==='openapi'){
    const document=YAML.parse(text,{uniqueKeys:true,maxAliasCount:50});
    if(!document||!/^3\.1\./.test(document.openapi)||!document.paths||!document.components?.schemas)throw Error('Invalid OpenAPI 3.1 document');
    return {full:stringify(document),semantic:stringify(withoutExamples(document)),document};
  }
  const $=cheerio.load(text);let article=$('article').first();if(!article.length)article=$('.article-body').first();
  if(!article.length)throw Error('No documentation article; possible challenge or changed layout');
  article.find('script,style,nav,aside,button,.theme-doc-toc-mobile,.hash-link').remove();
  const clean=s=>s.replace(/\s+/g,' ').trim();
  const full=clean(article.text());
  if(full.length<40)throw Error('Documentation article is empty');
  const normative=article.clone();normative.find('pre,[data-rule-example],.example').remove();
  const links=article.find('a[href]').map((i,e)=>$(e).attr('href')).get();
  return {full,semantic:clean(normative.text()),links};
}
function differences(a,b,prefix='',out=[]){
  if(stringify(a)===stringify(b))return out;
  if(a&&b&&typeof a==='object'&&typeof b==='object'&&!Array.isArray(a)&&!Array.isArray(b)){
    for(const key of new Set([...Object.keys(a),...Object.keys(b)]))differences(a[key],b[key],prefix+'/'+key.replace(/~/g,'~0').replace(/\//g,'~1'),out);
  }else if(out.length<100)out.push(prefix||'/');
  return out;
}
function classify(oldRaw,newRaw,kind){
  const before=normalize(oldRaw,kind),after=normalize(newRaw,kind);
  if(hash(oldRaw)===hash(newRaw))return {classification:'unchanged',paths:[]};
  if(before.full===after.full)return {classification:'presentation',paths:[]};
  if(before.semantic===after.semantic)return {classification:'examples',paths:[]};
  return {classification:'technical',paths:kind==='openapi'?differences(JSON.parse(before.semantic),JSON.parse(after.semantic)):['article-text']};
}
function pointer(document,ref){
  if(!ref.startsWith('#/'))throw Error('Only local schema references are supported');
  let value=document;for(const segment of ref.slice(2).split('/'))value=value?.[segment.replace(/~1/g,'/').replace(/~0/g,'~')];
  if(value===undefined)throw Error('Missing schema reference '+ref);return value;
}
function validator(raw,schemaName){return pure.openApiValidator(normalize(raw,'openapi').document,schemaName);}
function readJSON(file){return JSON.parse(fs.readFileSync(file,'utf8'));}
function writeJSON(file,value){writes.mkdir(path.dirname(file));writes.writeFile(file,JSON.stringify(value,null,2)+'\n');}
function safePath(root,relative){
  const abs=path.resolve(root,relative),rel=path.relative(root,abs);
  if(!rel||rel.startsWith('..')||path.isAbsolute(rel))throw Error('Path outside allowed directory');return abs;
}
function publicFile(root,relative){
  const abs=safePath(root,relative),rel=path.relative(root,abs).replace(/\\/g,'/');
  if(rel.split('/').some(p=>/^(exness-custom-key|node_modules|\.git|\.cache|\.agents|\.codex)$/i.test(p))||/(^|\/)(config\.local\.json|\.env[^/]*|[^/]+\.(key|pem))$/i.test(rel))throw Error('Private or excluded path');
  const real=fs.realpathSync(abs),realRel=path.relative(fs.realpathSync(root),real);
  if(realRel.startsWith('..')||path.isAbsolute(realRel)||real!==abs&&process.platform!=='win32')throw Error('External or symbolic path');
  // A symlink into the excluded key directory must also be rejected.
  const normalized=realRel.replace(/\\/g,'/');if(/(^|\/)(exness-custom-key|\.git|node_modules|\.cache|\.agents|\.codex)(\/|$)/i.test(normalized)||/(^|\/)(config\.local\.json|\.env[^/]*|[^/]+\.(key|pem))$/i.test(normalized))throw Error('Private path target');
  return abs;
}
function verifyBundle(dir){
  const manifest=readJSON(path.join(dir,'manifest.json')),rules=readJSON(path.join(dir,'rules.json'));
  if(manifest.schemaVersion!==1||!Array.isArray(rules)||new Set(rules.map(r=>r.id)).size!==rules.length||new Set(manifest.sources.map(s=>s.id)).size!==manifest.sources.length)throw Error('Invalid or duplicate bundle identifiers');
  for(const source of manifest.sources){
    if(source.error)throw Error('Incomplete source '+source.id);
    if(!/^[0-9a-f]{64}$/.test(source.sha256))throw Error('Invalid source digest');
    const raw=fs.readFileSync(safePath(dir,source.snapshot));
    if(hash(raw)!==source.sha256)throw Error('Source digest mismatch: '+source.id);
    normalize(raw,source.kind);
  }
  const digest=hash(pure.bundleStringify(manifest,{sources:manifest.sources,rules}));
  if(digest!==manifest.bundleHash)throw Error('Bundle digest mismatch');
  for(const rule of rules){
    if(!['documented','observed','inference'].includes(rule.kind)||!['common','payments','trading'].includes(rule.scope)||!rule.id||!rule.statement||!rule.evidence?.length)throw Error('Invalid rule');
    for(const e of rule.evidence){
      if(e.sourceId){const src=manifest.sources.find(s=>s.id===e.sourceId);if(!src)throw Error('Missing evidence source');const n=normalize(fs.readFileSync(safePath(dir,src.snapshot)),src.kind);const body=e.pointer?stringify(pointer(n.document,e.pointer)):n.full;if(!e.terms.every(t=>body.toLowerCase().includes(t.toLowerCase())))throw Error('Evidence anchor mismatch: '+rule.id);}
      else{const file=safePath(dir,e.snapshot);if(hash(fs.readFileSync(file))!==e.sha256)throw Error('Local evidence digest mismatch');}
    }
  }
  return {manifest,rules};
}
module.exports={hash,stringify,normalize,classify,pointer,validator,readJSON,writeJSON,safePath,publicFile,verifyBundle};
