'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync,execFileSync}=require('node:child_process');
const {gitEnvironment,assertSupportedGitVersion}=require('../packages/cli/src/git.cjs');
const root=path.resolve(__dirname,'..'),entry=path.join(root,'tools/exness-rules.cjs');
const legacyHash='e3a79f510ff6364440e5e7d9832f48c9f5ee99ceee5f62e73905d1fe8c0b4e37';

function fixture(t){
  const parent=fs.realpathSync(os.tmpdir()),dir=fs.mkdtempSync(path.join(parent,'ex-api-boundary-'));
  t.after(()=>{const real=fs.realpathSync(dir);if(path.dirname(real)!==parent||!path.basename(real).startsWith('ex-api-boundary-'))throw Error('Unsafe cleanup');fs.rmSync(real,{recursive:true,force:true});});
  const project=path.join(dir,'project'),data=path.join(dir,'data'),guard=path.join(dir,'offline.cjs');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project,'client.cjs'),"module.exports = 'sanitized fixture';\n");
  fs.writeFileSync(guard,"const deny=()=>{throw Error('OFFLINE_FIXTURE_NETWORK_BLOCKED');};globalThis.fetch=deny;for(const id of ['node:net','node:tls','node:http','node:https','node:dns']){const m=require(id);for(const k of ['connect','createConnection','request','get','lookup','resolve'])if(typeof m[k]==='function')m[k]=deny;if(m.Socket)m.Socket.prototype.connect=deny;}\n");
  return {dir,project,data,guard,env:gitEnvironment()};
}
function git(f,args,env=f.env){return execFileSync('git',['-c','safe.directory='+f.project,...args],{cwd:f.project,env,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();}
function gitProject(f){
  const template=path.join(f.dir,'empty-template');fs.mkdirSync(template,{recursive:true});
  git(f,['init','-b','main','--template='+template]);
  fs.writeFileSync(path.join(f.project,'.gitignore'),'.cache/\n');
  git(f,['add','--','client.cjs','.gitignore']);
  git(f,['-c','user.name=Offline Fixture','-c','user.email=offline@example.invalid','commit','-m',path.basename(f.dir)]);
  const head=git(f,['rev-parse','HEAD']);
  fs.appendFileSync(path.join(f.project,'client.cjs'),'// changed tracked fixture\n');
  fs.writeFileSync(path.join(f.project,'extra.cjs'),"module.exports = 'untracked fixture';\n");
  fs.writeFileSync(path.join(f.project,'unsupported.py'),"raise RuntimeError('MUST NOT EXECUTE')\n");
  return head;
}
function cli(f,args,{env={},project=f.project,preload}={}){
  const nodeArgs=['--require',f.guard];if(preload)nodeArgs.push('--require',preload);
  return spawnSync(process.execPath,[...nodeArgs,entry,'review','--project-root',project,'--data-dir',f.data,...args],{cwd:f.dir,env:{...f.env,...env},encoding:'utf8',timeout:60000,windowsHide:true,maxBuffer:8*1024*1024});
}
function report(result){
  assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);
  const value=JSON.parse(result.stdout);assert.equal(value.bundleHash,legacyHash);assert.equal(value.sourceFreshness.latestClaim,false);return value;
}
function link(t,target,alias,type){
  try{fs.symlinkSync(target,alias,type);return true;}
  catch(e){if(!['EPERM','EACCES','ENOTSUP'].includes(e.code))throw e;t.skip('Filesystem links unavailable: '+e.code);return false;}
}
const hash=file=>require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('Git invocation isolates caller configuration without changing the parent environment',()=>{
  const source={PATH:'fixture-path',FIXTURE_MARKER:'keep',GIT_DIR:'other',Git_work_tree:'other',GIT_INDEX_FILE:'other',GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'core.fsmonitor',GIT_CONFIG_VALUE_0:'hook',GIT_CONFIG_GLOBAL:'other'};
  const original={...source},env=gitEnvironment(source);assert.deepEqual(source,original);
  assert.equal(env.FIXTURE_MARKER,'keep');assert.equal(env.PATH,'fixture-path');
  for(const key of ['GIT_DIR','Git_work_tree','GIT_INDEX_FILE','GIT_CONFIG_COUNT','GIT_CONFIG_KEY_0','GIT_CONFIG_VALUE_0'])assert.equal(env[key],undefined);
  assert.equal(env.GIT_CONFIG_GLOBAL,'/dev/null');assert.equal(env.GIT_CONFIG_NOSYSTEM,'1');
});

test('Git version policy rejects historical fsmonitor boolean ambiguity and unknown output',()=>{
  for(const value of ['git version 2.35.1','git version 2.26.0','git version 1.9.0','unexpected output'])assert.throws(()=>assertSupportedGitVersion(value),/Git 2.36/);
  for(const value of ['git version 2.36.0','git version 2.53.0.windows.3','git version 2.39.3 (Apple Git-146)','git version 3.0.0'])assert.doesNotThrow(()=>assertSupportedGitVersion(value));
});

test('CLI rejects unsupported Git before any target inspection command',t=>{
  const f=fixture(t),preload=path.join(f.dir,'old-git.cjs');
  fs.writeFileSync(preload,"const cp=require('node:child_process'),original=cp.execFileSync;cp.execFileSync=function(file,args,...rest){if(file==='git'){if(args.length===1&&args[0]==='--version')return 'git version 2.35.1\\n';throw Error('TARGET_GIT_COMMAND_EXECUTED');}return original.call(this,file,args,...rest);};\n");
  const result=cli(f,['--files','client.cjs'],{preload});assert.equal(result.status,2,result.stderr);assert.match(result.stderr,/Git 2.36/);assert.doesNotMatch(result.stderr,/TARGET_GIT_COMMAND_EXECUTED/);assert.equal(result.stdout,'');
});

test('CLI base review keeps tracked and untracked coverage without importing unsupported files',t=>{
  const f=fixture(t),head=gitProject(f),value=report(cli(f,['--base','HEAD']));
  assert.equal(value.codeVersion.head,head);assert.deepEqual(value.codeVersion.files.map(f=>f.file),['client.cjs','extra.cjs','unsupported.py']);
  assert.deepEqual(value.coverage.unsupportedFiles,['unsupported.py']);assert(value.manualChecks.some(c=>c.file==='unsupported.py'));
});

test('CLI review never executes target or caller-configured fsmonitor commands',async t=>{
  for(const source of ['local','include','global','environment'])await t.test(source,t=>{
    const f=fixture(t),head=gitProject(f),hook=path.join(f.dir,'marker-hook'),marker=path.join(f.dir,'marker.txt'),config=path.join(f.dir,'fixture-gitconfig');
    fs.writeFileSync(hook,"#!/bin/sh\nprintf 'marker\\n' >> \"$FIXTURE_MARKER\"\nprintf 'fixture-token\\000/\\000'\n");fs.chmodSync(hook,0o700);
    fs.writeFileSync(config,'[core]\n\tfsmonitor = '+JSON.stringify(hook.replace(/\\/g,'/'))+'\n');
    const env={...f.env,FIXTURE_MARKER:marker};
    if(source==='local')git(f,['config','--local','core.fsmonitor',hook.replace(/\\/g,'/')]);
    if(source==='include')git(f,['config','--local','include.path',config.replace(/\\/g,'/')]);
    if(source==='global')env.GIT_CONFIG_GLOBAL=config;
    if(source==='environment')Object.assign(env,{GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'core.fsmonitor',GIT_CONFIG_VALUE_0:hook.replace(/\\/g,'/')});
    // Positive fixture control: the actual Git executable must invoke this hook.
    git(f,['diff','--no-ext-diff','--name-only','HEAD','--'],env);assert(fs.existsSync(marker),'Marker hook control did not run');fs.unlinkSync(marker);
    const value=report(cli(f,['--base','HEAD'],{env}));assert.equal(value.codeVersion.head,head);assert.deepEqual(value.codeVersion.files.map(f=>f.file),['client.cjs','extra.cjs','unsupported.py']);assert(!fs.existsSync(marker),'Review executed fsmonitor');
    report(cli(f,['--files','client.cjs'],{env}));assert(!fs.existsSync(marker),'Explicit-file review executed fsmonitor');
  });
});

test('CLI targets project-root despite inherited Git repository and index selectors',t=>{
  const f=fixture(t),head=gitProject(f),other=path.join(f.dir,'other');fs.mkdirSync(other);
  const otherFixture={...f,project:other};fs.writeFileSync(path.join(other,'client.cjs'),"module.exports = 'other';\n");gitProject(otherFixture);
  const env={GIT_DIR:path.join(other,'.git'),GIT_WORK_TREE:other,GIT_INDEX_FILE:path.join(other,'.git','index')};
  const value=report(cli(f,['--base','HEAD'],{env}));assert.equal(value.codeVersion.head,head);
  assert.equal(value.codeVersion.files.find(x=>x.file==='client.cjs').sha256,hash(path.join(f.project,'client.cjs')));
});

test('CLI writes ordinary cache and external-store reports with matching JSON',t=>{
  const f=fixture(t);
  for(const out of ['.cache/exness-rules/new/report.json',path.join(f.data,'reports','review.json')]){
    const value=report(cli(f,['--files','client.cjs','--out',out]));assert.deepEqual(JSON.parse(fs.readFileSync(path.resolve(f.project,out))),value);
  }
});

test('CLI rejects output path escapes before modifying linked destinations',async t=>{
  for(const type of ['traversal','junction','directory-symlink','nested-junction','existing-outside-report','leaf','dangling-leaf'])await t.test(type,t=>{
    const f=fixture(t),outside=path.join(f.dir,'outside'),cache=path.join(f.project,'.cache','exness-rules');fs.mkdirSync(outside);fs.mkdirSync(path.dirname(cache));
    const sentinel=path.join(outside,'report.json');fs.writeFileSync(sentinel,'sanitized outside sentinel\n');const before=hash(sentinel);
    let out='.cache/exness-rules/report.json',alias=null,external=sentinel;
    if(type==='traversal')out=sentinel;
    else if(type==='junction'||type==='directory-symlink'||type==='existing-outside-report'){
      alias=cache;if(!link(t,outside,alias,type==='directory-symlink'?'dir':process.platform==='win32'?'junction':'dir'))return;
    }else if(type==='nested-junction'){
      fs.mkdirSync(cache);alias=path.join(cache,'nested');if(!link(t,outside,alias,process.platform==='win32'?'junction':'dir'))return;out='.cache/exness-rules/nested/report.json';
    }else{
      fs.mkdirSync(cache);alias=path.join(cache,'report.json');if(type==='dangling-leaf')external=path.join(outside,'missing.json');if(!link(t,external,alias,'file'))return;
    }
    // Exercise a missing descendant as well as an already existing outside file.
    if(type==='junction'||type==='directory-symlink'||type==='nested-junction')out=out.replace('report.json','new/report.json');
    const result=cli(f,['--files','client.cjs','--out',out]);assert.equal(result.status,2,result.stderr);assert.match(result.stderr,/link|outside|Dangling|ENOENT/);
    assert.equal(result.stdout,'');assert.equal(hash(sentinel),before);assert.deepEqual(fs.readdirSync(outside),['report.json']);
    if(alias)assert(fs.lstatSync(alias).isSymbolicLink(),'Rejected output must preserve the link');
    if(type==='dangling-leaf')assert(!fs.existsSync(external));
    assert(!fs.existsSync(path.join(outside,'new')),'Rejected output created an outside parent');
  });
});

test('CLI accepts a canonicalized project alias and a conventional Git worktree',t=>{
  const f=fixture(t),head=gitProject(f),alias=path.join(f.dir,'project-alias');
  if(!link(t,f.project,alias,process.platform==='win32'?'junction':'dir'))return;
  const out='.cache/exness-rules/report.json',value=report(cli(f,['--files','client.cjs','--out',out],{project:alias}));assert.equal(value.codeVersion.head,head);assert(fs.existsSync(path.join(f.project,out)));
  const worktree=path.join(f.dir,'worktree');git(f,['worktree','add','--detach',worktree,'HEAD']);
  const second=report(cli(f,['--files','client.cjs','--out',out],{project:worktree}));assert.equal(second.codeVersion.head,head);assert(fs.existsSync(path.join(worktree,out)));
});

test('CLI refuses output in a synthetic submodule checkout',t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.project,'.git'),'gitdir: ../super/.git/modules/fixture\n');
  const result=cli(f,['--files','client.cjs','--out','.cache/exness-rules/report.json']);assert.equal(result.status,2,result.stderr);assert.match(result.stderr,/submodule/);assert(!fs.existsSync(path.join(f.project,'.cache')));
});
