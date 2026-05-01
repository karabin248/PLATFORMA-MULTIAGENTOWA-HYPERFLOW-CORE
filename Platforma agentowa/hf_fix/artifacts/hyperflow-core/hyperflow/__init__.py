"""Hyperflow — canonical Python runtime core."""

__version__ = "0.3.0"


def get_version() -> str:
    try:
        from importlib.metadata import version, PackageNotFoundError
        return version("hyperflow")
    except Exception:
        return __version__
