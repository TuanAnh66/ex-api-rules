"""Reference consumer: no Exness connection or Python dependency required."""
import json
import hashlib
from pathlib import Path


def canonical(value, legacy=False):
    if isinstance(value, dict):
        keys = sorted(value, key=lambda s: s.encode('utf-16-be'))
        if legacy:
            # ECMAScript array indices precede other keys, in numeric order.
            indices = [key for key in keys if key.isascii() and key.isdecimal()
                       and str(int(key)) == key and int(key) < 4294967295]
            keys = sorted(indices, key=int) + [key for key in keys if key not in indices]
        return {key: canonical(value[key], legacy) for key in keys}
    if isinstance(value, list):
        return [canonical(item, legacy) for item in value]
    if isinstance(value, float):
        raise ValueError('Protocol decimal values must be strings')
    return value


fixture = json.loads(Path(__file__).with_name('protocol-v1.json').read_text(encoding='utf-8'))
assert json.dumps(canonical(fixture['input']), ensure_ascii=False, separators=(',', ':')) == fixture['canonical']
for case in fixture['canonicalCases']:
    assert json.dumps(canonical(case['input']), ensure_ascii=False, separators=(',', ':')) == case['canonical'], case['name']
    assert json.dumps(canonical(case['input'], legacy=True), ensure_ascii=False, separators=(',', ':')) == case['legacyCanonical'], case['name']
assert fixture['unsupported']['adapter'] == 'unsupported'
print('Python reference consumer agrees with the language-neutral canonicalization fixture.')

reports = json.loads(Path(__file__).with_name('report-protocol-v2.json').read_text(encoding='utf-8'))
report = reports['reports']['v2']
keys = ['schemaVersion', 'toolVersion', 'ruleVersion', 'bundleHash', 'artifactSha256',
        'profile', 'codeVersion', 'inputPolicy', 'findings', 'manualChecks',
        'coverage', 'conflicts', 'limitations']
payload = {key: report[key] for key in keys}
encoded = json.dumps(canonical(payload), ensure_ascii=False, separators=(',', ':')).encode('utf-8')
assert hashlib.sha256(encoded).hexdigest() == report['resultFingerprint']
file = report['codeVersion']['files'][0]
assert hashlib.sha256(reports['file']['content'].encode('utf-8')).hexdigest() == file['sha256']
assert file['analysisStatus'] == 'unsupported' and file['adapterStatus'] == 'not-run'
assert report['coverage']['unanalyzedFiles'] == [item['file'] for item in report['codeVersion']['files']]
assert report['coverage']['checkApplicability'][0]['status'] == 'not-run'
assert report['codeVersion']['files'][1]['sha256'] is None
assert report['codeVersion']['files'][1]['analysisStatus'] == 'budget-exceeded'
assert reports['reports']['v1']['schemaVersion'] == 1
print('Python reference consumer agrees with report v2 identity, null/status policy and fingerprint.')
