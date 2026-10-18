"""Pinned local CLIP candidate; no model installation or remote inference."""

import hashlib
from importlib.metadata import version
import io
import json
import os
from pathlib import Path
import re
from typing import Literal

from .contract import Digest, ModelSpec, WireModel
from .errors import ServiceError


def digest_json(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'),
                                     ensure_ascii=True).encode('utf-8')).hexdigest()


def preprocessing_spec():
    return {
        'adapter': 'saefr-clip-candidate-2',
        'implementation': hashlib.sha256(Path(__file__).read_bytes().replace(b'\r\n', b'\n')).hexdigest(),
        'image': 'single-frame;exif-transpose;RGB;CLIPProcessor-slow',
        'text': 'CLIP-tokenizer;special-tokens;reject-over-context;no-truncation',
        'output': 'cpu;float32;l2;dimensions-from-model-config',
        'torch': version('torch'), 'transformers': version('transformers'),
        'pillow': version('Pillow'),
        'tokenizers': version('tokenizers'), 'numpy': version('numpy'),
        'safetensors': version('safetensors'), 'huggingface-hub': version('huggingface-hub'),
    }


class Registry(WireModel):
    schema_version: Literal['1']
    family: Literal['clip']
    model: ModelSpec
    files: dict[str, Digest]
    preprocessing: dict[str, str]


def file_hash(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def snapshot_files(directory):
    root = directory.resolve(strict=True)
    paths = {}
    for path in root.iterdir():
        if path.name == '.cache' and path.is_dir():
            continue
        if (not path.is_file() or not re.fullmatch(r'[A-Za-z0-9_.-]+', path.name)
                or path.suffix not in {'.json', '.txt', '.bin', '.safetensors'}
                or not path.resolve().is_relative_to(root)):
            raise ValueError('Unsupported snapshot layout')
        paths[path.name] = file_hash(path)
    if not {'config.json', 'preprocessor_config.json', 'vocab.json', 'merges.txt'} <= paths.keys():
        raise ValueError('Incomplete model snapshot')
    if not any(name.endswith(('.bin', '.safetensors')) for name in paths):
        raise ValueError('Missing model weights')
    return paths


def prepare_registry(directory, model_id, revision):
    files = snapshot_files(directory)
    config = json.loads((directory / 'config.json').read_text())
    if config.get('model_type') != 'clip':
        raise ValueError('Only CLIP is implemented in this candidate')
    preprocessing = preprocessing_spec()
    return Registry(schema_version='1', family='clip', files=files,
                    preprocessing=preprocessing, model=ModelSpec(
                        model_id=model_id, revision=revision,
                        artifact_digest=digest_json(files),
                        preprocessing_digest=digest_json(preprocessing),
                        dimensions=config['projection_dim']))


def verify_registry(directory, registry_path):
    if registry_path.stat().st_size > 128 * 1024:
        raise ValueError('Registry too large')
    registry = Registry.model_validate_json(registry_path.read_bytes())
    if (snapshot_files(directory) != registry.files
            or digest_json(registry.files) != registry.model.artifact_digest
            or registry.preprocessing != preprocessing_spec()
            or digest_json(registry.preprocessing) != registry.model.preprocessing_digest):
        raise ValueError('Model registry integrity mismatch')
    return registry


def decode_image(content, media_type):
    from PIL import Image, ImageOps, UnidentifiedImageError
    try:
        with Image.open(io.BytesIO(content)) as source:
            detected = {'JPEG': 'image/jpeg', 'PNG': 'image/png', 'WEBP': 'image/webp'}.get(source.format)
            if detected is None:
                raise ServiceError('UNSUPPORTED_MEDIA')
            if detected != media_type or getattr(source, 'n_frames', 1) != 1:
                raise ServiceError('INVALID_IMAGE')
            if source.width * source.height > 40_000_000:
                raise ServiceError('INVALID_IMAGE')
            source.load()
            with ImageOps.exif_transpose(source) as oriented:
                return oriented.convert('RGB')
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
        raise ServiceError('INVALID_IMAGE') from None


class ClipEngine:
    def __init__(self, directory, registry_path, threads):
        self.directory, self.registry_path, self.threads = directory, registry_path, threads

    def load(self):
        os.environ['HF_HUB_OFFLINE'] = '1'
        os.environ['TRANSFORMERS_OFFLINE'] = '1'
        os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
        os.environ['USE_TF'] = '0'
        registry = verify_registry(self.directory, self.registry_path)
        import torch
        from transformers import CLIPModel, CLIPProcessor
        torch.set_num_threads(self.threads)
        self.torch = torch
        self.processor = CLIPProcessor.from_pretrained(
            str(self.directory), local_files_only=True, trust_remote_code=False, use_fast=False)
        self.model = CLIPModel.from_pretrained(
            str(self.directory), local_files_only=True, weights_only=True).to('cpu').float().eval()
        if self.model.config.projection_dim != registry.model.dimensions:
            raise ValueError('Model dimensions mismatch')
        self.spec = registry.model

    def normalize(self, features):
        return self.torch.nn.functional.normalize(features.float(), dim=-1)[0].tolist()

    def embed_image(self, content, media_type):
        with decode_image(content, media_type) as image:
            inputs = self.processor(images=image, return_tensors='pt')
            with self.torch.inference_mode():
                return self.normalize(self.model.get_image_features(**inputs))

    def embed_text(self, text):
        inputs = self.processor.tokenizer(text, return_tensors='pt', truncation=False)
        if inputs['input_ids'].shape[1] > self.model.config.text_config.max_position_embeddings:
            raise ServiceError('INVALID_REQUEST')
        with self.torch.inference_mode():
            return self.normalize(self.model.get_text_features(**inputs))
