"""
test_scanner_dns_rebinding.py — Regression test for scanner DNS rebinding mitigation.

This test verifies that the repository scanner refuses to clone when the
resolved IP addresses for a repository host change between validation and
clone time.  A DNS rebinding attack can serve a benign IP during the
validation phase and a private or metadata IP during the subsequent git clone.
The scanner now re-resolves the host immediately before cloning and compares
the IP sets; if they differ, it raises a ValueError.
"""
import ipaddress
import pytest
from pathlib import Path

from scanner import core as sc


@pytest.mark.asyncio
async def test_dns_rebinding_protection(monkeypatch, tmp_path: Path) -> None:
    """The scanner should abort when the resolved IP set changes between validation and clone."""

    call_counter = {"count": 0}

    def fake_resolve(hostname: str, port: int):
        """
        Fake DNS resolver used to simulate a DNS rebinding attack.  The first
        two calls return the same benign IP to satisfy initial validation and
        the explicit re-resolution before cloning.  The third and subsequent
        calls return a different IP (metadata) so that the IP set changes
        immediately before clone, triggering the protection logic.
        """
        call_counter["count"] += 1
        if call_counter["count"] < 3:
            return [ipaddress.ip_address("93.184.216.34")]  # example.com
        else:
            return [ipaddress.ip_address("169.254.169.254")]  # metadata IP (will differ)

    # Monkeypatch the DNS resolver and clone function to avoid real network operations.
    monkeypatch.setattr(sc, "_resolve_host_ips", fake_resolve)

    async def fake_clone(url: str, dest: Path, timeout: int):
        return 0.0

    monkeypatch.setattr(sc, "_clone_repo", fake_clone)

    repo = {"id": "test", "name": "dummy", "url": "https://github.com/hyperflowai/hyperflow"}

    # Expect ValueError due to IP set change (DNS rebinding).
    with pytest.raises(ValueError):
        await sc.analyze_repo_real(repo, tmp_path, 0.0, 10)