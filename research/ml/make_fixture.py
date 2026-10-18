"""Generate deterministic synthetic PPMs; no photo library or downloads needed."""

import argparse
import hashlib
import json
from pathlib import Path


def generate(directory):
    directory.mkdir(parents=True, exist_ok=False)
    images, queries = [], []
    for color, rgb in [('red', (230, 20, 20)), ('green', (20, 200, 20)), ('blue', (20, 20, 230))]:
        for shape in ['square', 'circle']:
            image_id = f'{color}-{shape}'
            pixels = bytearray()
            for y in range(224):
                for x in range(224):
                    inside = (48 <= x < 176 and 48 <= y < 176) if shape == 'square' else (
                        (x - 112) ** 2 + (y - 112) ** 2 <= 64 ** 2)
                    pixels.extend(rgb if inside else (255, 255, 255))
            content = b'P6\n224 224\n255\n' + bytes(pixels)
            filename = f'{image_id}.ppm'
            (directory / filename).write_bytes(content)
            images.append({'id': image_id, 'file': filename,
                           'sha256': hashlib.sha256(content).hexdigest(),
                           'license': 'project-generated synthetic fixture',
                           'source': 'make_fixture.py: geometric primitives; no external media'})
            queries.append({'text': f'a {color} {shape} on a white background',
                            'relevant': [image_id]})
    manifest = {'schema_version': 1, 'kind': 'synthetic-smoke-only',
                'images': images, 'queries': queries}
    (directory / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    generate(parser.parse_args().directory)
