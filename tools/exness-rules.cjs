#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {readJSON,writeJSON,hash,validator}=require('./exness-rules/core.cjs');
const {layout,loadActive,collect,approve,checkUpdates}=require('./exness-rules/store.cjs');
const {reviewFiles}=require('./exness-rules/review.cjs');
const moduleRoot=path.resolve(__dirname,'..');
function git(projectRoot,args){return execFileSync('git',['-c','safe.directory='+projectRoot,...args],{cwd:projectRoot,encoding:'utf8',maxBuffer:1024*1024});}
function parse(args){const [command,...rest]=args,result={command,files:[]};for(let i=0;i<rest.length;i++){
  const flag=rest[i];if(flag==='--files'){while(rest[i+1]&&!rest[i+1].startsWith('--'))result.files.push(rest[++i]);}
  else if(['--candidate','--reviewed-by','--base','--out','--project-root'].includes(flag)){if(!rest[i+1]||rest[i+1].startsWith('--'))throw Error('Missing value for '+flag);result[flag.slice(2)]=rest[++i];}
  else throw Error('Unknown option '+flag);
}return result;}
function review(rootDir,options,knowledgeRoot=moduleRoot){
  rootDir=fs.realpathSync(path.resolve(rootDir));
  const bundle=loadActive(knowledgeRoot);let files=options.files;
  if(options.base&&files.length)throw Error('Use --base or --files, not both');
  if(options.base){if(options.base.startsWith('-'))throw Error('Invalid base ref');git(rootDir,['rev-parse','--verify',options.base+'^{commit}']);files=[...new Set([...git(rootDir,['diff','--no-ext-diff','--name-only','-z',options.base,'--']).split('\0'),...git(rootDir,['ls-files','--others','--exclude-standard','-z']).split('\0')])].filter(f=>f&&/\.(cjs|mjs|js)$/.test(f)&&fs.existsSync(path.join(rootDir,f)));}
  if(!files.length&&!options.base)throw Error('Specify --files <paths...> or --base <git-ref>');
  const spec=bundle.manifest.sources.find(s=>s.id==='payments-spec'),validate=validator(fs.readFileSync(path.join(bundle.dir,spec.snapshot)),'TransferRequest');
  const cited={...bundle,rules:bundle.rules.map(rule=>({...rule,evidence:rule.evidence.map(e=>{
    const source=bundle.manifest.sources.find(s=>s.id===e.sourceId);
    return source?{...e,url:source.finalUrl||source.url,sha256:source.sha256,snapshot:source.snapshot,fetchedAt:source.fetchedAt}:e;
  })}))};
  const results=reviewFiles(rootDir,files,cited,validate);let latestCheck=null;
  try{const check=readJSON(path.join(layout(knowledgeRoot).cache,'latest-check.json'));if(check.baseline===bundle.active.version)latestCheck={checkedAt:check.checkedAt,status:check.status,summary:check.summary};}catch(e){if(e.code!=='ENOENT')throw e;}
  let head='unavailable';try{head=git(rootDir,['rev-parse','HEAD']).trim();}catch{}
  return {createdAt:new Date().toISOString(),ruleVersion:bundle.active.version,bundleHash:bundle.manifest.bundleHash,codeVersion:{head,files:results.map(r=>({file:r.file,sha256:r.sha256}))},
    sourceFreshness:{mode:'offline-pinned-snapshot',collectedAt:bundle.manifest.collectedAt,latestCheck,latestClaim:false},
    outcome:'PARTIAL_REVIEW_REQUIRES_HUMAN',findings:results.flatMap(r=>r.findings),manualChecks:results.flatMap(r=>r.manual),
    coverage:{automatedFindingsOnly:true,unprovenComplianceIsNotPass:true,ruleCount:bundle.rules.length,automatedCheckTests:[{rules:['COMMON-SIGN-001','PAY-REQUEST-001','PAY-AMOUNT-002','PAY-ACCOUNT-ID-010','PAY-UUID-003','TRADE-HOST-001','TRADE-ACK-002','TRADE-PRECISION-005','OBS-TRANSFER-ID-002'],file:'tests/exness-rules.test.cjs',test:'review detects wrong signed body/path, wrong host, retry UUID, ACK finality and precision'}]},
    conflicts:cited.rules.filter(r=>r.conflictsWith).map(r=>({ruleId:r.id,conflictsWith:r.conflictsWith,evidence:r.evidence})),
    limitations:['Static analysis does not prove data flow, live eligibility, instrument precision or runtime safety.','No reviewed source code is imported or executed.','Inference rules are not conformance requirements.']};
}
async function main(args,{defaultProjectRoot=process.cwd()}={}){
  const options=parse(args);let result;
  if(options['project-root']&&options.command!=='review')throw Error('--project-root applies only to review');
  const projectRoot=path.resolve(options['project-root']||defaultProjectRoot);
  if(options.command==='collect')result=await collect(moduleRoot);
  else if(options.command==='approve')result=approve(moduleRoot,options.candidate,options['reviewed-by']);
  else if(options.command==='check-updates'){const report=await checkUpdates(moduleRoot);result={id:report.id,baseline:report.baseline,status:report.status,summary:report.summary,changes:report.changes.filter(c=>c.classification!=='unchanged'),activeChanged:false};if(report.status==='incomplete')process.exitCode=2;}
  else if(options.command==='review'){result=review(projectRoot,options);if(result.findings.some(f=>f.severity==='P1'))process.exitCode=1;}
  else throw Error('Usage: collect | check-updates | approve --candidate ID --reviewed-by NAME | review [--project-root PATH] (--files PATH... | --base REF) [--out .cache/exness-rules/report.json]');
  if(options.out){const outRoot=options.command==='review'?projectRoot:moduleRoot;const target=path.resolve(outRoot,options.out),cache=path.join(outRoot,'.cache/exness-rules');if(!target.startsWith(cache+path.sep))throw Error('--out must be inside .cache/exness-rules/');writeJSON(target,result);}
  console.log(JSON.stringify(result,null,2));
}
module.exports={parse,review,main};
if(require.main===module)main(process.argv.slice(2)).catch(e=>{console.error(e.message);process.exitCode=2;});
