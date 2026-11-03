'use strict';
const fs=require('node:fs'),path=require('node:path');
const {hash,normalize,classify,writeJSON,readJSON,safePath}=require('./legacy-core.cjs');
function allowed(url,catalog){
  const u=new URL(url);
  if(u.protocol!=='https:'||u.username||u.password||u.port||!catalog.allowedHosts.includes(u.hostname))throw Error('URL is not an allowed public documentation source');
  if(u.hostname==='get.exness.help'){if(!/^\/hc\/en-us\/articles\//.test(u.pathname))throw Error('Not an English help article');}
  else if(!/^\/(openapi\/(payments|trading)\.public\.yaml|(payments|trading)\/(guides|core-concepts|get-started|changelog)(\/[^?#]*)?|authentication\/[^?#]+)$/.test(u.pathname))throw Error('Not a documentation path');
  u.hash='';u.search='';return u.href.replace(/\/$/,'');
}
async function download(url,catalog,fetcher=fetch){
  let target=allowed(url,catalog);
  for(let redirect=0;redirect<6;redirect++){
    let response;for(let attempt=0;attempt<2;attempt++){
      try{response=await fetcher(target,{redirect:'manual',signal:AbortSignal.timeout(20000),headers:{'User-Agent':'ExTransfer-rules/1.0 public-docs-only'}});break;}catch(e){if(attempt===1){const failure=Error('Source fetch failed: '+(e.cause?.code||e.name));failure.failureType='network-error';throw failure;}}
    }
    if([301,302,303,307,308].includes(response.status)){target=allowed(new URL(response.headers.get('location'),target).href,catalog);continue;}
    if(!response.ok){const failure=Error('Source HTTP '+response.status);failure.failureType=[404,410].includes(response.status)?'removed':response.status===429?'rate-limited':'http-error';throw failure;}
    const chunks=[];let size=0;
    for await(const chunk of response.body){size+=chunk.length;if(size>5*1024*1024)throw Error('Source exceeds 5 MiB');chunks.push(Buffer.from(chunk));}
    return {raw:Buffer.concat(chunks),finalUrl:target,redirected:target!==allowed(url,catalog)};
  }
  throw Error('Too many source redirects');
}
async function fetchSources(catalog,directory,fetcher=fetch){
  const queue=[...catalog.sources],seen=new Set(queue.map(s=>allowed(s.url,catalog))),records=[];
  if(queue.length>catalog.maxSources)throw Error('Source catalog exceeds limit');
  let cursor=0;
  while(cursor<queue.length){
    const items=queue.slice(cursor,cursor+3);cursor+=items.length;
    const batch=await Promise.all(items.map(async source=>{
      let downloaded=false;
      try{
        const {raw,...meta}=await download(source.url,catalog,fetcher);downloaded=true;
        const parsed=normalize(raw,source.kind),sha256=hash(raw);
        const snapshot='sources/'+sha256+(source.kind==='openapi'?'.yaml':'.html');
        fs.mkdirSync(path.join(directory,'sources'),{recursive:true});fs.writeFileSync(safePath(directory,snapshot),raw);
        return {record:{...source,...meta,fetchedAt:new Date().toISOString(),sha256,snapshot},links:source.discover?parsed.links||[]:[]};
      }catch(e){return {record:{...source,fetchedAt:new Date().toISOString(),error:e.message,failureType:e.failureType||(downloaded?'parse-error':'fetch-error')},links:[]};}
    }));
    for(const {record,links}of batch){records.push(record);
      for(const link of links){try{
        const url=allowed(new URL(link,record.finalUrl||record.url).href,catalog);
        if(seen.has(url))continue;
        if(!new URL(url).pathname.startsWith('/'+record.scope+'/'))continue;
        if(queue.length>=catalog.maxSources)throw Error('Discovery source limit reached');
        seen.add(url);queue.push({id:'doc-'+hash(url).slice(0,16),url,scope:record.scope,kind:url.endsWith('.yaml')?'openapi':'html'});
      }catch(e){if(e.message==='Discovery source limit reached')throw e;}}
    }
  }
  return records.sort((a,b)=>a.id.localeCompare(b.id));
}
function compareSources(previous,oldDir,current,newDir,rules){
  const ids=new Set([...previous.map(s=>s.id),...current.map(s=>s.id)]);
  return [...ids].map(id=>{
    const before=previous.find(s=>s.id===id),after=current.find(s=>s.id===id);
    let change;
    if(!after)change={classification:'removed-from-catalog',paths:[]};
    else if(after.error)change={classification:'unavailable-or-unparseable',failureType:after.failureType,error:after.error,paths:[]};
    else if(!before)change={classification:'new-source',paths:[]};
    else{change=classify(fs.readFileSync(safePath(oldDir,before.snapshot)),fs.readFileSync(safePath(newDir,after.snapshot)),after.kind);}
    const direct=rules.filter(r=>r.evidence.some(e=>e.sourceId===id));
    const affected=direct.length?direct:rules.filter(r=>r.scope===(after||before).scope||r.scope==='common');
    if(after?.redirected&&change.classification==='unchanged')change.classification='source-moved';
    return {id,url:after?.url||before.url,...change,redirected:after?.redirected||false,finalUrl:after?.finalUrl,
      affectedRules:affected.map(r=>r.id),scopes:[...new Set(affected.map(r=>r.scope))],
      endpoints:affected.flatMap(r=>r.endpoints||[]),reviewTargets:affected.flatMap(r=>r.reviewTargets||[]),tests:affected.flatMap(r=>r.tests||[])};
  });
}
module.exports={allowed,download,fetchSources,compareSources};
