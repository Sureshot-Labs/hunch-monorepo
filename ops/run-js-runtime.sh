#!/bin/sh
set -eu

runtime="${HUNCH_JS_RUNTIME:-node}"

case "$runtime" in
  node|bun)
    exec "$runtime" "$@"
    ;;
  *)
    echo "Unsupported HUNCH_JS_RUNTIME=${runtime}; expected node or bun" >&2
    exit 64
    ;;
esac
