import json
from pathlib import Path
import tempfile
import unittest
import subprocess
import sys

from benchmark import load_dataset, retrieval_metrics
from make_fixture import generate


class BenchmarkTests(unittest.TestCase):
    def test_multiple_relevant_images_and_rank(self):
        result = retrieval_metrics([[0.1, 0.9, 0.8]], ['a', 'b', 'c'],
                                   [{'relevant': ['a', 'c']}], 2)
        self.assertEqual(result, {'k': 2, 'precision_at_k': 0.5,
                                  'recall_at_k': 0.5, 'mrr': 0.5})

    def test_k_clamped_and_ties_stable(self):
        result = retrieval_metrics([[1, 1]], ['a', 'b'], [{'relevant': ['b']}], 5)
        self.assertEqual(result['k'], 2)
        self.assertEqual(result['mrr'], 0.5)

    def test_nonfinite_scores_rejected(self):
        with self.assertRaises(ValueError):
            retrieval_metrics([[float('nan')]], ['a'], [{'relevant': ['a']}], 1)

    def test_existing_output_refused_before_loading(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / 'existing.json'
            output.write_text('preserve me')
            result = subprocess.run(
                [sys.executable, str(Path(__file__).with_name('benchmark.py')),
                 '--manifest', 'missing.json', '--model-dir', 'missing-model',
                 '--family', 'clip', '--output', str(output)], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('Output exists', result.stderr)
            self.assertEqual(output.read_text(), 'preserve me')

    def test_fixture_checksums_and_tampering(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / 'fixtures'
            generate(directory)
            data, paths = load_dataset(directory / 'manifest.json')
            self.assertEqual(len(paths), 6)
            self.assertEqual(data['kind'], 'synthetic-smoke-only')
            paths[0].write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError, 'checksum'):
                load_dataset(directory / 'manifest.json')

    def test_manifest_rejects_escape_missing_provenance_and_bad_labels(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / 'fixtures'
            generate(directory)
            manifest = directory / 'manifest.json'
            original = json.loads(manifest.read_text())
            for mutate in [lambda d: d['images'][0].update(file='../outside.ppm'),
                           lambda d: d['images'][0].update(license=''),
                           lambda d: d['queries'][0].update(relevant=['unknown'])]:
                data = json.loads(json.dumps(original))
                mutate(data)
                manifest.write_text(json.dumps(data))
                with self.assertRaises(ValueError):
                    load_dataset(manifest)


if __name__ == '__main__':
    unittest.main()
