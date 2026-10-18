# ML service contract v1 — draft proposal

This directory contains executable **proposed wire definitions**, generated JSON
Schemas and illustrative fixtures. It implements no HTTP server, worker, database
schema, authorization, or production inference. The proposal requires backend
review before callers or persistence are integrated.

Read [the service proposal](../../../docs/ml/ml-service-contract-proposal.md) and
[privacy/lifecycle requirements](../../../docs/ml/ml-data-and-privacy-requirements.md).

From this directory, with Python 3.13 and `requirements.txt` installed:

```powershell
python export_schemas.py
python make_examples.py
python -m unittest discover -v
```

Pydantic is the source of truth for the draft schemas. Regeneration is explicit;
fixtures and schemas are committed candidates for Python and TypeScript consumers
to review. The tests check that generated artifacts match their definitions.
JSON Schema covers field shapes; dimension equality, L2 norm, request/result
binding and transactional lifecycle checks need the additional rules in the
proposal. A passing schema alone does not authorize an asset or validate pixels.

`can_persist_image` is a pure illustration of a worker's compare-and-set gate.
It has no database access and supplies no transactional or race-safety guarantee.
Do not call it outside a transaction and assume persistence is safe.

Example model IDs, digests, three-dimensional vectors and image descriptors are
invented fixtures. `fixture-bytes` is not a JPEG. No example represents actual
inference, a model recommendation, or an authorized production asset.
