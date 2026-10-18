"""Offline CPU retrieval benchmark. No API, database, or model downloads."""

import argparse
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import platform
import statistics
import threading
import time


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def load_dataset(manifest):
    data = json.loads(manifest.read_text(encoding='utf-8'))
    if data.get('schema_version') != 1 or not isinstance(data.get('kind'), str):
        raise ValueError('Require schema_version 1 and an explicit dataset kind')
    images = data.get('images', [])
    queries = data.get('queries', [])
    if not images or not queries or len(images) > 64 or len(queries) > 64:
        raise ValueError('Require 1..64 images and 1..64 queries per batch')
    ids = [image['id'] for image in images]
    if len(set(ids)) != len(ids) or not all(isinstance(i, str) and i for i in ids):
        raise ValueError('Image IDs must be unique nonempty strings')
    paths = []
    root = manifest.parent.resolve()
    for image in images:
        path = (root / image['file']).resolve()
        if not path.is_relative_to(root):
            raise ValueError('Image files must remain inside the dataset directory')
        if not image.get('license') or not image.get('source'):
            raise ValueError('Each image requires license and source provenance')
        if path.stat().st_size > 20 * 1024 * 1024:
            raise ValueError('Image exceeds 20 MiB benchmark limit')
        if sha256(path) != image['sha256']:
            raise ValueError('Image checksum mismatch')
        paths.append(path)
    for query in queries:
        relevant = query.get('relevant', [])
        if not isinstance(query.get('text'), str) or not query['text'].strip():
            raise ValueError('Each query requires text')
        if not relevant or len(set(relevant)) != len(relevant) or not set(relevant) <= set(ids):
            raise ValueError('Query relevance must contain unique known image IDs')
    return data, paths


def retrieval_metrics(scores, ids, queries, k):
    if len(scores) != len(queries) or any(len(row) != len(ids) for row in scores):
        raise ValueError('Score matrix must be queries by images')
    if any(not math.isfinite(value) for row in scores for value in row):
        raise ValueError('Scores must be finite')
    effective_k = min(k, len(ids))
    precisions, recalls, reciprocal_ranks = [], [], []
    for row, query in zip(scores, queries):
        # Stable manifest order breaks equal-score ties deterministically.
        ranking = sorted(range(len(ids)), key=lambda index: -row[index])
        relevant = set(query['relevant'])
        hits = sum(ids[index] in relevant for index in ranking[:effective_k])
        precisions.append(hits / effective_k)
        recalls.append(hits / len(relevant))
        first = next(rank for rank, index in enumerate(ranking, 1) if ids[index] in relevant)
        reciprocal_ranks.append(1 / first)
    return {'k': effective_k, 'precision_at_k': statistics.mean(precisions),
            'recall_at_k': statistics.mean(recalls), 'mrr': statistics.mean(reciprocal_ranks)}


class MemorySampler:
    """Sample this process's RSS every 10 ms; not an exact allocator peak."""

    def __init__(self):
        import psutil
        self.process = psutil.Process()
        self.peak = self.process.memory_info().rss
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self.sample, daemon=True)

    def sample(self):
        while not self.stop.wait(0.01):
            self.peak = max(self.peak, self.process.memory_info().rss)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.peak = max(self.peak, self.process.memory_info().rss)
        self.stop.set()
        self.thread.join()


class LocalEncoder:
    def __init__(self, model_dir, family, threads):
        # Set before importing the model runtime; never resolve a remote model ID.
        os.environ['HF_HUB_OFFLINE'] = '1'
        os.environ['TRANSFORMERS_OFFLINE'] = '1'
        os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
        os.environ['USE_TF'] = '0'
        import torch
        from transformers import AutoProcessor, CLIPModel, SiglipModel
        self.torch = torch
        self.family = family
        torch.set_num_threads(threads)
        torch.manual_seed(0)
        self.processor = AutoProcessor.from_pretrained(
            str(model_dir), local_files_only=True, trust_remote_code=False)
        model_class = CLIPModel if family == 'clip' else SiglipModel
        self.model = model_class.from_pretrained(
            str(model_dir), local_files_only=True, weights_only=True).to('cpu').float().eval()

    def score(self, paths, texts):
        from PIL import Image, ImageOps
        # Decode per iteration so timings include disk reads and preprocessing.
        images = []
        try:
            for path in paths:
                with Image.open(path) as source:
                    if source.width * source.height > 40_000_000:
                        raise ValueError('Image exceeds 40 million pixels')
                    images.append(ImageOps.exif_transpose(source).convert('RGB'))
            inputs = self.processor(
                images=images, text=texts, return_tensors='pt', truncation=True,
                padding='max_length' if self.family == 'siglip' else True)
            with self.torch.inference_mode():
                outputs = self.model(**inputs)
                image_vectors = self.torch.nn.functional.normalize(outputs.image_embeds, dim=-1)
                text_vectors = self.torch.nn.functional.normalize(outputs.text_embeds, dim=-1)
                return (text_vectors @ image_vectors.T).tolist()
        finally:
            for image in images:
                image.close()


def positive(value):
    result = int(value)
    if result <= 0:
        raise argparse.ArgumentTypeError('Must be positive')
    return result


def run(args):
    manifest = args.manifest.resolve(strict=True)
    model_dir = args.model_dir.resolve(strict=True)
    if not model_dir.is_dir():
        raise ValueError('Model must be a local snapshot directory')
    data, paths = load_dataset(manifest)
    texts = [query['text'] for query in data['queries']]
    ids = [image['id'] for image in data['images']]
    with MemorySampler() as memory:
        start = time.perf_counter()
        encoder = LocalEncoder(model_dir, args.family, args.threads)
        load_seconds = time.perf_counter() - start
        start = time.perf_counter()
        scores = encoder.score(paths, texts)
        first_seconds = time.perf_counter() - start
        for _ in range(args.warmup):
            encoder.score(paths, texts)
        durations = []
        for _ in range(args.runs):
            start = time.perf_counter()
            scores = encoder.score(paths, texts)
            durations.append(time.perf_counter() - start)
    # Hash artifacts after timing. Includes every snapshot file, not just weights.
    artifacts = sorted(path for path in model_dir.rglob('*') if path.is_file()
                       and '.cache' not in path.relative_to(model_dir).parts)
    fingerprints = {path.relative_to(model_dir).as_posix(): sha256(path) for path in artifacts}
    versions = {name: importlib.metadata.version(name)
                for name in ['torch', 'transformers', 'pillow', 'psutil', 'safetensors']}
    report = {
        'schema_version': 1, 'dataset_kind': data.get('kind', 'unspecified'),
        'model_family': args.family, 'model_artifact_sha256': fingerprints,
        'dataset_manifest_sha256': sha256(manifest),
        'environment': {'python': platform.python_version(), 'os': platform.platform(),
                        'processor': platform.processor(), 'logical_cpus': os.cpu_count(),
                        'threads': args.threads, 'device': 'cpu', 'dtype': 'float32',
                        'packages': versions},
        'batch': {'images': len(paths), 'queries': len(texts), 'runs': args.runs,
                  'warmup': args.warmup},
        'timing_scope': 'image decode, preprocessing, image+text encoding, cosine matrix',
        'load_seconds': load_seconds, 'first_batch_seconds': first_seconds,
        'warm_batch_p50_seconds': statistics.median(durations),
        'warm_batch_p95_seconds': sorted(durations)[math.ceil(0.95 * len(durations)) - 1],
        'warm_images_per_second_with_text': len(paths) * len(durations) / sum(durations),
        'sampled_peak_rss_bytes': memory.peak,
        'snapshot_logical_bytes': sum(path.stat().st_size for path in artifacts),
        'retrieval': retrieval_metrics(scores, ids, data['queries'], args.k),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    # Refuse to overwrite a previous result or an input file.
    with args.output.open('x', encoding='utf-8') as stream:
        json.dump(report, stream, indent=2, allow_nan=False)
        stream.write('\n')
    print(f'Wrote {args.output.name}; dataset kind: {report["dataset_kind"]}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', required=True, type=Path)
    parser.add_argument('--model-dir', required=True, type=Path)
    parser.add_argument('--family', required=True, choices=['clip', 'siglip'])
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--threads', type=positive, default=2)
    parser.add_argument('--runs', type=positive, default=10)
    parser.add_argument('--warmup', type=positive, default=2)
    parser.add_argument('--k', type=positive, default=5)
    args = parser.parse_args()
    if args.output.exists():
        parser.error('Output exists; choose a new filename')
    try:
        run(args)
    except (ValueError, OSError, ImportError) as error:
        raise SystemExit(f'Benchmark failed ({type(error).__name__}); check local inputs and dependencies') from error


if __name__ == '__main__':
    main()
