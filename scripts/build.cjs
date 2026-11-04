'use strict';
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
function copy(from,to){fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(from,to);}
for(const name of ['rule','bundle','report','report-v2','lock','catalog','checks'])copy(path.join(root,'schemas',name+'.schema.json'),path.join(root,'packages/core/schemas',name+'.schema.json'));
for(const name of ['rules','sources','checks'])copy(path.join(root,'catalog',name+'.json'),path.join(root,'packages/cli/resources/catalog',name+'.json'));
copy(path.join(root,'archive/first-success-600-usc.sanitized.json'),path.join(root,'packages/cli/resources/archive/first-success-600-usc.sanitized.json'));
for(const name of ['core','cli'])copy(path.join(root,'NOTICE'),path.join(root,'packages',name,'NOTICE'));
console.log('Built schema and explicitly allowlisted package resources.');
