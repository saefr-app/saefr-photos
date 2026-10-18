# ML semantic-search core

Date: 18 October 2026. Branch: `codex/ml-search`. Scope: the user's batch request
to implement the remaining core ML modules. Tested foundation branches are
explicit dependencies merged into this local branch; the shared remote
integration and main branches are unchanged.

Implemented a separate Node coordinator index, exact cosine top-k ranking,
scope/model/generation filtering and persistent versioned embeddings. A
size-bounded local inference client validates full request/result identity and
vector invariants. Parameterized SQLite queries and transactional publication
reject stale results. An application ID/version guard refuses unrelated index
databases. This is derived-data storage in a new owned directory; it neither
reads nor migrates canonical PostgreSQL or the photo library.

Validation: 5 focused search/client tests pass, including scope isolation,
restart persistence, stale generation, quotas, malformed vectors, model/content
binding and retry classification. The separate HTTP orchestration and durable
worker are added in the following modules and tested together afterward.

Node 22.19 requires `--experimental-sqlite`; the container targets Node 24.
The portable initial index uses exact scanning, bounded to 10,000 tracked assets
per scope and configurable source-cache quota. It is not an approximate nearest
neighbor index for large libraries. Production Postgres/vector-extension choices
remain independent of this removable local implementation.
