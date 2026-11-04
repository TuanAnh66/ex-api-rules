'use strict';
// Sanitized source strings only. The tests parse these; they never execute them.
const transfer = body => `fetch('https://api.exness.com/v1/transfers', {method:'POST', body:JSON.stringify(${body})});`;
const hash = bytes => `require('node:crypto').createHash('sha256').update(${JSON.stringify(bytes)}).digest('base64url')`;
const signing = (metadata, body = 'actual') => `fetch('https://api.exness.com/v1/accounts/example/balance?fixture=1', {method:'POST',body:${JSON.stringify(body)}, headers:{'EXN-DATA':Buffer.from(JSON.stringify(${metadata})).toString('base64url')}});`;
const fields = 'destination_type:"own_account",source_account:"100",destination_account:"200",amount:"1"';
const benign = [
  ['uuid-log-in-catch', 'try { recordMetric(); } catch (error) { logger.error({eventId: crypto.randomUUID()}); }'],
  ['retry-telemetry', 'function retryTelemetry() { return crypto.randomUUID(); }'],
  ['unrelated-backup-status', 'if (backupComplete) { status = "done"; }'],
  ['confirmed-final-result', 'if (operation_id && confirmedFinalResult === true) { status = "done"; }'],
  ['unrelated-documentation-link', 'console.log("https://api.exness.com/v1/trading/accounts/example");'],
  ['valid-spread-body', 'const accounts = {source_account:"100",destination_account:"200",amount:"1"}; const body = {...accounts,destination_type:"own_account"};'],
  ['valid-spread-override', 'const body = {destination_type:"own_account",source_account:100,destination_account:"200",amount:"1",...{source_account:"100"}};'],
  ['unrelated-transfer-shaped-object', `logger.info({${fields},source_account:100,amount:0});`],
  ['unrelated-signing-shaped-object', `logger.info({body_hash:${hash('wrong')},path:'/wrong'});`],
  ['standalone-signer', `function sign(body){return {body_hash:${hash('wrong')},path:'/wrong'};}`],
  ['shadowed-fetch', `function example(fetch){fetch('https://api.exness.com/v1/trading/accounts/example');}`],
  ['assigned-fetch', `fetch=logger.info;fetch('https://api.exness.com/v1/trading/accounts/example');`],
  ['loop-assigned-fetch', `for(fetch of callbacks){fetch('https://api.exness.com/v1/trading/accounts/example')}`],
  ['reflect-replaced-fetch', `Reflect.set(globalThis,'fetch',logger.info);fetch('https://api.exness.com/v1/trading/accounts/example');`],
  ['modified-stringify', `Object.defineProperty(JSON,'stringify',{value:()=>safeBody});${transfer(`{${fields},source_account:100}`)}`],
  ['aliased-stringify-mutation', `const serializer=JSON;serializer.stringify=()=>safeBody;${transfer(`{${fields},source_account:100}`)}`],
  ['global-stringify-mutation', `globalThis.JSON.stringify=()=>safeBody;${transfer(`{${fields},source_account:100}`)}`],
  ['valid-inline-spread-before', transfer(`{...{${fields}},source_account:'100'}`)],
  ['valid-inline-spread-after', transfer(`{${fields},source_account:100,...{source_account:'100'}}`)],
  ['valid-duplicate-id', transfer(`{${fields},source_account:100,source_account:'100'}`)],
  ['valid-amount-override', transfer(`{${fields},amount:0,...{amount:'1'}}`)],
  ['valid-computed-key', transfer(`{${fields},source_account:100,['source_account']:'100'}`)],
  ['dynamic-spread-after', transfer(`{${fields},source_account:100,amount:0,...unknown}`)],
  ['dynamic-spread-before', transfer(`{...unknown,${fields}}`)],
  ['dynamic-computed-after', transfer(`{${fields},source_account:100,amount:0,[field]:'100'}`)],
  ['getter-id', transfer(`{${fields},source_account:100,get source_account(){throw Error('MUST NOT EXECUTE')}}`)],
  ['getter-amount', transfer(`{${fields},amount:0,get amount(){return '1'}}`)],
  ['getter-other-field', transfer(`{${fields},source_account:100,get other(){this.source_account='100';return ''}}`)],
  ['custom-toJSON', transfer(`{${fields},source_account:100,toJSON(){return {${fields}}}}`)],
  ['partial-missing-fields', transfer(`{...accounts,destination_type:'own_account'}`)],
  ['options-overridden-after', `fetch('https://api.exness.com/v1/transfers',{method:'POST',body:JSON.stringify({${fields},amount:0}),...unknown});`],
  ['options-getter', `fetch('https://api.exness.com/v1/transfers',{method:'POST',body:JSON.stringify({${fields},amount:0}),get headers(){this.body='{}';throw Error('MUST NOT EXECUTE')}});`],
  ['shadowed-stringify', `function sample(JSON){${transfer(`{${fields},source_account:100}`)}}`],
  ['valid-signature', signing(`{path:'/v1/accounts/example/balance?fixture=1',body_hash:${hash('actual')}}`)],
  ['same-utf8-body-bytes', signing(`{path:'/v1/accounts/example/balance?fixture=1',body_hash:${hash('\ud800')}}`, '\ud801')],
  ['signing-duplicate-hash', signing(`{body_hash:${hash('wrong')},body_hash:${hash('actual')},path:'/v1/accounts/example/balance?fixture=1'}`)],
  ['signing-spread-hash', signing(`{body_hash:${hash('wrong')},...{body_hash:${hash('actual')}},path:'/v1/accounts/example/balance?fixture=1'}`)],
  ['signing-duplicate-path', signing(`{body_hash:${hash('actual')},path:'/wrong',path:'/v1/accounts/example/balance?fixture=1'}`)],
  ['signing-spread-path', signing(`{body_hash:${hash('actual')},path:'/wrong',...{path:'/v1/accounts/example/balance?fixture=1'}}`)],
  ['signing-unknown-spread', signing(`{body_hash:${hash('wrong')},path:'/wrong',...unknown}`)],
  ['signing-getter-hash', signing(`{body_hash:${hash('wrong')},path:'/v1/accounts/example/balance?fixture=1',get body_hash(){throw Error('MUST NOT EXECUTE')}}`)],
  ['signing-getter-hash-mutates-path', signing(`{get body_hash(){this.path='/v1/accounts/example/balance?fixture=1';return '47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU';},path:'/wrong'}`, '')],
  ['signing-getter-path', signing(`{body_hash:${hash('actual')},path:'/wrong',get path(){return '/v1/accounts/example/balance?fixture=1'}}`)],
  ['signing-computed-hash', signing(`{body_hash:${hash('wrong')},['body_hash']:${hash('actual')},path:'/v1/accounts/example/balance?fixture=1'}`)],
  ['signing-dynamic-computed', signing(`{body_hash:${hash('wrong')},path:'/wrong',[key]:value}`)],
  ['signing-toJSON', signing(`{body_hash:${hash('wrong')},path:'/wrong',toJSON(){return safeMetadata}}`)],
  ['signing-opaque-hash', signing(`{body_hash:hashBody(body),path:'/v1/accounts/example/balance?fixture=1'}`)],
  ['signing-opaque-hash-wrong-path', signing(`{body_hash:hashBody(body),path:'/wrong'}`)]
];
const violations = [
  ['gateway-request', `fetch('https://api.exness.com/v1/trading/accounts/example/orders');`, 'TRADE-HOST-001'],
  ['global-gateway-request', `globalThis.fetch('https://api.exness.com/v1/configuration/accounts/example');`, 'TRADE-HOST-001'],
  ['missing-required-field', transfer('{destination_type:"own_account",amount:"1"}'), 'PAY-REQUEST-001'],
  ['numeric-final-id', transfer(`{${fields},...{source_account:100}}`), 'PAY-ACCOUNT-ID-010'],
  ['numeric-final-amount', transfer(`{${fields},...{amount:0}}`), 'PAY-AMOUNT-002'],
  ['wrong-sent-hash', signing(`{body_hash:${hash('wrong')},path:'/v1/accounts/example/balance?fixture=1'}`), 'COMMON-SIGN-001'],
  ['wrong-sent-path', signing(`{body_hash:${hash('actual')},path:'/wrong'}`), 'COMMON-SIGN-001'],
  ['wrong-final-hash', signing(`{body_hash:${hash('actual')},...{body_hash:${hash('wrong')}},path:'/v1/accounts/example/balance?fixture=1'}`), 'COMMON-SIGN-001'],
  ['wrong-final-path', signing(`{body_hash:${hash('actual')},path:'/v1/accounts/example/balance?fixture=1',...{path:'/wrong'}}`), 'COMMON-SIGN-001']
];
module.exports = {transfer, hash, signing, benign, violations};
