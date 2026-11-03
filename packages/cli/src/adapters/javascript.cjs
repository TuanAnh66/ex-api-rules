'use strict';
const acorn=require('acorn');
function walk(node,visit,ancestors=[]){
  if(!node||typeof node!=='object')return;
  if(node.type)visit(node,ancestors);
  for(const [k,v]of Object.entries(node)){if(['loc','start','end'].includes(k))continue;if(Array.isArray(v))v.forEach(n=>walk(n,visit,[...ancestors,node]));else if(v&&typeof v==='object')walk(v,visit,[...ancestors,node]);}
}
const key=p=>p.key?.name??p.key?.value;
function analyze(text,file,rules,validateTransfer){
  const findings=[],manual=[];let tree;
  const known=new Set(rules.map(r=>r.id));
  function add(node,ruleId,severity,title,recommendation){
    if(!known.has(ruleId))return;
    if(rules.find(r=>r.id===ruleId)?.kind==='inference')return;
    if(findings.some(f=>f.line===node.loc.start.line&&f.ruleId===ruleId))return;
    const rule=rules.find(r=>r.id===ruleId);
    findings.push({file,line:node.loc.start.line,ruleId,severity,title,recommendation,evidence:rule.evidence,kind:rule.kind});
  }
  try{tree=acorn.parse(text,{ecmaVersion:'latest',sourceType:'module',locations:true,allowHashBang:true});}
  catch{ return {findings,manual:[{file,reason:'Parser could not analyze this file; human review required'}],coverage:[]}; }
  walk(tree,(node,ancestors)=>{
    if(node.type==='ObjectExpression'){
      const props=node.properties.filter(p=>p.type==='Property'),names=props.map(key);
      if(names.includes('destination_type')){
        const value={};let allLiteral=true;
        for(const p of props){if(p.value.type==='Literal')value[key(p)]=p.value.value;else allLiteral=false;}
        if(allLiteral&&!validateTransfer(value))add(node,'PAY-REQUEST-001','P1','Transfer body violates published schema','Use exactly the required fields with string identifiers and amount; inspect schema validation errors.');
        for(const p of props){
          if(['source_account','destination_account'].includes(key(p))&&p.value.type==='Literal'&&typeof p.value.value!=='string')add(p,'PAY-ACCOUNT-ID-010','P1','Numeric account identifier','Preserve account identifiers as strings.');
          if(key(p)==='amount'&&p.value.type==='Literal'&&(typeof p.value.value!=='string'||!/[1-9]/.test(p.value.value)))add(p,'PAY-AMOUNT-002','P1','Invalid amount type or zero amount','Use a positive decimal string and validate source-currency precision.');
        }
        if(!allLiteral)manual.push({file,line:node.loc.start.line,reason:'Transfer body includes dynamic values; schema/precision need fixture or runtime-input validation.'});
      }
      if(names.includes('body_hash')){
        const fn=[...ancestors].reverse().find(a=>/Function/.test(a.type));
        const params=fn?.params.map(p=>p.name)||[];
        const bodyProp=props.find(p=>key(p)==='body_hash'),bodyText=text.slice(bodyProp.start,bodyProp.end);
        if(params.includes('body')&&!/\.update\(\s*body\s*\)/.test(bodyText))add(bodyProp,'COMMON-SIGN-001','P1','Body hash may not cover sent body','Hash exactly the body bytes passed into the signing function.');
        const p=props.find(p=>key(p)==='path');if(p?.value.type==='Literal'&&params.some(n=>/requestPath|request_path/.test(n)))add(p,'COMMON-SIGN-001','P1','Signed path is hardcoded','Sign the actual request path including its exact query string.');
      }
    }
    if(node.type==='CallExpression'){
      const call=text.slice(node.callee.start,node.callee.end);
      if(/(^|\.)randomUUID$/.test(call)&&ancestors.some(a=>a.type==='CatchClause'||(/Function/.test(a.type)&&/retry|recover/i.test(a.id?.name||''))||(a.type==='IfStatement'&&/unknown|retry/i.test(text.slice(a.test.start,a.test.end)))))add(node,'PAY-UUID-003','P1','A retry path generates a new UUID','Reload the original durable intent and retain its key; reconcile an unknown outcome.');
      if(/^(Number|parseFloat|parseInt)$/.test(call)&&node.arguments.some(a=>/amount|volume|price|balance/i.test(text.slice(a.start,a.end))))add(node,node.arguments.some(a=>/volume|price/i.test(text.slice(a.start,a.end)))?'TRADE-PRECISION-005':'PAY-AMOUNT-002','P2','Potential precision loss in monetary conversion','Keep decimal strings and use decimal-safe arithmetic with the applicable precision.');
      if(node.arguments.some(a=>a.type==='Literal'&&typeof a.value==='string'&&/^https:\/\/api\.exness\.com\/v1\/(trading|configuration)\/accounts\//.test(a.value)))add(node,'TRADE-HOST-001','P1','Account Trader request targets the Gateway directly','Use the discovered account Access Point for this request.');
    }
    if(node.type==='IfStatement'){
      const condition=text.slice(node.test.start,node.test.end),body=text.slice(node.consequent.start,node.consequent.end);
      if(/ack|operation_id|accepted/i.test(condition)&&/(?:state|status)\s*[:=]\s*['"]done['"]/.test(body))add(node,'TRADE-ACK-002','P1','ACK is treated as final execution success','Wait for a confirmed operation result/event and reconcile state.');
    }
    if(node.type==='BinaryExpression'&&['===','!=='].includes(node.operator)){
      const expression=text.slice(node.start,node.end),parentIf=[...ancestors].reverse().find(a=>a.type==='IfStatement');
      if(/\.transfer_id\b/.test(expression)&&/transferId\b/.test(expression)&&!(parentIf&&/isSafeInteger[\s\S]*String\(/.test(text.slice(parentIf.test.start,parentIf.test.end))))add(node,'OBS-TRANSFER-ID-002','P2','Strict ID-type comparison rejects observed status responses','Normalize a matching string or safe integer; reject unsafe numeric identifiers.');
    }
  });
  const scopes=new Set(['common']);if(/transfers|source_account/.test(text))scopes.add('payments');if(/\/trading\/|\/configuration\/|operation_id/.test(text))scopes.add('trading');
  const covered=new Set(findings.map(f=>f.ruleId));
  for(const rule of rules.filter(r=>scopes.has(r.scope)&&r.kind==='documented'))if(!covered.has(rule.id))manual.push({file,ruleId:rule.id,reason:'No automated proof of compliance; inspect data flow and behavior tests.'});
  return {findings,manual,coverage:[...covered]};
}

module.exports={walk,analyze};
