'use strict';
// Install the actual tarballs in a fresh project, without ancestor workspace dependencies.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{execFileSync,spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),dist=path.join(root,'dist'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'ex-api-package-'));
const version=require('../packages/core/src/index.cjs').VERSION;
const npmCli=process.env.EX_API_RULES_NPM_CLI||path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
function invoke(args,cwd,env=process.env){const r=spawnSync(process.execPath,args,{cwd,encoding:'utf8',env,timeout:120000});if(r.status!==0)throw Error(r.error?.message||r.stderr||r.stdout||'Process failed');return r.stdout;}
try{
  fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({name:'portable-consumer-fixture',version:'1.0.0',private:true}));
  const tarballs=['ex-api-rules-core-'+version+'.tgz','ex-api-rules-'+version+'.tgz'].map(f=>path.join(dist,f));
  for(const file of tarballs){const listing=execFileSync('tar',['-tzf',file],{encoding:'utf8'});if(/(?:knowledge\/|versions\/|\.env|\.pem|\.key|\.git\/|\.cache\/)/.test(listing))throw Error('Unexpected private/legacy files in package');}
  if(fs.existsSync(npmCli))invoke([npmCli,'install','--ignore-scripts','--no-audit','--no-fund',...tarballs],dir);
  else{const pnpm=process.env.npm_execpath;if(!pnpm)throw Error('Set EX_API_RULES_NPM_CLI to npm-cli.js for package smoke test');fs.writeFileSync(path.join(dir,'pnpm-workspace.yaml'),'overrides:\n  ex-api-rules-core: '+JSON.stringify('file:'+tarballs[0].replace(/\\/g,'/'))+'\n');invoke([pnpm,'add','--ignore-scripts',...tarballs],dir);}
  console.log('Installed tarballs; checking read-only offline operations.');
  const installRoot=path.join(dir,'node_modules'),bin=path.join(installRoot,'ex-api-rules/bin/ex-api-rules.cjs'),data=path.join(dir,'state');
  const guard=path.join(dir,'readonly.cjs');
  fs.writeFileSync(guard,`const fs=require('node:fs'),path=require('node:path');const protectedRoot=${JSON.stringify(installRoot)};function check(p){if(typeof p!=='string'&&!Buffer.isBuffer(p))return;const r=path.relative(protectedRoot,path.resolve(String(p)));if(r===''||(!r.startsWith('..')&&!path.isAbsolute(r)))throw Error('WRITE TO READ-ONLY INSTALL: '+p);}for(const name of ['writeFileSync','appendFileSync','mkdirSync','unlinkSync','rmSync','renameSync','copyFileSync']){const original=fs[name];fs[name]=function(...args){check(args[name==='copyFileSync'?1:0]);if(name==='renameSync')check(args[1]);return original.apply(this,args);};}const original=fs.openSync;fs.openSync=function(p,flags,...args){if(typeof flags==='number'||/[wa+]/.test(flags))check(p);return original.call(this,p,flags,...args);};`);
  function snapshot(){const files=[];function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,entry.name);if(entry.isSymbolicLink())continue;if(entry.isDirectory())walk(p);else if(entry.isFile())files.push([path.relative(installRoot,p),require('node:crypto').createHash('sha256').update(fs.readFileSync(p)).digest('hex')]);}}walk(installRoot);return files.sort();}
  const before=JSON.stringify(snapshot()),env={...process.env,EX_API_RULES_DATA_DIR:data};
  const run=args=>JSON.parse(invoke(['--require',guard,bin,...args],dir,env));
  const imported=run(['bundle','import','--file',path.join(dist,'exness-bundle-v0.1.0.json')]);run(['pin','--bundle',imported.id]);
  fs.writeFileSync(path.join(dir,'client.cjs'),"const body={destination_type:'own_account',source_account:'90000000001',destination_account:'90000000002',amount:'600'};\n");
  const report=run(['review','--files','client.cjs','--out','.cache/exness-rules/report.json']);
  if(report.projectLock!=='pinned'||report.toolVersion!==version||report.findings.length)throw Error('Packed review metadata/behavior mismatch');
  if(JSON.stringify(snapshot())!==before)throw Error('Installation was mutated');
  console.log('Both release tarballs installed independently; pinned offline review succeeded with read-only installation guard.');
}finally{if(!path.basename(dir).startsWith('ex-api-package-')||path.dirname(dir)!==os.tmpdir())throw Error('Unsafe temporary cleanup');fs.rmSync(dir,{recursive:true,force:true});}
