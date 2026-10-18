# Initial model and license matrix

Research snapshot: 18 October 2026. No production model chosen.
Review actual license artifacts for the exact weight revision before packaging;
a model-card label is evidence to investigate, not final distribution approval.

| Candidate | Purpose / runtime | License evidence | Footprint and remaining evidence |
| --- | --- | --- | --- |
| `openai/clip-vit-base-patch32` | Established image/text retrieval baseline; Transformers + PyTorch + Pillow | Upstream CLIP repository carries MIT. The model card describes research intent and deployment limitations; preserve this distinction in review. | Measure local safetensors snapshot bytes, load time and RSS; no local B/32 measurements yet. |
| `google/siglip-base-patch16-224` | Alternative paired encoder; Transformers + PyTorch, tokenizer dependencies | Publisher's model page labels Apache-2.0. Archive exact revision's license/notices before redistribution. | Measure local snapshot; quality and CPU cost versus CLIP are unverified here. |
| `apple/MobileCLIP-S0` | Smaller-model candidate; upstream MobileCLIP runtime | Model page labels `apple-amlr`; repository LICENSE includes separate treatment of code and model artifacts. Read the applicable model terms rather than assuming the code license applies to weights. | Requires its own adapter and exact checkpoint review; vendor performance is not a measurement on our hardware. |

Commercial use, redistribution and notice obligations must be recorded from the
chosen artifact's full license before shipping. They remain release-review items;
this research module does not bundle weights. Runtime dependency notices must be
reviewed separately. No external inference API is needed for these local designs.

Do not use a text-only sentence embedding model as a photo encoder. Image and
text vectors must come from compatible encoders/preprocessing of the same model
revision. Never compare or mix vectors across revisions without re-indexing.

## Primary sources checked

- [CLIP model card](https://huggingface.co/openai/clip-vit-base-patch32)
- [CLIP repository license](https://github.com/openai/CLIP/blob/main/LICENSE)
- [SigLIP model card](https://huggingface.co/google/siglip-base-patch16-224)
- [MobileCLIP-S0 model card](https://huggingface.co/apple/MobileCLIP-S0)
- [MobileCLIP repository license](https://github.com/apple-aiml-research/ml-mobileclip/blob/main/LICENSE)
- [Transformers CLIP API](https://huggingface.co/docs/transformers/model_doc/clip)
- [Transformers SigLIP API](https://huggingface.co/docs/transformers/model_doc/siglip)

## Immich reference

[Immich's ML entry point](https://github.com/immich-app/immich/blob/main/machine-learning/immich_ml/main.py)
illustrates a separate inference service, image/text input, model caching and
thread configuration. This module is independently written and copies no Immich
implementation. Its models, database layout and production defaults are not
automatically Saefr's decisions.
