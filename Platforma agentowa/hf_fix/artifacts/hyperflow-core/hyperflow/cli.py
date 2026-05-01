"""Hyperflow CLI entrypoint."""

from __future__ import annotations

import argparse
import sys


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        prog="hyperflow",
        description="Hyperflow Python runtime core — EDDE orchestrator",
    )
    parser.add_argument(
        "--version", "-V",
        action="store_true",
        help="Print version and exit",
    )
    parser.add_argument(
        "serve",
        nargs="?",
        default=None,
        help="Start the FastAPI server (use 'serve' subcommand)",
    )
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="Host to bind (default: 127.0.0.1)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8000,
        help="Port to bind (default: 8000)",
    )

    args = parser.parse_args(argv)

    if args.version:
        from hyperflow import __version__
        print(f"hyperflow {__version__}")
        return

    if args.serve == "serve":
        import uvicorn
        uvicorn.run(
            "main:app",
            host=args.host,
            port=args.port,
            reload=True,
        )
        return

    parser.print_help()


if __name__ == "__main__":
    main()
