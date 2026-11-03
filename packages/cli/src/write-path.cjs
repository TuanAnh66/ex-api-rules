'use strict';
const fs=require('node:fs'),path=require('node:path');
const packageRoot=path.resolve(__dirname,'..'),checkout=path.resolve(__dirname,'../../..');
const installationRoots=[packageRoot];
const sourceEntry=path.join(checkout,'packages/cli/src/write-path.cjs');
if(fs.existsSync(sourceEntry)&&path.relative(fs.realpathSync(sourceEntry),fs.realpathSync(__filename))==='')installationRoots.push(checkout);
function within(root,file){
  const rel=path.relative(path.resolve(root),path.resolve(file));
  return rel===''||(rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel));
}
// Resolve the nearest existing ancestor, including a link whose child does not
// exist yet. Never use existsSync: it hides dangling links and access errors.
function realDestination(file){
  let ancestor=path.resolve(file);const suffix=[];
  for(;;){
    try{fs.lstatSync(ancestor);return path.join(fs.realpathSync(ancestor),...suffix);}
    catch(e){
      if(e.code!=='ENOENT')throw e;
      const parent=path.dirname(ancestor);if(parent===ancestor)throw e;
      // lstat succeeds for dangling links, so a failed realpath must not cause
      // us to walk past such a link and treat it as a missing directory.
      try{if(fs.lstatSync(ancestor).isSymbolicLink())throw Error('Dangling filesystem link in runtime path');}catch(inner){if(inner.code!=='ENOENT')throw inner;}
      suffix.unshift(path.basename(ancestor));ancestor=parent;
    }
  }
}
function privatePath(file){
  return file.split(/[\\/]/).some(part=>/^(\.git|node_modules|exness-custom-key|config\.local\.json|\.env.*)$/i.test(part)||/\.(key|pem)$/i.test(part));
}
function assertRuntimePath(file,{forbiddenRoots=[],allowedRoots}={}){
  const requested=path.resolve(file);
  if(privatePath(requested))throw Error('Private/excluded runtime path');
  const real=realDestination(requested);
  if(privatePath(real))throw Error('Private/excluded runtime path target');
  for(const root of [...installationRoots,...forbiddenRoots]){
    if(within(root,requested)||within(realDestination(root),real))throw Error('Runtime path must be outside the tool installation');
  }
  // Writes deliberately reject links, including benign aliases. This also
  // catches a link inserted below a store after context creation.
  if(path.relative(requested,real)!=='')throw Error('Symbolic link/junction runtime write paths are forbidden');
  if(allowedRoots&&!allowedRoots.some(root=>within(root,requested)&&within(root,real)))throw Error('Runtime output is outside allowed directories');
  for(let dir=real;;dir=path.dirname(dir)){
    const marker=path.join(dir,'.git');let stat;
    try{stat=fs.lstatSync(marker);}catch(e){if(!['ENOENT','ENOTDIR'].includes(e.code))throw e;}
    if(stat?.isSymbolicLink())throw Error('Linked Git metadata is not a writable runtime location');
    if(stat?.isFile()){
      // Ordinary Git worktrees use a gitfile too. Only their conventional
      // metadata location is allowed; submodule gitfiles remain forbidden.
      if(stat.size>4096)throw Error('Unrecognized Git checkout boundary');
      const match=/^gitdir: ([^\r\n]+)\r?\n?$/.exec(fs.readFileSync(marker,'utf8'));
      const gitdir=match&&path.resolve(dir,match[1]).replace(/\\/g,'/');
      if(!gitdir||!/\/\.git\/worktrees\/[^/]+$/i.test(gitdir)||/\/modules\//i.test(gitdir))throw Error('Runtime writes inside submodule/gitfile checkouts are forbidden');
    }
    if(path.dirname(dir)===dir)break;
  }
  return real;
}
function mkdir(directory){const target=assertRuntimePath(directory);fs.mkdirSync(target,{recursive:true});assertRuntimePath(target);}
function writeFile(file,bytes,options){return fs.writeFileSync(assertRuntimePath(file),bytes,options);}
function copyFile(source,target){return fs.copyFileSync(source,assertRuntimePath(target));}
module.exports={within,realDestination,assertRuntimePath,mkdir,writeFile,copyFile};
