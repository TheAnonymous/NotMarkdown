#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if command -v python3 >/dev/null 2>&1; then
  PYTHON=python3
elif command -v python >/dev/null 2>&1; then
  PYTHON=python
else
  echo "Python 3.9 or newer is required." >&2
  exit 127
fi

exec "$PYTHON" -B "$SCRIPT_DIR/package_sources.py" "$@"
