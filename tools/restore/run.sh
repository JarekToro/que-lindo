#!/bin/sh
# HOST=0.0.0.0 exposes the app to your LAN (phone / other machines). Default is localhost only.
cd "$(dirname "$0")"
exec .venv/bin/uvicorn server:app --host "${HOST:-127.0.0.1}" --port "${PORT:-8787}" "$@"
