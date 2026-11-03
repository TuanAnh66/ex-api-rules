#!/usr/bin/env node
'use strict';
const path=require('node:path'),cli=require('../packages/cli/src/main.cjs');
const distributionRoot=path.resolve(__dirname,'..');
const main=(args,defaults={})=>cli.main(args,{...defaults,distributionRoot});
const review=(root,options)=>cli.review(root,options,distributionRoot);
module.exports={...cli,main,review};
if(require.main===module)main(process.argv.slice(2)).catch(e=>{console.error(e.message);process.exitCode=2;});
