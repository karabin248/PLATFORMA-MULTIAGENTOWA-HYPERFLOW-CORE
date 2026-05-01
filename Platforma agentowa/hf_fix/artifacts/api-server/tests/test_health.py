"""Integration tests: health check endpoint."""


def test_health_check_ok(api):
    """GET /healthz returns 200 with status ok."""
    resp = api.get("/healthz")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "ok"
    assert "data" in body
    data = body["data"]
    assert data["status"] == "ok"
    assert "version" in data


def test_health_check_envelope(api):
    """Response envelope has the correct top-level shape."""
    resp = api.get("/healthz")
    body = resp.json()
    assert set(body.keys()) >= {"status", "data"}
