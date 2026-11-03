'use strict';
const fs=require('node:fs');
const {hash,publicFile}=require('./legacy-core.cjs');
const {analyze}=require('./adapters/javascript.cjs');
function reviewFiles(root,files,bundle,validateTransfer){
  return files.map(file=>{
    const abs=publicFile(root,file),bytes=fs.readFileSync(abs);
    if(!/\.(cjs|mjs|js)$/.test(abs))return {file,sha256:hash(bytes),findings:[],coverage:[],manual:[{file,reason:'No language adapter; this file has not been analyzed.'}],adapter:'unsupported'};
    return {file,sha256:hash(bytes),...analyze(bytes.toString('utf8'),file,bundle.rules,validateTransfer),adapter:'javascript'};
  });
}
module.exports={reviewFiles};
