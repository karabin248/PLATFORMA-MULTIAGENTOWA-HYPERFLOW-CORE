"""
Shared pytest fixtures for api-server integration tests.

These tests run against the live API server.  The base URL is read from the
BASE_URL environment variable (default: http://localhost:<PORT>/api).
"""

import os
import pytest
import requests

BASE_URL = os.environ.get("TEST_BASE_URL", f"http://localhost:{os.environ.get('PORT', '3000')}/api")


@pytest.fixture(scope="session")
def base_url() -> str:
    return BASE_URL


@pytest.fixture(scope="session")
def session() -> requests.Session:
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="session")
def api(session: requests.Session, base_url: str):
    """A simple helper that wraps requests for common verbs."""
    class _Api:
        def get(self, path: str, **kwargs):
            return session.get(f"{base_url}{path}", **kwargs)

        def post(self, path: str, **kwargs):
            return session.post(f"{base_url}{path}", **kwargs)

    return _Api()
