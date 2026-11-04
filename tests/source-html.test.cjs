'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const legacy=require('../packages/cli/src/legacy-core.cjs');
const {fetchSources}=require('../packages/cli/src/collector.cjs');
const store=require('../packages/cli/src/store.cjs'),cli=require('../packages/cli/src/main.cjs');
const sourceUrl='https://www.exness-api.com/payments/guides/fixture';
const prose='<h1>Account requests</h1><p>Keep the original account request key and verify the final result before reporting success.</p>';
const html=content=>`<article>${prose}${content}</article>`;
const link='<p>Read the <a href="next?mode=1#result">API endpoint</a> before sending.</p>';
const code='<pre data-rule-example="fixture"><code class="language-yaml">order:\n  amount: "1"</code></pre>';
const baseline=html(link+code);
const classify=(before,after,context={})=>legacy.classify(before,after,'html',{beforeUrl:sourceUrl,afterUrl:sourceUrl,...context});

test('href-only changes retain raw target, resolved target, anchor and context',()=>{
  const result=classify(html(link),html(link.replace('next?mode=1#result','other?mode=2#done')));
  assert.equal(result.classification,'requires-review');assert.equal(result.reviewRequired,true);
  assert.deepEqual(result.paths,['article-links']);assert.equal(result.linkChanges.length,1);
  const delta=result.linkChanges[0];assert.equal(delta.classification,'changed');
  assert.equal(delta.before.href,'next?mode=1#result');assert.equal(delta.after.href,'other?mode=2#done');
  assert.equal(delta.before.resolvedHref,'https://www.exness-api.com/payments/guides/next?mode=1#result');
  assert.equal(delta.before.text,'API endpoint');assert.match(delta.before.context,/before sending/);
});

test('identical snapshot bytes can change relative link meaning when document URL moves',()=>{
  const result=classify(html(link),html(link),{afterUrl:'https://www.exness-api.com/payments/core-concepts/fixture'});
  assert.equal(result.classification,'requires-review');assert.equal(result.reviewRequired,true);
  assert.match(result.linkChanges[0].after.resolvedHref,/\/core-concepts\/next/);
  assert.equal(result.linkChanges[0].before.href,result.linkChanges[0].after.href);
});

test('HTML base changes are resolved against source URL and retained as evidence',()=>{
  const before='<head><base href="../guides/"></head>'+html(link);
  const after=before.replace('../guides/','../core-concepts/');const result=classify(before,after);
  assert.equal(result.classification,'requires-review');assert.equal(result.documentContext.before.rawBaseHref,'../guides/');
  assert.equal(result.documentContext.after.baseUrl,'https://www.exness-api.com/payments/core-concepts/');
  assert.match(result.linkChanges[0].after.resolvedHref,/core-concepts\/next/);
});

test('relative links without URL context remain traceable without inventing a target',()=>{
  const result=legacy.classify(html(link),html(link.replace('next?mode=1#result','other')),'html');
  assert.equal(result.reviewRequired,true);assert.equal(result.linkChanges[0].before.resolvedHref,null);assert.equal(result.linkChanges[0].after.href,'other');
});

test('new and removed article links appear explicitly in delta',()=>{
  const additional='<a href="second">Second endpoint</a>';
  const added=classify(html(link),html(link+additional));assert(added.linkChanges.some(d=>d.classification==='added'&&d.after.href==='second'));assert(added.reviewRequired);
  const removed=classify(html(link+additional),html(link));assert(removed.linkChanges.some(d=>d.classification==='removed'&&d.before.href==='second'));assert(removed.reviewRequired);
});

for(const [name,before,after]of [
  ['plain pre endpoint','<pre>endpoint=/v1</pre>','<pre>endpoint=/v2</pre>'],
  ['inline code','<p>Use <code>amount="1"</code> exactly.</p>','<p>Use <code>amount="2"</code> exactly.</p>'],
  ['YAML indentation','<pre>order:\n  amount: "1"</pre>','<pre>order:\namount: "1"</pre>'],
  ['Python indentation','<pre>if ready:\n  send()</pre>','<pre>if ready:\n    send()</pre>'],
  ['tabs','<pre>if ready:\n\tsend()</pre>','<pre>if ready:\n send()</pre>'],
  ['repeated spaces','<code>value  units</code>','<code>value units</code>'],
  ['labelled example','<div class="example"><pre>endpoint=/v1</pre></div>','<div class="example"><pre>endpoint=/v2</pre></div>'],
  ['data-rule-example false','<pre data-rule-example="false">scope=read</pre>','<pre data-rule-example="false">scope=write</pre>']
])test(`${name} code changes require review and preserve exact text`,()=>{
  const result=classify(html(before),html(after));assert.equal(result.classification,'requires-review');assert.equal(result.reviewRequired,true);
  assert(result.codeChanges.length);assert.notEqual(result.codeChanges[0].before.text,result.codeChanges[0].after.text);assert(result.paths.includes('article-code'));
});

test('labelled example prose is evidence rather than a harmlessness guarantee',()=>{
  const before=html('<div class="example"><p>Retry the original request.</p></div>'),result=classify(before,before.replace('Retry the original request.','Retry the new request.'));
  assert.equal(result.classification,'requires-review');assert.equal(result.reviewRequired,true);assert.equal(result.exampleChanges[0].before.text,'Retry the original request.');
});

test('code added and removed remains visible in the report',()=>{
  const added=classify(html(link),baseline),removed=classify(baseline,html(link));
  assert(added.codeChanges.some(d=>d.classification==='added'&&d.after.language==='yaml'));
  assert(removed.codeChanges.some(d=>d.classification==='removed'&&d.before.text==='order:\n  amount: "1"'));
  assert(added.reviewRequired&&removed.reviewRequired);
});

test('prose whitespace, block formatting and theme changes remain presentation',()=>{
  const before=html('<p>Read the account limits.</p>');
  const after='<article class="theme">\n<h1><span>Account requests</span></h1>\n<p> Keep the original account request key and verify the final result before reporting success. </p>\n<p>Read  the account limits.</p>\n</article>';
  const result=classify(before,after);assert.equal(result.classification,'presentation');assert.equal(result.reviewRequired,false);
});

test('syntax highlighting markup alone does not change code evidence',()=>{
  const before=html('<pre><code>if ready:\n  send()</code></pre>'),after=html('<pre class="highlight"><code class="theme"><span>if ready:</span>\n  <span>send()</span></code></pre>');
  const result=classify(before,after);assert.equal(result.classification,'presentation');assert.deepEqual(result.codeChanges,[]);
});

test('content outside article is excluded except a base URL affecting its links',()=>{
  const result=classify(baseline,'<nav><a href="outside">Outside endpoint</a></nav>'+baseline+'<pre>outside code changed</pre>');
  assert.equal(result.classification,'presentation');assert.deepEqual(result.linkChanges,[]);assert.deepEqual(result.codeChanges,[]);
});

test('prose requirements remain technical and identical HTML remains unchanged',()=>{
  assert.equal(classify(baseline,baseline.replace('original account','new account')).classification,'technical');
  const same=classify(baseline,baseline);assert.equal(same.classification,'unchanged');assert.equal(same.reviewRequired,false);
});

function temp(t){
  const parent=fs.realpathSync(os.tmpdir()),dir=fs.mkdtempSync(path.join(parent,'ex-api-html-'));
  t.after(()=>{const real=fs.realpathSync(dir);if(path.dirname(real)!==parent||!path.basename(real).startsWith('ex-api-html-'))throw Error('Unsafe cleanup');fs.rmSync(real,{recursive:true,force:true});});return dir;
}
const write=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value));};
async function fixture(t,raw=baseline,kind='html',initialFetcher){
  const dir=temp(t),project=path.join(dir,'project'),data=path.join(dir,'data'),distribution=path.join(dir,'distribution');fs.mkdirSync(project);
  const catalog={allowedHosts:['www.exness-api.com'],maxSources:2,sources:[{id:'guide',url:kind==='html'?sourceUrl:'https://www.exness-api.com/openapi/payments.public.yaml',kind,scope:'payments'}]};
  write(path.join(distribution,'catalog/sources.json'),catalog);
  write(path.join(distribution,'catalog/rules.json'),[{id:'PAY-REQUEST-001',kind:'documented',scope:'payments',statement:'Review the account request evidence.',evidence:[{sourceId:'guide',terms:['account','request']}],endpoints:['POST /v1/transfers'],reviewTargets:['client.cjs'],tests:['source HTML regression'],lifecycle:{status:'draft',revision:1,introducedIn:'html-fixture'}}]);
  const ctx=cli.context({'project-root':project,'data-dir':data},{distributionRoot:distribution});
  const candidate=await store.collect(ctx,{fetcher:initialFetcher||(async()=>new Response(raw))}),approval=store.approve(ctx,candidate.candidate,'Offline HTML fixture reviewer');store.pin(ctx,{bundle:approval.version});
  const active=path.join(data,'maintainer-active.json'),pin=path.join(project,'.ex-api-rules.lock.json'),record=path.join(data,'approvals',approval.id+'.json'),artifact=path.join(data,'bundles',approval.artifactSha256+'.json');
  const saved=[active,pin,record,artifact].map(file=>[file,fs.readFileSync(file)]);
  const unchanged=()=>{for(const [file,bytes]of saved)assert(fs.readFileSync(file).equals(bytes),file);};
  return {dir,ctx,distribution,catalog,unchanged};
}

test('check-updates preserves deltas, affected rules and summary without changing active/pin',async t=>{
  const f=await fixture(t);
  for(const [name,raw,classification]of [
    ['href',baseline.replace('next?mode=1#result','other'),'requires-review'],
    ['code',baseline.replace('amount: "1"','amount: "2"'),'requires-review'],
    ['indentation',baseline.replace('  amount','amount'),'requires-review'],
    ['presentation','<nav>Theme only</nav>'+baseline,'presentation'],
    ['outside code',baseline+'<pre>Outside sample</pre>','presentation'],
    ['prose',baseline.replace('original account','new account'),'technical']
  ]){
    const report=await store.checkUpdates(f.ctx,{},async()=>new Response(raw)),change=report.changes[0];
    assert.equal(change.classification,classification,name);assert.equal(report.status,'complete');
    assert.deepEqual(change.affectedRules,['PAY-REQUEST-001']);assert.deepEqual(change.endpoints,['POST /v1/transfers']);
    assert.deepEqual(change.reviewTargets,['client.cjs']);assert.deepEqual(change.tests,['source HTML regression']);
    const required=classification!=='presentation';assert.equal(change.reviewRequired,required);assert.equal(report.summary.reviewRequired,required?1:0);assert.equal(report.summary.nonTechnical,required?0:1);
    if(name==='href')assert.equal(change.linkChanges[0].after.href,'other');
    if(name==='code')assert.match(change.codeChanges[0].after.text,/"2"/);
    assert.equal(report.activeChanged,false);assert.equal(report.projectLockChanged,false);f.unchanged();
  }
  const candidate=await store.collect(f.ctx,{fetcher:async()=>new Response(baseline.replace('amount: "1"','amount: "2"'))});
  assert.equal(candidate.changes[0].classification,'requires-review');assert(candidate.changes[0].codeChanges.length);assert(candidate.approvalRequired);f.unchanged();
});

test('moved source re-resolves relative links even when the snapshot bytes are identical',async t=>{
  const f=await fixture(t),moved='https://www.exness-api.com/payments/core-concepts/fixture';
  const report=await store.checkUpdates(f.ctx,{},async url=>url===sourceUrl?new Response(null,{status:302,headers:{location:moved}}):new Response(baseline));
  const change=report.changes[0];assert.equal(change.classification,'requires-review');assert.equal(change.redirected,true);
  assert.match(change.linkChanges[0].after.resolvedHref,/core-concepts\/next/);assert.equal(change.documentContext.after.url,moved);
  assert.equal(report.summary.reviewRequired,1);assert.equal(report.summary.nonTechnical,0);f.unchanged();
});

test('moved source with unchanged absolute links is still explicitly reviewable',async t=>{
  const raw=baseline.replace('next?mode=1#result','https://www.exness-api.com/payments/guides/next'),f=await fixture(t,raw),moved='https://www.exness-api.com/payments/core-concepts/fixture';
  const report=await store.checkUpdates(f.ctx,{},async url=>url===sourceUrl?new Response(null,{status:302,headers:{location:moved}}):new Response(raw));
  assert.equal(report.changes[0].classification,'source-moved');assert.equal(report.changes[0].reviewRequired,true);assert.equal(report.summary.nonTechnical,0);f.unchanged();
});

test('a redirect already present in the baseline remains unchanged on repeated checks',async t=>{
  const moved='https://www.exness-api.com/payments/core-concepts/fixture';
  const fetcher=async url=>url===sourceUrl?new Response(null,{status:302,headers:{location:moved}}):new Response(baseline);
  const f=await fixture(t,baseline,'html',fetcher);
  for(let repeat=0;repeat<2;repeat++){
    const report=await store.checkUpdates(f.ctx,{},fetcher),change=report.changes[0];
    assert.equal(change.redirected,true);assert.equal(change.finalUrl,moved);assert.equal(change.classification,'unchanged');assert.equal(change.reviewRequired,false);
    assert.equal(report.summary.reviewRequired,0);assert.equal(report.summary.nonTechnical,0);assert.deepEqual(change.linkChanges,[]);f.unchanged();
  }
});

test('fetch/parse failures remain incomplete and source additions/removals require review',async t=>{
  const f=await fixture(t);
  for(const response of [()=>new Response('missing',{status:404}),()=>new Response('<html>challenge</html>')]){
    const report=await store.checkUpdates(f.ctx,{},async()=>response());assert.equal(report.status,'incomplete');assert.equal(report.summary.failed,1);assert.equal(report.summary.reviewRequired,1);assert.equal(report.changes[0].classification,'unavailable-or-unparseable');f.unchanged();
  }
  write(path.join(f.distribution,'catalog/sources.json'),{...f.catalog,sources:[]});
  const removed=await store.checkUpdates(f.ctx,{},async()=>{throw Error('Must not fetch removed catalog');});assert.equal(removed.changes[0].classification,'removed-from-catalog');assert.equal(removed.summary.reviewRequired,1);f.unchanged();
  write(path.join(f.distribution,'catalog/sources.json'),{...f.catalog,sources:[...f.catalog.sources,{...f.catalog.sources[0],id:'new-guide',url:sourceUrl+'-new'}]});
  const added=await store.checkUpdates(f.ctx,{},async()=>new Response(baseline));assert(added.changes.some(c=>c.classification==='new-source'&&c.reviewRequired));assert.equal(added.summary.reviewRequired,1);f.unchanged();
});

test('OpenAPI examples remain review-required rather than hidden in nonTechnical summary',async t=>{
  const document={openapi:'3.1.1',info:{title:'account request fixture',version:'1'},paths:{},components:{schemas:{Payload:{type:'string'}}}},f=await fixture(t,JSON.stringify(document),'openapi');
  document.components.schemas.Payload.examples=['sample'];const report=await store.checkUpdates(f.ctx,{},async()=>new Response(JSON.stringify(document)));
  assert.equal(report.changes[0].classification,'examples');assert.equal(report.changes[0].reviewRequired,true);assert.equal(report.summary.reviewRequired,1);assert.equal(report.summary.nonTechnical,0);f.unchanged();
});

test('discovery resolves HTML base but never fetches link/code content as instructions',async t=>{
  const dir=temp(t),seen=[],catalog={allowedHosts:['www.exness-api.com'],maxSources:2,sources:[{id:'guide',url:sourceUrl,kind:'html',scope:'payments',discover:true}]};
  const initial='<head><base href="/payments/core-concepts/"></head>'+html('<a href="next">Next</a><a href="https://api.exness.com/v1/transfers">Account URL evidence</a><a href="javascript:throw new Error()">Data only</a><pre>throw Error("MUST NOT EXECUTE")</pre>');
  const sources=await fetchSources(catalog,dir,async url=>{seen.push(url);return new Response(url===sourceUrl?initial:html('<p>Final public account request documentation fixture.</p>'));});
  assert.equal(sources.length,2);assert.deepEqual(seen,[sourceUrl,'https://www.exness-api.com/payments/core-concepts/next']);assert(sources.every(s=>s.sha256));
});
