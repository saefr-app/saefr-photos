"""Regenerate draft JSON Schema artifacts from the Python contract."""

import json
from pathlib import Path

from contract import SCHEMAS


if __name__ == '__main__':
    root = Path(__file__).parent / 'schemas'
    root.mkdir(exist_ok=True)
    for name, model in SCHEMAS.items():
        schema = model.model_json_schema()
        schema['$schema'] = 'https://json-schema.org/draft/2020-12/schema'
        schema['$comment'] = ('Draft proposal. Shape validation only; use cross-field '
                              'checks for vector dimension/norm and request/result binding.')
        (root / f'{name}.schema.json').write_text(
            json.dumps(schema, indent=2, sort_keys=True) + '\n', encoding='utf-8')
