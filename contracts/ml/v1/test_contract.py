from copy import deepcopy
import json
from pathlib import Path
import unittest

from jsonschema import Draft202012Validator
from pydantic import ValidationError

from contract import (ERROR_STATUS, RETRYABLE, SCHEMAS, ErrorResult, ImageRequest,
                      ImageResult, ModelSpec, Subject, TextRequest, TextResult,
                      can_persist_image, image_job_key, matches_text_request,
                      validate_image_bytes)
from make_examples import examples


class ContractTests(unittest.TestCase):
    def setUp(self):
        self.fixtures = examples()
        self.request = ImageRequest.model_validate(self.fixtures['image-request'])
        self.result = ImageResult.model_validate(self.fixtures['image-result'])

    def test_published_examples_match_models_and_json_schemas(self):
        root = Path(__file__).parent
        for name, model in SCHEMAS.items():
            with self.subTest(name=name):
                fixture = json.loads((root / 'examples' / f'{name}.json').read_text())
                self.assertEqual(fixture, self.fixtures[name])
                model.model_validate_json(json.dumps(fixture))
                schema = json.loads((root / 'schemas' / f'{name}.schema.json').read_text())
                Draft202012Validator.check_schema(schema)
                Draft202012Validator(schema).validate(fixture)
                expected = model.model_json_schema()
                expected['$schema'] = schema['$schema']
                expected['$comment'] = schema['$comment']
                self.assertEqual(schema, expected)

    def test_unknown_fields_paths_and_urls_rejected(self):
        for key, value in [('storage_path', '/private/photo.jpg'),
                           ('url', 'http://169.254.169.254/latest/meta-data')]:
            for location in ['root', 'image']:
                with self.subTest(key=key, location=location):
                    fixture = deepcopy(self.fixtures['image-request'])
                    (fixture if location == 'root' else fixture['image'])[key] = value
                    with self.assertRaises(ValidationError):
                        ImageRequest.model_validate(fixture)

    def test_strict_numeric_limits(self):
        for value in ['1', True, 0, 9_007_199_254_740_992]:
            fixture = deepcopy(self.fixtures['image-request'])
            fixture['subject']['generation'] = value
            with self.subTest(value=value), self.assertRaises(ValidationError):
                ImageRequest.model_validate(fixture)
        fixture = deepcopy(self.fixtures['image-request'])
        fixture['image']['byte_size'] = 20 * 1024 * 1024 + 1
        with self.assertRaises(ValidationError):
            ImageRequest.model_validate(fixture)

    def test_unpinned_model_bad_version_and_uuid_rejected(self):
        for field, value in [('schema_version', '2'), ('request_id', 'not-a-uuid')]:
            fixture = deepcopy(self.fixtures['image-request'])
            fixture[field] = value
            with self.assertRaises(ValidationError):
                ImageRequest.model_validate(fixture)
        fixture = deepcopy(self.fixtures['image-request'])
        fixture['model']['revision'] = 'main'
        with self.assertRaises(ValidationError):
            ImageRequest.model_validate(fixture)

    def test_nonfinite_dimension_and_nonunit_vectors_rejected(self):
        for vector in [[0.0, 0.0, 0.0], [1.0, 0.0], [float('nan'), 0.0, 0.0],
                       [float('inf'), 0.0, 0.0], [1.0, 1.0, 1.0], [True, 0.0, 0.0]]:
            fixture = deepcopy(self.fixtures['image-result'])
            fixture['embedding'] = vector
            with self.subTest(vector=vector), self.assertRaises(ValidationError):
                ImageResult.model_validate(fixture)

    def test_retry_attempts_preserve_key(self):
        # Independently reproduced with Node's crypto and recursive key sorting.
        self.assertEqual(image_job_key(self.request),
                         'ml-v1-8da3f10b3854a91d624962dc05202582de78b41e95976d83b87a6eed832bb1dc')
        fixture = deepcopy(self.fixtures['image-request'])
        fixture['request_id'] = '00000000-0000-4000-8000-000000000099'
        retry = ImageRequest.model_validate(fixture)
        self.assertEqual(image_job_key(self.request), image_job_key(retry))

    def test_job_key_changes_with_generation_scope_content_and_model(self):
        for section, field, value in [
            ('subject', 'generation', 2),
            ('subject', 'scope_id', '00000000-0000-4000-8000-000000000099'),
            ('image', 'sha256', 'a' * 64), ('model', 'preprocessing_digest', 'b' * 64),
            ('model', 'artifact_digest', 'c' * 64), ('model', 'revision', 'd' * 40)]:
            fixture = deepcopy(self.fixtures['image-request'])
            fixture[section][field] = value
            with self.subTest(field=field):
                self.assertNotEqual(image_job_key(self.request),
                                    image_job_key(ImageRequest.model_validate(fixture)))

    def test_current_result_can_persist(self):
        self.assertTrue(can_persist_image(self.request, self.result,
                                         current_subject=self.request.subject,
                                         current_model=self.request.model, eligible=True))

    def test_deleted_disabled_and_restored_assets_reject_stale_results(self):
        for subject, eligible in [(None, True), (self.request.subject, False),
                                  (Subject(**{**self.request.subject.model_dump(), 'generation': 2}), True)]:
            with self.subTest(subject=subject, eligible=eligible):
                self.assertFalse(can_persist_image(self.request, self.result,
                                                  current_subject=subject,
                                                  current_model=self.request.model,
                                                  eligible=eligible))

    def test_wrong_model_content_scope_and_attempt_rejected(self):
        for section, field, value in [
            ('model', 'artifact_digest', 'a' * 64),
            ('subject', 'scope_id', '00000000-0000-4000-8000-000000000099'),
            (None, 'request_id', '00000000-0000-4000-8000-000000000099'),
            (None, 'image_sha256', 'b' * 64)]:
            fixture = deepcopy(self.fixtures['image-result'])
            (fixture[section] if section else fixture)[field] = value
            result = ImageResult.model_validate(fixture)
            with self.subTest(field=field):
                self.assertFalse(can_persist_image(self.request, result,
                                                  current_subject=self.request.subject,
                                                  current_model=self.request.model, eligible=True))
        current = ModelSpec(**{**self.request.model.model_dump(), 'revision': 'a' * 40})
        self.assertFalse(can_persist_image(self.request, self.result,
                                          current_subject=self.request.subject,
                                          current_model=current, eligible=True))

    def test_transfer_integrity(self):
        validate_image_bytes(self.request, b'fixture-bytes')
        for content in [b'', b'changed-bytes']:
            with self.assertRaises(ValueError):
                validate_image_bytes(self.request, content)

    def test_text_context_and_empty_queries(self):
        request = TextRequest.model_validate(self.fixtures['text-request'])
        result = TextResult.model_validate(self.fixtures['text-result'])
        self.assertTrue(matches_text_request(request, result))
        fixture = deepcopy(self.fixtures['text-result'])
        fixture['scope_id'] = '00000000-0000-4000-8000-000000000099'
        self.assertFalse(matches_text_request(request, TextResult.model_validate(fixture)))
        for text in [' ', '', 'x' * 1025]:
            fixture = deepcopy(self.fixtures['text-request'])
            fixture['text'] = text
            with self.assertRaises(ValidationError):
                TextRequest.model_validate(fixture)

    def test_retry_classification_and_sanitized_errors(self):
        self.assertEqual(set(ERROR_STATUS), set(ErrorResult.model_json_schema()['properties']['code']['enum']))
        self.assertEqual(RETRYABLE, {'BUSY', 'MODEL_UNAVAILABLE', 'TIMEOUT', 'INTERNAL'})
        fixture = deepcopy(self.fixtures['error-result'])
        fixture['code'] = 'INVALID_IMAGE'
        with self.assertRaises(ValidationError):
            ErrorResult.model_validate(fixture)
        fixture['retry_after_ms'] = None
        fixture['detail'] = '/private/path and credentials'
        with self.assertRaises(ValidationError):
            ErrorResult.model_validate(fixture)


if __name__ == '__main__':
    unittest.main()
