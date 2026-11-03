"""Reference consumer: no Exness connection or Python dependency required."""
import json
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
