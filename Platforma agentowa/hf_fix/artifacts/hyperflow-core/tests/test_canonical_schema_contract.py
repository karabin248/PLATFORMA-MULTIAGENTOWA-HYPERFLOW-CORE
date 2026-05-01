import json
from pathlib import Path

from language.emoji_parser import CANONICAL_PHASES


def test_canonical_semantics_schema_file_exists_and_is_referenced():
    config_path = Path("configs/canonical_semantics.json")
    config = json.loads(config_path.read_text())
    schema_ref = config.get("$schema")
    assert schema_ref == "./canonical_semantics.schema.json"

    schema_path = config_path.parent / schema_ref.replace("./", "")
    assert schema_path.exists(), f"Missing canonical schema file: {schema_path}"


def test_canonical_semantics_schema_locks_the_exact_runtime_contract():
    schema = json.loads(Path("configs/canonical_semantics.schema.json").read_text())

    order_schema = schema["properties"]["cycle"]["properties"]["order"]["prefixItems"]
    assert [entry["const"] for entry in order_schema] == CANONICAL_PHASES

    symbols = schema["properties"]["cycle"]["properties"]["symbols"]["properties"]
    assert symbols["perceive"]["const"] == "🌈"
    assert symbols["extract_essence"]["const"] == "💎"
    assert symbols["sense_direction"]["const"] == "🔥"
    assert symbols["synthesize"]["const"] == "🧠"
    assert symbols["generate_options"]["const"] == "🔀"
    assert symbols["choose"]["const"] == "⚡"

    positions = schema["properties"]["cycle"]["properties"]["positions"]["properties"]
    assert positions["perceive"]["const"] == 1
    assert positions["extract_essence"]["const"] == 2
    assert positions["sense_direction"]["const"] == 3
    assert positions["synthesize"]["const"] == 4
    assert positions["generate_options"]["const"] == 5
    assert positions["choose"]["const"] == 6

    authority = schema["properties"]["authority"]["properties"]
    assert authority["execution"]["const"] == "python_core"
    assert authority["observer"]["const"] == "typescript_shell"
