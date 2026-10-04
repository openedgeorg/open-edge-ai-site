"""Same-origin static server for the vanilla client. It does not claim Gate 1 and it does not call a model."""

from __future__ import annotations

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "site"


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Serve site/ for local conversation development")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args(argv)
    handler = partial(SimpleHTTPRequestHandler, directory=str(SITE))
    server = ThreadingHTTPServer((args.host, args.port), handler)
    print(f"development client http://{args.host}:{args.port}/ (not a Gate 1 claim)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
