'use strict';
const acorn = require('acorn');

function walk(node, visit, ancestors = []) {
  if (!node || typeof node !== 'object') return;
  if (node.type) visit(node, ancestors);
  for (const [key, value] of Object.entries(node)) {
    if (['loc', 'start', 'end'].includes(key)) continue;
    if (Array.isArray(value)) value.forEach(child => walk(child, visit, [...ancestors, node]));
    else if (value && typeof value === 'object') walk(value, visit, [...ancestors, node]);
  }
}

const member = (node, name) => node?.type === 'MemberExpression' && !node.computed && node.property.name === name;
const literal = node => node?.type === 'Literal' && (node.value === null || ['string', 'number', 'boolean'].includes(typeof node.value));
const propertyKey = property => {
  if (!property.computed && property.key?.type === 'Identifier') return property.key.name;
  if (literal(property.key)) return String(property.key.value);
  return null;
};

// Unknown keys can overwrite any preceding field. Later explicit fields restore
// only their own values. Never execute getters or borrow mutable bindings.
function objectState(node) {
  const fields = new Map();
  let unknownKeys = node?.type !== 'ObjectExpression';
  if (!unknownKeys) for (const property of node.properties) {
    if (property.type === 'SpreadElement') {
      const spread = objectState(property.argument);
      if (spread.unknownKeys) { fields.clear(); unknownKeys = true; }
      for (const [name, value] of spread.fields) fields.set(name, value);
      continue;
    }
    const name = propertyKey(property);
    // The special prototype setter is not an own data property.
    if (name === null || (name === '__proto__' && !property.computed && !property.shorthand && property.kind === 'init' && !property.method)) {
      fields.clear(); unknownKeys = true; continue;
    }
    const value = property.kind === 'init' && !property.method ? property.value : null;
    fields.set(name, {node: value, property});
  }
  return {fields, unknownKeys};
}

function jsonObject(state) {
  if (state.unknownKeys) return null;
  const value = Object.create(null);
  for (const [name, field] of state.fields) {
    if (!literal(field.node)) return null;
    value[name] = field.node.value;
  }
  return value;
}

// A binding or direct write anywhere conservatively disables that known global.
// This intentionally loses coverage across otherwise independent scopes.
function globalGuards(tree) {
  const blocked = new Set();
  function bind(pattern) {
    if (!pattern) return;
    if (pattern.type === 'Identifier') blocked.add(pattern.name);
    else if (pattern.type === 'RestElement') bind(pattern.argument);
    else if (pattern.type === 'AssignmentPattern') bind(pattern.left);
    else if (pattern.type === 'ObjectPattern') pattern.properties.forEach(p => bind(p.type === 'RestElement' ? p.argument : p.value));
    else if (pattern.type === 'ArrayPattern') pattern.elements.forEach(bind);
  }
  function write(target) {
    if (target?.type !== 'MemberExpression') return bind(target);
    let base = target;
    while (base.type === 'MemberExpression') base = base.object;
    if (base.type === 'Identifier') blocked.add(base.name);
    if (base.name === 'globalThis') ['fetch', 'JSON', 'Buffer', 'require'].forEach(name => blocked.add(name));
  }
  walk(tree, (node, ancestors) => {
    if (node.type === 'Identifier' && ['globalThis', 'JSON', 'Buffer'].includes(node.name)) {
      const parent = ancestors.at(-1);
      const receiver = parent?.type === 'MemberExpression' && parent.object === node;
      const staticKey = (parent?.type === 'MemberExpression' && parent.property === node && !parent.computed)
        || (parent?.type === 'Property' && parent.key === node && !parent.computed && !parent.shorthand);
      if (!receiver && !staticKey) {
        blocked.add(node.name);
        if (node.name === 'globalThis') ['fetch', 'JSON', 'Buffer', 'require'].forEach(name => blocked.add(name));
      }
    }
    if (node.type === 'VariableDeclarator') bind(node.id);
    if (/Function/.test(node.type)) { bind(node.id); node.params.forEach(bind); }
    if (/^Class/.test(node.type)) bind(node.id);
    if (node.type === 'CatchClause') bind(node.param);
    if (/^Import.*Specifier$/.test(node.type)) bind(node.local);
    if (node.type === 'AssignmentExpression') write(node.left);
    if (['ForInStatement', 'ForOfStatement'].includes(node.type) && node.left.type !== 'VariableDeclaration') write(node.left);
    if (node.type === 'UpdateExpression') write(node.argument);
    if (node.type === 'UnaryExpression' && node.operator === 'delete') write(node.argument);
    // Passing a builtin to another call may expose it to mutation (including
    // Object.defineProperty/Reflect.set). Do not assume the sink is intact.
    if (node.type === 'CallExpression') for (const argument of node.arguments) {
      if (argument.type === 'Identifier' && ['globalThis', 'JSON', 'Buffer'].includes(argument.name)) {
        blocked.add(argument.name);
        if (argument.name === 'globalThis') ['fetch', 'JSON', 'Buffer', 'require'].forEach(name => blocked.add(name));
      }
    }
    if (node.type === 'WithStatement' || (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'eval')) {
      ['fetch', 'globalThis', 'JSON', 'Buffer', 'require'].forEach(name => blocked.add(name));
    }
  });
  return name => !blocked.has(name);
}

function analyze(text, file, rules, validateTransfer) {
  const findings = [], manual = [];
  const checkStates = new Map();
  function noteCheck(id, status, reason = null) {
    const previous = checkStates.get(id);
    if (!previous) checkStates.set(id, {checkId: id, status, reason});
    else if (previous.status !== status) checkStates.set(id, {checkId: id, status: 'partial', reason: 'Some supported contexts ran; other data flow requires human review.'});
  }
  const byId = new Map(rules.map(rule => [rule.id, rule]));
  let tree;
  function add(node, ruleId, severity, title, recommendation) {
    const rule = byId.get(ruleId);
    if (!rule || rule.kind === 'inference') return;
    if (findings.some(f => f.line === node.loc.start.line && f.ruleId === ruleId)) return;
    findings.push({file, line: node.loc.start.line, ruleId, severity, title, recommendation, evidence: rule.evidence, kind: rule.kind});
  }
  function needsReview(node, ruleId, reason) {
    if (!byId.has(ruleId) || byId.get(ruleId).kind === 'inference') return;
    if (!manual.some(m => m.line === node.loc.start.line && m.ruleId === ruleId && m.reason === reason)) manual.push({file, line: node.loc.start.line, ruleId, reason});
  }
  try {
    tree = acorn.parse(text, {ecmaVersion: 'latest', sourceType: 'module', locations: true, allowHashBang: true});
  } catch {
    return {findings, manual: [{file, reason: 'Parser could not analyze this file; human review required'}], coverage: [], parseStatus: 'failed', checkRuns: []};
  }
  const globalAvailable = globalGuards(tree);
  const bodyObjects = new Set(), metadataObjects = new Set();
  const globalMethod = (node, object, method) => member(node, method) && node.object.type === 'Identifier' && node.object.name === object && globalAvailable(object);
  const stringifyInput = node => node?.type === 'CallExpression' && globalMethod(node.callee, 'JSON', 'stringify') && node.arguments.length === 1 ? node.arguments[0] : null;

  function bodyValue(node) {
    if (literal(node) && typeof node.value === 'string') {
      let value; try { value = JSON.parse(node.value); } catch {}
      return {bytes: node.value, value};
    }
    const object = stringifyInput(node);
    if (!object) return {};
    bodyObjects.add(object);
    const state = objectState(object), value = jsonObject(state);
    return {object, state, value, bytes: value === null ? undefined : JSON.stringify(value)};
  }

  function transferBody(call, body) {
    const {state, value} = body;
    const completeBody = value && typeof value === 'object' && !Array.isArray(value) && typeof validateTransfer === 'function';
    noteCheck('JS-TRANSFER-BODY', completeBody ? 'ran' : 'manual-only', completeBody ? null : 'Complete body/schema data flow is unresolved; compliance is unproven.');
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (typeof validateTransfer === 'function' && !validateTransfer(value)) add(body.object || call, 'PAY-REQUEST-001', 'P1', 'Transfer request body violates published schema', 'Use the published TransferRequest fields and types.');
      if (typeof validateTransfer !== 'function') needsReview(call, 'PAY-REQUEST-001', 'Published TransferRequest schema is unavailable; schema compliance is unresolved.');
    } else if (!state) {
      needsReview(call, 'PAY-REQUEST-001', 'Transfer request body data flow is unresolved; schema compliance has not been established.');
    }
    // A partial object may supply toJSON or accessors. JSON.stringify can then
    // change even an apparently known field; do not validate a partial copy.
    if (state && value !== null) {
      noteCheck('JS-TRANSFER-BODY', 'ran');
      for (const name of ['source_account', 'destination_account', 'amount']) {
        const field = state.fields.get(name);
        if (!literal(field?.node)) continue;
        const value = field.node.value;
        if (name !== 'amount' && typeof value !== 'string') add(field.property, 'PAY-ACCOUNT-ID-010', 'P1', 'Numeric or non-string account identifier in transfer request', 'Preserve account identifiers as nonempty strings.');
        if (name === 'amount' && (typeof value !== 'string' || !/[1-9]/.test(value))) add(field.property, 'PAY-AMOUNT-002', 'P1', 'Invalid amount type or zero amount in transfer request', 'Use a positive decimal string and validate source-currency precision.');
      }
    }
    if (state && value === null) needsReview(body.object, 'PAY-REQUEST-001', 'Transfer body includes unresolved spread, computed keys, getters or dynamic values; missing fields and full schema compliance cannot be established.');
  }

  // Only this direct encoding path establishes that metadata is sent in EXN-DATA.
  // Signer helpers, aliases and opaque headers remain manual review.
  function encodedMetadata(node) {
    if (node?.type !== 'CallExpression' || !member(node.callee, 'toString') || node.arguments.length !== 1 || node.arguments[0]?.value !== 'base64url') return null;
    const buffer = node.callee.object;
    if (buffer?.type !== 'CallExpression' || !globalMethod(buffer.callee, 'Buffer', 'from') || buffer.arguments.length !== 1) return null;
    return stringifyInput(buffer.arguments[0]);
  }
  function hashInput(node) {
    if (node?.type !== 'CallExpression' || !member(node.callee, 'digest') || node.arguments.length !== 1 || node.arguments[0]?.value !== 'base64url') return null;
    const update = node.callee.object;
    if (update?.type !== 'CallExpression' || !member(update.callee, 'update') || update.arguments.length !== 1) return null;
    const hash = update.callee.object;
    if (hash?.type !== 'CallExpression' || !member(hash.callee, 'createHash') || hash.arguments.length !== 1 || hash.arguments[0]?.value !== 'sha256') return null;
    const crypto = hash.callee.object;
    if (crypto?.type !== 'CallExpression' || crypto.callee.type !== 'Identifier' || crypto.callee.name !== 'require' || !globalAvailable('require') || crypto.arguments.length !== 1 || !['node:crypto', 'crypto'].includes(crypto.arguments[0]?.value)) return null;
    return update.arguments[0];
  }
  function signing(call, options, body, url) {
    const headers = objectState(options.fields.get('headers')?.node);
    const entries = [...headers.fields].filter(([name]) => name.toLowerCase() === 'exn-data');
    if (headers.unknownKeys || [...headers.fields.values()].some(field => !field.node) || entries.length !== 1) {
      noteCheck('JS-SIGNING', 'manual-only', 'Signing headers/data flow are unresolved.');
      needsReview(call, 'COMMON-SIGN-001', 'Signing headers/data flow are unresolved; verify the exact sent method, path, query and body bytes.');
      return;
    }
    const object = encodedMetadata(entries[0][1].node);
    if (!object) {
      noteCheck('JS-SIGNING', 'manual-only', 'EXN-DATA encoding/data flow is unresolved.');
      needsReview(call, 'COMMON-SIGN-001', 'EXN-DATA encoding/data flow is unresolved; verify the exact sent signing payload.');
      return;
    }
    metadataObjects.add(object);
    const state = objectState(object), input = hashInput(state.fields.get('body_hash')?.node);
    const knownHash = literal(input) && typeof input.value === 'string';
    if (state.unknownKeys || state.fields.has('toJSON') || [...state.fields].some(([name, field]) => !literal(field.node) && !(name === 'body_hash' && knownHash))) {
      noteCheck('JS-SIGNING', 'manual-only', 'Final serialized signing metadata is unresolved.');
      needsReview(object, 'COMMON-SIGN-001', 'Signing object includes unresolved spread, accessors or dynamic fields; the final serialized metadata is unresolved.');
      return;
    }
    if (literal(input) && typeof input.value === 'string' && typeof body.bytes === 'string') {
      noteCheck('JS-SIGNING', 'ran');
      if (!Buffer.from(input.value, 'utf8').equals(Buffer.from(body.bytes, 'utf8'))) add(object, 'COMMON-SIGN-001', 'P1', 'EXN-DATA hashes different bytes from the sent request body', 'Hash exactly the request body bytes sent by this request.');
    } else {
      noteCheck('JS-SIGNING', 'manual-only', 'Body hash data flow is unresolved.');
      needsReview(object, 'COMMON-SIGN-001', 'Body hash data flow is unresolved; equality with the exact sent bytes has not been established.');
    }
    const signedPath = state.fields.get('path')?.node;
    if (literal(signedPath) && typeof signedPath.value === 'string') {
      noteCheck('JS-SIGNING', 'ran');
      if (signedPath.value !== url.pathname + url.search) add(object, 'COMMON-SIGN-001', 'P1', 'EXN-DATA path differs from the request path and query', 'Sign the exact request path including its query.');
    } else {
      noteCheck('JS-SIGNING', 'manual-only', 'Signed path data flow is unresolved.');
      needsReview(object, 'COMMON-SIGN-001', 'Signed path data flow is unresolved; verify the actual request path and query.');
    }
  }

  function request(node) {
    const fetch = node.callee.type === 'Identifier' && node.callee.name === 'fetch' && globalAvailable('fetch');
    const globalFetch = globalMethod(node.callee, 'globalThis', 'fetch') && globalAvailable('fetch');
    if ((!fetch && !globalFetch) || node.arguments.length < 1 || node.arguments.length > 2) return;
    const target = node.arguments[0];
    if (!literal(target) || typeof target.value !== 'string') return;
    let url; try { url = new URL(target.value); } catch { return; }
    if (url.origin !== 'https://api.exness.com') return;
    if (/^\/v1\/(trading|configuration)\/accounts\//.test(url.pathname)) {
      noteCheck('JS-HOST', 'ran');
      add(node, 'TRADE-HOST-001', 'P1', 'Account Trader fetch targets the Gateway directly', 'Use the discovered account Access Point for this request.');
    }
    const options = objectState(node.arguments[1]);
    if (options.unknownKeys || [...options.fields.values()].some(field => !field.node)) {
      if (url.pathname === '/v1/transfers') {
        noteCheck('JS-TRANSFER-BODY', 'manual-only', 'Final request options are unresolved.');
        needsReview(node, 'PAY-REQUEST-001', 'Request options include unresolved spread or accessors; final method and body data flow are unresolved.');
      }
      noteCheck('JS-SIGNING', 'manual-only', 'Final request options are unresolved.');
      needsReview(node, 'COMMON-SIGN-001', 'Request options include unresolved spread or accessors; final signing data flow is unresolved.');
      return;
    }
    const method = options.fields.get('method')?.node;
    if (url.pathname === '/v1/transfers' && literal(method) && typeof method.value === 'string' && method.value.toUpperCase() === 'POST') transferBody(node, bodyValue(options.fields.get('body')?.node));
    const body = bodyValue(options.fields.get('body')?.node);
    if (!options.unknownKeys && !options.fields.has('body')) body.bytes = '';
    signing(node, options, body, url);
  }

  walk(tree, (node, ancestors) => {
    if (node.type === 'CallExpression') {
      request(node);
      const call = text.slice(node.callee.start, node.callee.end);
      if (/(^|\.)randomUUID$/.test(call)) needsReview(node, 'PAY-UUID-003', 'UUID use and retry intent data flow are unresolved; this call alone does not establish replacement of a transfer idempotency key.');
      if (/^(Number|parseFloat|parseInt)$/.test(call) && node.arguments.some(a => /amount|volume|price|balance/i.test(text.slice(a.start, a.end)))) {
        noteCheck('JS-PRECISION', 'ran');
        add(node, node.arguments.some(a => /volume|price/i.test(text.slice(a.start, a.end))) ? 'TRADE-PRECISION-005' : 'PAY-AMOUNT-002', 'P2', 'Potential precision loss in monetary conversion', 'Keep decimal strings and use decimal-safe arithmetic with the applicable precision.');
      }
    }
    if (node.type === 'ObjectExpression') {
      const names = node.properties.filter(p => p.type === 'Property').map(propertyKey);
      if (names.includes('destination_type') && !bodyObjects.has(node)) {
        noteCheck('JS-TRANSFER-BODY', 'manual-only', 'Object request context/data flow is unresolved.');
        needsReview(node, 'PAY-REQUEST-001', 'Object request context/data flow is unresolved; field names alone do not establish a sent TransferRequest.');
      }
      if (names.includes('body_hash') && !metadataObjects.has(node)) {
        noteCheck('JS-SIGNING', 'manual-only', 'Signing object request context/data flow is unresolved.');
        needsReview(node, 'COMMON-SIGN-001', 'Signing object request context/data flow is unresolved; verify its final fields and exact sent bytes.');
      }
    }
    if (node.type === 'IfStatement') {
      let acknowledgement = false, done = false;
      walk(node.test, n => { if (n.type === 'Identifier' && /^(ack|operation_id|accepted)$/i.test(n.name)) acknowledgement = true; });
      walk(node.consequent, n => {
        if (n.type === 'AssignmentExpression' && n.operator === '=' && n.right?.value === 'done') {
          if ((n.left.type === 'Identifier' && /^(state|status)$/.test(n.left.name)) || (n.left.type === 'MemberExpression' && !n.left.computed && /^(state|status)$/.test(n.left.property.name))) done = true;
        }
      });
      if (acknowledgement && done) needsReview(node, 'TRADE-ACK-002', 'ACK/final-result data flow is unresolved; verify correlation and confirmed execution before marking done. Names or an additional condition do not establish a violation.');
    }
    if (node.type === 'BinaryExpression' && ['===', '!=='].includes(node.operator)) {
      const expression = text.slice(node.start, node.end), parentIf = [...ancestors].reverse().find(a => a.type === 'IfStatement');
      if (/\.transfer_id\b/.test(expression) && /transferId\b/.test(expression) && !(parentIf && /isSafeInteger[\s\S]*String\(/.test(text.slice(parentIf.test.start, parentIf.test.end)))) {
        noteCheck('JS-ID-COMPAT', 'ran');
        add(node, 'OBS-TRANSFER-ID-002', 'P2', 'Strict ID-type comparison rejects observed status responses', 'Normalize a matching string or safe integer; reject unsafe numeric identifiers.');
      }
    }
  });
  const scopes = new Set(['common']);
  if (/transfers|source_account/.test(text)) scopes.add('payments');
  if (/\/trading\/|\/configuration\/|operation_id/.test(text)) scopes.add('trading');
  // Legacy adapter coverage lists finding IDs only. Report v2 uses independent
  // checkRuns execution states, never this compatibility field, as coverage.
  const covered = new Set(findings.map(f => f.ruleId));
  for (const rule of rules.filter(r => scopes.has(r.scope) && r.kind === 'documented')) if (!covered.has(rule.id)) manual.push({file, ruleId: rule.id, reason: 'No automated proof of compliance; inspect data flow and behavior tests.'});
  noteCheck('JS-RETRY-ID', 'manual-only', 'Retry identity requires durable intent and data-flow/behavior review.');
  noteCheck('JS-ACK', 'manual-only', 'Execution finality requires correlated result and behavior review.');
  for (const checkId of ['JS-SIGNING', 'JS-TRANSFER-BODY', 'JS-HOST', 'JS-PRECISION', 'JS-ID-COMPAT']) {
    if (!checkStates.has(checkId)) noteCheck(checkId, 'not-applicable', 'No supported static context for this check; rule compliance remains unproven.');
  }
  return {findings, manual, coverage: [...covered], parseStatus: 'parsed', checkRuns: [...checkStates.values()].sort((a,b) => a.checkId < b.checkId ? -1 : a.checkId > b.checkId ? 1 : 0)};
}

module.exports = {walk, analyze};
