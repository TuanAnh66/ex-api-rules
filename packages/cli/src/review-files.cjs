'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const {publicFile} = require('./legacy-core.cjs');
const {analyze} = require('./adapters/javascript.cjs');

const DEFAULT_FILE_BYTES = 1024 * 1024;
const DEFAULT_TOTAL_BYTES = 16 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
function reviewPolicy(options = {}) {
  function integer(value, fallback, maximum, name) {
    if (value === undefined) return fallback;
    if (!['string', 'number'].includes(typeof value) || !/^[1-9][0-9]*$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum) throw Error(name + ' must be an integer between 1 and ' + maximum);
    return Number(value);
  }
  return {
    maxFileBytes: integer(options['max-file-bytes'], DEFAULT_FILE_BYTES, 16 * 1024 * 1024, '--max-file-bytes'),
    maxTotalBytes: integer(options['max-total-bytes'], DEFAULT_TOTAL_BYTES, 256 * 1024 * 1024, '--max-total-bytes'),
    chunkBytes: CHUNK_BYTES,
    fileOrder: 'utf16-path-order',
    selection: options.base ? 'changed-and-untracked' : 'explicit',
    baseRef: options.base || null,
    untrackedIgnored: 'exclude-in-base-only',
    privatePaths: 'reject-explicit-report-base'
  };
}

const adapterFor = file => /\.(cjs|mjs|js)$/.test(file) ? 'javascript' : 'unsupported';
const sameFile = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);
const safeSize = stat => stat.size <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(stat.size) : null;

function reviewFiles(root, files, bundle, validateTransfer, options = {}) {
  const policy = reviewPolicy(options);
  let remaining = policy.maxTotalBytes;
  return [...new Set(files.map(file => file.replace(/\\/g, '/')))].sort().map(file => {
    const result = {file, sha256: null, hashStatus: 'not-computed', adapter: adapterFor(file), analysisStatus: 'read-failed', adapterStatus: 'not-run', reason: null, sizeBytes: null, bytesRead: 0, budgetBytesCharged: 0, findings: [], manual: [], coverage: [], checkRuns: []};
    function unanalysed(status, reason) {
      result.analysisStatus = status; result.reason = reason;
      result.manual = [{file, reason}];
      return result;
    }
    let abs;
    try { abs = publicFile(root, file); } catch (error) {
      if (error.code === 'ENOENT') return unanalysed('missing', 'Deleted or missing file; not read or analyzed.');
      if (['EACCES', 'EPERM'].includes(error.code)) return unanalysed('read-failed', 'File path is inaccessible; not read or analyzed.');
      if (error.code === 'ENOTDIR') return unanalysed('not-regular', 'File path is not a regular file; not analyzed.');
      if (error.code) return unanalysed('read-failed', 'File path could not be inspected; not read or analyzed.');
      if (options.base) return unanalysed('excluded', 'Excluded private/external path; not read or analyzed.');
      throw error;
    }
    let fd;
    try {
      const initial = fs.statSync(abs, {bigint: true});
      result.sizeBytes = safeSize(initial);
      if (!initial.isFile()) return unanalysed('not-regular', 'Not a regular file; not read or analyzed.');
      if (result.sizeBytes === null) return unanalysed('read-failed', 'File size is outside the safe integer range; not read or analyzed.');
      if (result.sizeBytes > policy.maxFileBytes) return unanalysed('budget-exceeded', 'File exceeds the per-file byte limit; no content read or hash computed.');
      if (result.sizeBytes > remaining) return unanalysed('budget-exceeded', 'File exceeds the remaining aggregate byte budget; no content read or hash computed.');
      publicFile(root, file);
      fd = fs.openSync(abs, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0) | (fs.constants.O_NOFOLLOW || 0));
      const opened = fs.fstatSync(fd, {bigint: true});
      if (!opened.isFile() || !sameFile(initial, opened)) return unanalysed('changed-during-read', 'File identity changed before reading; not analyzed and no hash published.');
      const limit = Math.min(policy.maxFileBytes, remaining), buffer = Buffer.allocUnsafe(Math.min(policy.chunkBytes, limit));
      const hash = crypto.createHash('sha256'), chunks = [];
      while (result.budgetBytesCharged < limit) {
        const requested = Math.min(buffer.length, limit - result.budgetBytesCharged);
        // Reserve before I/O. If read throws, retain that reservation because
        // the number of bytes consumed by the failed operation is unknown.
        remaining -= requested; result.budgetBytesCharged += requested;
        const count = fs.readSync(fd, buffer, 0, requested, null);
        if (!Number.isInteger(count) || count < 0 || count > requested) throw Error('Invalid bounded read result');
        remaining += requested - count; result.budgetBytesCharged -= requested - count;
        if (count === 0) break;
        result.bytesRead += count; hash.update(buffer.subarray(0, count));
        if (result.adapter === 'javascript') chunks.push(Buffer.from(buffer.subarray(0, count)));
      }
      const final = fs.fstatSync(fd, {bigint: true});
      if (final.size > BigInt(result.bytesRead)) {
        if (final.size > BigInt(limit) || result.budgetBytesCharged === limit) return unanalysed('budget-exceeded', 'File grew beyond the bounded read budget; partial hash discarded and file not analyzed.');
        return unanalysed('changed-during-read', 'File grew after observed EOF; partial hash discarded and file not analyzed.');
      }
      if (!sameFile(opened, final) || result.bytesRead !== Number(final.size)) return unanalysed('changed-during-read', 'File changed while reading; partial hash discarded and file not analyzed.');
      publicFile(root, file);
      if (!sameFile(final, fs.statSync(abs, {bigint: true}))) return unanalysed('changed-during-read', 'File path changed while reading; hash discarded and file not analyzed.');
      result.sha256 = hash.digest('hex'); result.hashStatus = 'complete';
      fs.closeSync(fd); fd = undefined;
      if (result.adapter === 'unsupported') return unanalysed('unsupported', 'No language adapter; this file has not been analyzed. Complete hash computed in bounded chunks.');
      try {
        const text = new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks, result.bytesRead));
        const analysis = analyze(text, file, bundle.rules, validateTransfer);
        if (analysis.parseStatus === 'failed') {
          result.adapterStatus = 'parse-failed';
          return unanalysed('parse-failed', 'JavaScript parser could not analyze this file; human review required.');
        }
        result.analysisStatus = 'analyzed'; result.adapterStatus = 'completed';
        Object.assign(result, {findings: analysis.findings, manual: analysis.manual, coverage: analysis.coverage, checkRuns: analysis.checkRuns});
      } catch (error) {
        if (error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA') {
          result.adapterStatus = 'parse-failed';
          return unanalysed('parse-failed', 'Invalid UTF-8 JavaScript; parser input unavailable and human review required.');
        }
        result.adapterStatus = 'failed';
        return unanalysed('analysis-failed', 'JavaScript adapter could not complete analysis; human review required.');
      }
      return result;
    } catch (error) {
      result.sha256 = null; result.hashStatus = 'not-computed';
      return unanalysed(error.code === 'ENOENT' ? 'missing' : 'read-failed', 'File could not be read completely; no complete hash or analysis available.');
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch {
        result.sha256 = null; result.hashStatus = 'not-computed';
        result.findings = []; result.checkRuns = []; result.coverage = [];
        result.adapterStatus = 'not-run';
        unanalysed('read-failed', 'File descriptor could not be finalized; no complete hash or analysis available.');
      }
    }
  });
}
module.exports = {reviewPolicy, reviewFiles};
