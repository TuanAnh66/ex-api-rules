'use strict';
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),core=require('../packages/core/src/index.cjs'),store=require('../packages/cli/src/store.cjs');
const dist=path.join(root,'dist');fs.mkdirSync(dist,{recursive:true});
const args=process.argv.slice(2);
if(args.includes('--checksums')){
  const names=fs.readdirSync(dist).filter(n=>n!=='SHA256SUMS'&&fs.statSync(path.join(dist,n)).isFile()).sort();
  fs.writeFileSync(path.join(dist,'SHA256SUMS'),names.map(name=>core.hash(fs.readFileSync(path.join(dist,name)))+'  '+name).join('\n')+'\n');
  console.log('Checksummed '+names.length+' release assets.');
}else{
  const index=args.indexOf('--bundle-file');if(args.length&&index<0)throw Error('Unknown release option');if(index>=0&&!args[index+1])throw Error('Missing bundle file');
  const legacy=JSON.parse(fs.readFileSync(path.join(root,'knowledge/exness/active.json')));
  const portable=index>=0?JSON.parse(fs.readFileSync(path.resolve(args[index+1]))):store.portableFromDirectory(path.join(root,'knowledge/exness/versions',legacy.version));
  const verified=core.verifyPortable(portable);if(portable.rules.some(r=>['draft','in_review'].includes(r.lifecycle?.status)))throw Error('Cannot release draft rules');
  const bundleName=index>=0?'exness-bundle-'+portable.manifest.id+'.json':'exness-bundle-v0.1.0.json';
  fs.writeFileSync(path.join(dist,bundleName),core.bundleStringify(portable.manifest,portable)+'\n');
  const contracts={schemaVersion:1,schemas:Object.fromEntries(fs.readdirSync(path.join(root,'schemas')).filter(f=>f.endsWith('.json')).sort().map(f=>[f,JSON.parse(fs.readFileSync(path.join(root,'schemas',f)))])),fixtures:{'protocol-v1.json':require('../tests/fixtures/protocol-v1.json'),'report-protocol-v2.json':require('../tests/fixtures/report-protocol-v2.json')}};
  fs.writeFileSync(path.join(dist,'ex-api-rules-contracts-'+core.VERSION+'.json'),core.stringify(contracts)+'\n');
  let revision='unavailable';try{revision=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();}catch{}
  const metadata={schemaVersion:1,toolVersion:core.VERSION,gitRevision:revision,bundleId:verified.manifest.id,bundleHash:verified.manifest.bundleHash,artifactSha256:verified.artifactSha256,bundleFile:bundleName,ruleCount:verified.rules.length,sourceCount:verified.manifest.sources.length,npmPublished:false};
  fs.writeFileSync(path.join(dist,'release-metadata.json'),JSON.stringify(metadata,null,2)+'\n');
  console.log(JSON.stringify(metadata,null,2));
}
