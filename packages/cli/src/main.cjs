'use strict';
const fs=require('node:fs'),path=require('node:path');
const core=require('ex-api-rules-core'),legacy=require('./legacy-core.cjs'),store=require('./store.cjs');
const {reviewFiles}=require('./review-files.cjs');
const writes=require('./write-path.cjs');
const {createGit}=require('./git.cjs');
const packageRoot=path.resolve(__dirname,'..');
function parse(args){
  const [command,...rest]=args,result={command,files:[]};
  if(command==='bundle')result.action=rest.shift();
  for(let i=0;i<rest.length;i++){
    const flag=rest[i];
    if(flag==='--files'){while(rest[i+1]&&!rest[i+1].startsWith('--'))result.files.push(rest[++i]);}
    else if(['--candidate','--reviewed-by','--base','--out','--project-root','--data-dir','--bundle','--profile','--file','--format','--checksum'].includes(flag)){
      if(!rest[i+1]||rest[i+1].startsWith('--'))throw Error('Missing value for '+flag);result[flag.slice(2)]=rest[++i];
    }else throw Error('Unknown option '+flag);
  }
  return result;
}
function context(options={},defaults={}){
  const distributionRoot=fs.realpathSync(path.resolve(defaults.distributionRoot||packageRoot)),projectRoot=fs.realpathSync(path.resolve(options['project-root']||defaults.defaultProjectRoot||process.cwd()));
  const dataDir=writes.assertRuntimePath(options['data-dir']||store.defaultDataDir(),{forbiddenRoots:[distributionRoot,packageRoot]});
  return {projectRoot,distributionRoot,store:store.createStore(dataDir)};
}
function review(root,options={},distributionRoot=packageRoot){
  const ctx=context({...options,'project-root':root},{distributionRoot}),{bundle,lock,profile}=store.selectBundle(ctx,options);
  const git=createGit(ctx.projectRoot);
  let files=options.files||[];
  if(options.base&&files.length)throw Error('Use --base or --files, not both');
  const excluded=[];
  if(options.base){
    if(options.base.startsWith('-'))throw Error('Invalid base ref');git(['rev-parse','--verify',options.base+'^{commit}']);
    files=[...new Set([...git(['diff','--no-ext-diff','--no-textconv','--name-only','-z',options.base,'--']).split('\0'),...git(['ls-files','--others','--exclude-standard','-z']).split('\0')])].filter(file=>{
      if(!file||!fs.existsSync(path.join(root,file))||!fs.statSync(path.join(root,file)).isFile())return false;
      try{legacy.publicFile(root,file);return true;}catch{excluded.push({file,reason:'Excluded private/external path; not read or analyzed.'});return false;}
    });
  }
  if(!files.length&&!options.base)throw Error('Specify --files <paths...> or --base <git-ref>');
  files=[...new Set(files.map(f=>f.replace(/\\/g,'/')))].sort();
  const rules=core.selectRules(bundle.rules,profile).map(rule=>({...rule,evidence:rule.evidence.map(e=>{const s=bundle.manifest.sources.find(s=>s.id===e.sourceId);return s?{...e,url:s.finalUrl||s.url,sha256:s.sha256,snapshot:s.snapshot,fetchedAt:s.fetchedAt}:e;})}));
  const spec=bundle.manifest.sources.find(s=>s.id==='payments-spec');
  const validate=spec?legacy.validator(core.decodeBlob(bundle.portable.blobs[spec.sha256]),'TransferRequest'):()=>true;
  const results=reviewFiles(ctx.projectRoot,files,{rules},validate);
  let head='unavailable';try{head=git(['rev-parse','HEAD']).trim();}catch{}
  let latestCheck=null;try{const check=legacy.readJSON(path.join(ctx.store.root,'cache','latest-'+bundle.artifactSha256+'.json'));latestCheck={checkedAt:check.checkedAt,status:check.status,summary:check.summary};}catch(e){if(e.code!=='ENOENT')throw e;}
  const registry=legacy.readJSON(path.join(store.resources(distributionRoot).catalog,'checks.json'));
  const ruleVersion=bundle.manifest.bundleHash===store.LEGACY_HASH?'v-'+bundle.manifest.id+'-'+bundle.manifest.bundleHash.slice(0,12):bundle.manifest.id;
  const report={schemaVersion:1,createdAt:new Date().toISOString(),toolVersion:core.VERSION,ruleVersion,bundleId:bundle.manifest.id,bundleHash:bundle.manifest.bundleHash,artifactSha256:bundle.artifactSha256,bundleCanonicalization:bundle.manifest.canonicalization||'ecmascript-v0',fingerprintCanonicalization:'utf16-v1',profile,projectLock:lock?'pinned':'legacy-compatibility-unlocked',
    codeVersion:{head,files:results.map(r=>({file:r.file,sha256:r.sha256,adapter:r.adapter}))},
    sourceFreshness:{mode:'offline-pinned-snapshot',collectedAt:bundle.manifest.collectedAt,latestCheck,latestClaim:false},
    outcome:'PARTIAL_REVIEW_REQUIRES_HUMAN',findings:results.flatMap(r=>r.findings),manualChecks:[...excluded,...results.flatMap(r=>r.manual)],
    coverage:{automatedFindingsOnly:true,unprovenComplianceIsNotPass:true,ruleCount:rules.length,excludedRules:bundle.rules.filter(r=>!rules.some(x=>x.id===r.id)).map(r=>({id:r.id,kind:r.kind,status:r.lifecycle?.status||'legacy',reason:'Outside profile or not an approved conformance requirement'})),checks:registry,unsupportedFiles:results.filter(r=>r.adapter==='unsupported').map(r=>r.file)},
    conflicts:rules.filter(r=>r.conflictsWith).map(r=>({ruleId:r.id,conflictsWith:r.conflictsWith,evidence:r.evidence})),
    limitations:['Static analysis does not prove data flow, live eligibility, precision or runtime safety.','Reviewed code is never imported or executed.','Unsupported files and rules without checks require human review.','Only documented P1 findings affect the review exit code; observations require scoped interpretation.']};
  report.resultFingerprint=core.hash(core.stringify({toolVersion:report.toolVersion,ruleVersion:report.ruleVersion,bundleHash:report.bundleHash,artifactSha256:report.artifactSha256,profile,codeVersion:report.codeVersion,findings:report.findings,manualChecks:report.manualChecks}));
  return core.validate('report',report);
}
function outputPath(ctx,relative){
  const target=path.resolve(ctx.projectRoot,relative),cache=path.join(ctx.projectRoot,'.cache/exness-rules');
  return writes.assertRuntimePath(target,{allowedRoots:[cache,ctx.store.root],forbiddenRoots:[ctx.distributionRoot,packageRoot]});
}
async function main(args,defaults={}){
  const options=parse(args);
  if(options.command==='--version'){console.log(core.VERSION);return core.VERSION;}
  if(!options.command||options.command==='--help'){const help='collect | check-updates | approve --candidate ID --reviewed-by NAME | pin [--bundle ID] | review (--files PATH... | --base REF) | bundle import|export|verify --file PATH\nCommon: --project-root PATH --data-dir PATH --profile default|payments|trading --out .cache/exness-rules/report.json; review: --format json|sarif';console.log(help);return help;}
  const ctx=context(options,defaults);let result;
  if(options.command==='collect')result=await store.collect(ctx);
  else if(options.command==='approve')result=store.approve(ctx,options.candidate,options['reviewed-by']);
  else if(options.command==='check-updates'){result=await store.checkUpdates(ctx,options);if(result.status==='incomplete')process.exitCode=2;}
  else if(options.command==='pin'){
    if(store.within(ctx.distributionRoot,ctx.projectRoot)||store.within(packageRoot,ctx.projectRoot))throw Error('Pin a consuming project, not the installed tool');result=store.pin(ctx,options);
  }else if(options.command==='review'){
    result=review(ctx.projectRoot,options,ctx.distributionRoot);
    if(result.findings.some(f=>f.kind==='documented'&&f.severity==='P1'))process.exitCode=1;
    if(options.format&&options.format!=='json'&&options.format!=='sarif')throw Error('Unknown report format');
    if(options.format==='sarif')result=core.toSarif(result);
  }else if(options.command==='bundle'){
    if(!options.file)throw Error('Missing --file');const file=path.resolve(ctx.projectRoot,options.file);
    if(options.action==='export'){
      const {bundle}=store.selectBundle(ctx,options);const target=outputPath(ctx,options.file);store.atomic(target,bundle.portable);result={file:target,artifactSha256:bundle.artifactSha256,fileSha256:core.hash(fs.readFileSync(target))};
    }else if(['import','verify'].includes(options.action)){
      const bytes=fs.readFileSync(file);if(options.checksum&&core.hash(bytes)!==options.checksum)throw Error('Release file checksum mismatch');const portable=JSON.parse(bytes),verified=core.verifyPortable(portable);
      if(options.action==='import')ctx.store.importBundle(portable);
      result={id:verified.manifest.id,bundleHash:verified.manifest.bundleHash,artifactSha256:verified.artifactSha256,imported:options.action==='import'};
    }else throw Error('Unknown bundle action');
  }else throw Error('Unknown command; use --help');
  if(options.out)store.atomic(outputPath(ctx,options.out),result);
  console.log(JSON.stringify(result,null,2));return result;
}
module.exports={parse,context,review,main,outputPath};
