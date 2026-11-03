'use strict';
const {execFileSync}=require('node:child_process');

function gitEnvironment(source=process.env){
  const env={...source};
  // Target selection and command configuration belong to this invocation.
  // Do not inherit a different repository/index or caller-supplied Git config.
  for(const key of Object.keys(env))if(/^GIT_/i.test(key))delete env[key];
  // Git for Windows also accepts /dev/null; Node's \\.\nul device spelling
  // is not accepted by Git's configuration loader.
  return {...env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0'};
}
function assertSupportedGitVersion(output){
  const match=/^git version (\d+)\.(\d+)(?:\.\d+)?(?:[.\s-].*)?$/.exec(output.trim());
  // Older Git can interpret the string "false" as an fsmonitor hook pathname.
  if(!match||Number(match[1])<2||(Number(match[1])===2&&Number(match[2])<36))throw Error('Review requires Git 2.36 or newer; unsupported or unrecognized Git version');
}
function createGit(projectRoot){
  const options={cwd:projectRoot,env:gitEnvironment(),encoding:'utf8',maxBuffer:8*1024*1024,stdio:['ignore','pipe','pipe']};
  // Check before repository inspection; older Git must never receive the
  // fsmonitor boolean override as a possible hook pathname.
  assertSupportedGitVersion(execFileSync('git',['--version'],options));
  return args=>execFileSync('git',['-c','safe.directory='+projectRoot,'-c','core.fsmonitor=false',...args],options);
}
module.exports={gitEnvironment,assertSupportedGitVersion,createGit};
