"""Reference consumer: no Exness connection or Python dependency required."""
import json
from pathlib import Path


def canonical(value):
    if isinstance(value, dict):
        return {key: canonical(value[key]) for key in sorted(value, key=lambda s: s.encode('utf-16-be'))}
    if isinstance(value, list):
        return [canonical(item) for item in value]
    if isinstance(value, float):
        raise ValueError('Protocol decimal values must be strings')
    return value


fixture = json.loads(Path(__file__).with_name('protocol-v1.json').read_text(encoding='utf-8'))
assert json.dumps(canonical(fixture['input']), ensure_ascii=False, separators=(',', ':')) == fixture['canonical']
assert fixture['unsupported']['adapter'] == 'unsupported'
print('Python reference consumer agrees with the language-neutral canonicalization fixture.')
