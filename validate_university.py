"""표준 대학 조사 JSON을 JSON Schema로 검증한다."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker


DEFAULT_SCHEMA = Path(__file__).parent / "schemas" / "university_research.schema.json"


class SchemaValidationError(ValueError):
    pass


def load_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except OSError as exc:
        raise SchemaValidationError(f"파일을 읽지 못했습니다: {path}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise SchemaValidationError(
            f"유효하지 않은 JSON입니다: line {exc.lineno}, column {exc.colno}: {exc.msg}"
        ) from exc
    if not isinstance(data, dict):
        raise SchemaValidationError("최상위 JSON 값은 객체여야 합니다.")
    return data


def format_path(path: Any) -> str:
    parts = [str(part) for part in path]
    return ".".join(parts) if parts else "<root>"


def validate_document(document: dict[str, Any], schema: dict[str, Any]) -> None:
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    errors = sorted(validator.iter_errors(document), key=lambda error: list(error.absolute_path))
    if errors:
        details = "\n".join(
            f"- {format_path(error.absolute_path)}: {error.message}" for error in errors
        )
        raise SchemaValidationError(f"스키마 검증 실패 ({len(errors)}건):\n{details}")


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")

    parser = argparse.ArgumentParser(description="표준 대학 조사 JSON을 검증합니다.")
    parser.add_argument("json_path", type=Path, help="검증할 JSON 파일")
    parser.add_argument("--schema", type=Path, default=DEFAULT_SCHEMA, help="JSON Schema 경로")
    args = parser.parse_args()

    try:
        validate_document(load_json(args.json_path), load_json(args.schema))
    except SchemaValidationError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    print(f"VALID: {args.json_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
