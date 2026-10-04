"""Formal evaluation commands. Missing DA-01 or approved content stays pending and calls no model."""

from __future__ import annotations

import argparse
import sys

from esp_contracts.ids import Provider


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="evaluate")
    parser.add_argument("command", choices=["section23", "g3"])
    parser.add_argument("--provider", required=True, choices=["openai", "xai"])
    parser.add_argument("--release", required=True)
    args = parser.parse_args(argv)
    provider: Provider = args.provider
    print("pending")
    print(
        f"provider={provider} command={args.command} release={args.release} observations=0",
        file=sys.stdout,
    )
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
