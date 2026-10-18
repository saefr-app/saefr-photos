"""Create an operator-owned registry from an already prepared local snapshot."""

import argparse
from pathlib import Path

from .engine import prepare_registry


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model-dir', required=True, type=Path)
    parser.add_argument('--model-id', required=True)
    parser.add_argument('--revision', required=True)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    if args.output.resolve().is_relative_to(args.model_dir.resolve()):
        parser.error('Registry must be outside the model snapshot')
    registry = prepare_registry(args.model_dir, args.model_id, args.revision)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open('x', encoding='utf-8') as stream:
        stream.write(registry.model_dump_json(indent=2) + '\n')
    print('Registry prepared; review upstream revision/license before integration')


if __name__ == '__main__':
    main()
