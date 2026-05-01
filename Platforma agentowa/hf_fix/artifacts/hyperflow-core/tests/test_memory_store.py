"""Tests for memory store — knowledge, traces, session."""
import sys
import tempfile
import os
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))


def test_save_knowledge_creates_file():
    with tempfile.TemporaryDirectory() as tmp:
        os.environ["HYPERFLOW_STORAGE_DIR"] = tmp
        import importlib
        import memory.store as store
        importlib.reload(store)

        store.save_knowledge("run-1", "analyze", "analytical", "output text", 0.85)
        kf = Path(tmp) / "knowledge_store.jsonl"
        assert kf.exists()
        content = kf.read_text()
        assert "run-1" in content
        assert "analyze" in content


def test_save_trace_creates_file():
    with tempfile.TemporaryDirectory() as tmp:
        os.environ["HYPERFLOW_STORAGE_DIR"] = tmp
        import importlib
        import memory.store as store
        importlib.reload(store)

        store.save_trace(
            run_id="run-2", prompt="test prompt", intent="plan",
            mode="planning",
            mps_context={"level": 4, "name": "Amplify"},
            phases_completed=[
                "perceive",
                "extract_essence",
                "sense_direction",
                "synthesize",
                "generate_options",
                "choose",
            ],
            canonical_combo_detected=True,
            quality_score=0.80, source="stub",
        )
        tf = Path(tmp) / "traces.jsonl"
        assert tf.exists()
        content = tf.read_text()
        assert "run-2" in content
        assert "plan" in content


def test_session_memory_ring_buffer():
    import importlib
    import memory.store as store
    importlib.reload(store)

    store.push_session("r1", "analyze", "analytical", 0.75)
    store.push_session("r2", "plan",    "planning",   0.90)
    summary = store.get_session_summary()
    assert summary["count"] >= 2
    assert summary["avg_quality"] is not None
    assert len(summary["recent_intents"]) >= 1


def test_save_knowledge_does_not_raise_on_bad_path():
    """Best-effort write — OSError must be silently swallowed."""
    os.environ["HYPERFLOW_STORAGE_DIR"] = "/nonexistent_root_dir_xyz/storage"
    import importlib
    import memory.store as store
    importlib.reload(store)

    # Should not raise
    store.save_knowledge("r", "q", "m", "o", 0.5)
