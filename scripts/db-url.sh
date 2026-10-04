#!/usr/bin/env bash
# Resolve the real Postgres test DSN without printing it.
# Tool output masks secrets, so a hand-typed URL fails auth invisibly; the only
# trustworthy source is the credential committed in tests/device-streaming.test.ts.
set -euo pipefail
cd "$(dirname "$0")/.."
python3 - <<'PY'
import re, pathlib, sys
src = pathlib.Path("tests/device-streaming.test.ts").read_text()
m = re.search(r'"(postgresql://[^"]+)"', src)
if not m:
    sys.exit("no postgresql:// URL found in tests/device-streaming.test.ts")
sys.stdout.write(m.group(1))
PY