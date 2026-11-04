'use strict';

function fingerprintInputs(report) {
  const {schemaVersion, toolVersion, ruleVersion, bundleHash, artifactSha256, profile, codeVersion, inputPolicy, findings, manualChecks, coverage, conflicts, limitations} = report;
  return {schemaVersion, toolVersion, ruleVersion, bundleHash, artifactSha256, profile, codeVersion, inputPolicy, findings, manualChecks, coverage, conflicts, limitations};
}

function validateReportData(report) {
  const fail = message => { throw Error('report v2 consistency failed: ' + message); };
  const files = new Map();
  let charged = 0;
  for (const file of report.codeVersion.files) {
    if (files.has(file.file)) fail('duplicate file');
    files.set(file.file, file); charged += file.budgetBytesCharged;
    if (file.bytesRead > file.budgetBytesCharged || file.budgetBytesCharged > report.inputPolicy.maxFileBytes) fail('file byte accounting exceeds policy');
    if (file.hashStatus === 'complete' && (file.sizeBytes === null || file.bytesRead !== file.sizeBytes)) fail('complete hash requires complete file bytes');
    if (file.analysisStatus === 'analyzed' && file.sizeBytes > report.inputPolicy.maxFileBytes) fail('analyzed file exceeds policy');
  }
  if (charged > report.inputPolicy.maxTotalBytes) fail('aggregate byte budget exceeded');
  if (report.inputPolicy.selection === 'explicit' && report.inputPolicy.baseRef !== null) fail('explicit selection cannot carry a base ref');
  if (report.inputPolicy.selection === 'changed-and-untracked' && !report.inputPolicy.baseRef) fail('base selection requires a ref');
  const selected = new Map(), excluded = new Set();
  for (const rule of report.coverage.selectedRules) {
    if (selected.has(rule.id)) fail('duplicate selected rule'); selected.set(rule.id, rule);
    if (report.profile !== 'default' && !['common',report.profile].includes(rule.scope)) fail('selected rule is outside profile');
  }
  for (const rule of report.coverage.excludedRules) {
    if (excluded.has(rule.id) || selected.has(rule.id)) fail('duplicate/overlapping excluded rule'); excluded.add(rule.id);
  }
  if (selected.size !== report.coverage.ruleCount) fail('ruleCount does not match selected inventory');
  const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
  const fileList = predicate => report.codeVersion.files.filter(predicate).map(file => file.file);
  if (!equal(report.codeVersion.files.map(file=>file.file), [...files.keys()].sort())) fail('file order must be stable UTF-16 path order');
  if (!equal(report.coverage.unanalyzedFiles, fileList(file=>file.analysisStatus !== 'analyzed'))) fail('unanalyzed inventory mismatch');
  if (!equal(report.coverage.parseFailedFiles, fileList(file=>file.analysisStatus === 'parse-failed'))) fail('parse-failed inventory mismatch');
  if (!equal(report.coverage.unsupportedFiles, fileList(file=>file.adapter === 'unsupported' && !['excluded','missing','not-regular'].includes(file.analysisStatus)))) fail('unsupported inventory mismatch');
  for (const finding of report.findings) {
    if (files.get(finding.file)?.analysisStatus !== 'analyzed') fail('finding references an unanalyzed/unknown file');
    if (selected.get(finding.ruleId)?.kind !== finding.kind) fail('finding references an unselected rule or different kind');
  }
  for (const item of report.manualChecks) {
    const file = files.get(item.file);
    if (!file || (item.ruleId !== null && !selected.has(item.ruleId))) fail('manual check references unknown file/rule');
    if (item.category === 'behavior-review' && file.analysisStatus !== 'analyzed') fail('behavior review requires analyzed input');
    if (item.category === 'excluded' && file.analysisStatus !== 'excluded') fail('excluded manual status mismatch');
    if (item.category === 'unanalyzed' && ['analyzed','excluded'].includes(file.analysisStatus)) fail('unanalyzed manual status mismatch');
    if (file.analysisStatus !== 'analyzed' && item.line !== null) fail('unanalyzed input cannot claim an analyzed line location');
  }
  for (const file of files.values()) {
    if (file.analysisStatus !== 'analyzed' && !report.manualChecks.some(item=>item.file === file.file && item.category !== 'behavior-review')) fail('unanalyzed file lacks a manual reason');
  }
  const checks = new Map(), seen = new Set();
  for (const check of report.coverage.checks) {
    if (!check.id || checks.has(check.id)) fail('duplicate/empty registry check ID'); checks.set(check.id, check);
  }
  for (const entry of report.coverage.checkApplicability) {
    const key = entry.file + '\0' + entry.checkId, file = files.get(entry.file), check = checks.get(entry.checkId);
    if (!file || !check || seen.has(key)) fail('unknown/duplicate check applicability'); seen.add(key);
    const expected = check.ruleIds.filter(id=>selected.has(id));
    if (!equal(entry.ruleIds, expected)) fail('check selected-rule mapping mismatch');
    if (!expected.length && entry.status !== 'not-applicable') fail('check without selected rules must be not-applicable');
    if (expected.length && file.analysisStatus !== 'analyzed' && entry.status !== 'not-run') fail('unanalyzed file cannot run a check');
    if (['ran','partial','manual-only'].includes(entry.status) && (file.adapterStatus !== 'completed' || check.adapter !== file.adapter)) fail('check execution requires a completed matching adapter');
  }
  if (seen.size !== files.size * checks.size) fail('missing file/check applicability');
  for (const conflict of report.conflicts) {
    if (!selected.has(conflict.ruleId)) fail('conflict references an unselected rule');
    if (conflict.conflictsWith.some(id=>!selected.has(id)&&!excluded.has(id))) fail('conflict references an unknown rule');
  }
  return report;
}

module.exports = {fingerprintInputs, validateReportData};
