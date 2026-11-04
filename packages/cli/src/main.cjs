'use strict';
const fs=require('node:fs'),path=require('node:path');
const core=require('ex-api-rules-core'),legacy=require('./legacy-core.cjs'),store=require('./store.cjs');
const {reviewFiles,reviewPolicy}=require('./review-files.cjs');
const writes=require('./write-path.cjs');
const {createGit}=require('./git.cjs');
const packageRoot=path.resolve(__dirname,'..');
function parse(args){
  const [command,...rest]=args,result={command,files:[]};
  if(command==='bundle')result.action=rest.shift();
  for(let i=0;i<rest.length;i++){
    const flag=rest[i];
    if(flag==='--files'){while(rest[i+1]&&!rest[i+1].startsWith('--'))result.files.push(rest[++i]);}
    else if(['--candidate','--reviewed-by','--base','--out','--project-root','--data-dir','--bundle','--profile','--file','--format','--checksum','--max-file-bytes','--max-total-bytes'].includes(flag)){
      if(!rest[i+1]||rest[i+1].startsWith('--'))throw Error('Missing value for '+flag);result[flag.slice(2)]=rest[++i];
    }else throw Error('Unknown option '+flag);
  }
  if(result['max-file-bytes']!==undefined||result['max-total-bytes']!==undefined){
    if(command!=='review')throw Error('Byte budget options apply only to review');
    reviewPolicy(result);
  }
  return result;
}
function context(options={},defaults={}){
  const distributionRoot=fs.realpathSync(path.resolve(defaults.distributionRoot||packageRoot)),projectRoot=fs.realpathSync(path.resolve(options['project-root']||defaults.defaultProjectRoot||process.cwd()));
  const dataDir=writes.assertRuntimePath(options['data-dir']||store.defaultDataDir(),{forbiddenRoots:[distributionRoot,packageRoot]});
  return {projectRoot,distributionRoot,store:store.createStore(dataDir)};
}
function coverageReport(rules, allRules, registry, results) {
  const selected = new Set(rules.map(rule => rule.id));
  const checkApplicability = results.flatMap(file => registry.map(check => {
    const ruleIds = check.ruleIds.filter(id => selected.has(id));
    let execution;
    if (!ruleIds.length) execution = {status: 'not-applicable', reason: 'No selected rules map to this registry check.'};
    else if (file.analysisStatus !== 'analyzed') execution = {status: 'not-run', reason: 'File is ' + file.analysisStatus + '; no adapter/check analysis completed.'};
    else execution = file.checkRuns.find(entry => entry.checkId === check.id) || {status: 'not-run', reason: 'The adapter did not implement this registry check.'};
    return {file: file.file, checkId: check.id, ruleIds, status: execution.status, reason: execution.reason};
  }));
  return {
    measurement: 'selected-rule-inventory-only', automatedFindingsOnly: true, unprovenComplianceIsNotPass: true,
    ruleCount: rules.length,
    selectedRules: rules.map(rule => ({id: rule.id, kind: rule.kind, scope: rule.scope, status: rule.lifecycle?.status || 'legacy'})),
    excludedRules: allRules.filter(rule => !selected.has(rule.id)).map(rule => ({id: rule.id, kind: rule.kind, scope: rule.scope, status: rule.lifecycle?.status || 'legacy', reason: 'Outside profile or not an approved conformance requirement'})),
    checks: registry, checkApplicability,
    unsupportedFiles: results.filter(file => file.adapter === 'unsupported' && !['excluded','missing','not-regular'].includes(file.analysisStatus)).map(file => file.file),
    parseFailedFiles: results.filter(file => file.analysisStatus === 'parse-failed').map(file => file.file),
    unanalyzedFiles: results.filter(file => file.analysisStatus !== 'analyzed').map(file => file.file)
  };
}

function review(root, options = {}, distributionRoot = packageRoot) {
  const inputPolicy = reviewPolicy(options);
  const ctx = context({...options, 'project-root': root}, {distributionRoot});
  const {bundle, lock, profile} = store.selectBundle(ctx, options), git = createGit(ctx.projectRoot);
  let files = options.files || [];
  if (options.base && files.length) throw Error('Use --base or --files, not both');
  if (options.base) {
    if (options.base.startsWith('-')) throw Error('Invalid base ref');
    git(['rev-parse', '--verify', options.base + '^{commit}']);
    files = [...git(['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', options.base, '--']).split('\0'),
      ...git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0')].filter(Boolean);
  }
  if (!files.length && !options.base) throw Error('Specify --files <paths...> or --base <git-ref>');
  const rules = core.selectRules(bundle.rules, profile).map(rule => ({...rule, evidence: rule.evidence.map(evidence => {
    const source = bundle.manifest.sources.find(source => source.id === evidence.sourceId);
    return source ? {...evidence, url: source.finalUrl || source.url, sha256: source.sha256, snapshot: source.snapshot, fetchedAt: source.fetchedAt || null} : evidence;
  })}));
  const spec = bundle.manifest.sources.find(source => source.id === 'payments-spec');
  const validate = spec ? legacy.validator(core.decodeBlob(bundle.portable.blobs[spec.sha256]), 'TransferRequest') : null;
  const results = reviewFiles(ctx.projectRoot, files, {rules}, validate, options);
  let head = 'unavailable'; try { head = git(['rev-parse', 'HEAD']).trim(); } catch {}
  let latestCheck = null;
  try {
    const check = legacy.readJSON(path.join(ctx.store.root, 'cache', 'latest-' + bundle.artifactSha256 + '.json'));
    latestCheck = {checkedAt: check.checkedAt, status: check.status, summary: check.summary};
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const registry = legacy.readJSON(path.join(store.resources(distributionRoot).catalog, 'checks.json'));
  const ruleVersion = bundle.manifest.bundleHash === store.LEGACY_HASH ? 'v-' + bundle.manifest.id + '-' + bundle.manifest.bundleHash.slice(0, 12) : bundle.manifest.id;
  const report = {
    schemaVersion: 2, createdAt: new Date().toISOString(), toolVersion: core.VERSION, ruleVersion,
    bundleId: bundle.manifest.id, bundleHash: bundle.manifest.bundleHash, artifactSha256: bundle.artifactSha256,
    bundleCanonicalization: bundle.manifest.canonicalization || 'ecmascript-v0', fingerprintCanonicalization: 'utf16-v1',
    profile, projectLock: lock ? 'pinned' : 'legacy-compatibility-unlocked', inputPolicy,
    codeVersion: {head, headStatus: head === 'unavailable' ? 'unavailable' : 'available', files: results.map(file => {
      const {findings, manual, coverage, checkRuns, ...metadata} = file; return metadata;
    })},
    sourceFreshness: {mode: 'offline-pinned-snapshot', collectedAt: bundle.manifest.collectedAt || null, latestCheck, latestClaim: false},
    outcome: 'PARTIAL_REVIEW_REQUIRES_HUMAN', findings: results.flatMap(file => file.findings),
    manualChecks: results.flatMap(file => file.manual.map(item => ({file: item.file, line: item.line ?? null, ruleId: item.ruleId ?? null, reason: item.reason,
      category: file.analysisStatus === 'analyzed' ? 'behavior-review' : file.analysisStatus === 'excluded' ? 'excluded' : 'unanalyzed'}))),
    coverage: coverageReport(rules, bundle.rules, registry, results),
    conflicts: rules.filter(rule => rule.conflictsWith).map(rule => ({ruleId: rule.id, conflictsWith: rule.conflictsWith, evidence: rule.evidence})),
    limitations: ['Static analysis does not prove data flow, live eligibility, precision or runtime safety.',
      'Reviewed code is never imported or executed.', 'Unanalyzed files and rules without completed checks require human review.',
      'File metadata checks detect observed changes; they do not provide an OS snapshot or concurrent replacement guarantee.',
      'A null hash cannot establish content identity; byte budgets and observed inputs are part of the fingerprint.',
      'Only documented P1 findings affect the review exit code; observations require scoped interpretation.']
  };
  report.resultFingerprint = core.reportFingerprint(report);
  return core.validate('report', report);
}
function outputPath(ctx,relative){
  const target=path.resolve(ctx.projectRoot,relative),cache=path.join(ctx.projectRoot,'.cache/exness-rules');
  return writes.assertRuntimePath(target,{allowedRoots:[cache,ctx.store.root],forbiddenRoots:[ctx.distributionRoot,packageRoot]});
}
async function main(args,defaults={}){
  const options=parse(args);
  if(options.command==='--version'){console.log(core.VERSION);return core.VERSION;}
  if(!options.command||options.command==='--help'){const help='collect | check-updates | approve --candidate ID --reviewed-by NAME | pin [--bundle ID] | review (--files PATH... | --base REF) | bundle import|export|verify --file PATH\nCommon: --project-root PATH --data-dir PATH --profile default|payments|trading --out .cache/exness-rules/report.json; review: --format json|sarif --max-file-bytes N --max-total-bytes N\nReview emits report v2. Defaults: 1048576 bytes/file, 16777216 bytes/run; all outcomes require human review.';console.log(help);return help;}
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
