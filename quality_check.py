"""표준 대학 JSON을 규칙 기반으로 검사하고 안전한 정규화만 적용한다."""

from __future__ import annotations

import argparse
import copy
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from extract_university import is_unverified_item_shape_valid, unverified_item_display_text
from validate_university import DEFAULT_SCHEMA, load_json, validate_document


LIST_FIELDS = (
    "application_deadlines",
    "language_requirements",
    "academic_periods",
    "housing_options",
    "estimated_costs",
    "required_documents",
    "source_links",
    "unverified_items",
)


def canonical_marker(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def deduplicate_exact(rows: list[Any]) -> tuple[list[Any], int]:
    result: list[Any] = []
    seen: set[str] = set()
    removed = 0
    for row in rows:
        marker = canonical_marker(row)
        if marker in seen:
            removed += 1
            continue
        seen.add(marker)
        result.append(row)
    return result, removed


def issue(level: str, code: str, path: str, message: str, fixed: bool = False) -> dict[str, Any]:
    return {
        "level": level,
        "code": code,
        "path": path,
        "message": message,
        "fixed": fixed,
    }


def clean_document(document: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    cleaned = copy.deepcopy(document)
    issues: list[dict[str, Any]] = []
    counts_before = {field: len(cleaned.get(field, [])) for field in LIST_FIELDS}

    for field in LIST_FIELDS:
        rows = cleaned.get(field, [])
        if not isinstance(rows, list):
            continue
        deduplicated, removed = deduplicate_exact(rows)
        cleaned[field] = deduplicated
        if removed:
            issues.append(issue(
                "warning",
                "exact_duplicates_removed",
                field,
                f"완전히 동일한 행 {removed}개를 제거했습니다.",
                True,
            ))

    # extract_university.clean_unverified 가 이미 형태 검증으로 대부분 걸러내지만,
    # 캐시된 이전 추출 결과를 재처리하는 경우 등을 대비해 같은 규칙을 한 번 더 적용하고
    # 몇 개를 제외했는지 quality_report 에 남긴다. 정상 동작 시 이 값은 0이어야 하며,
    # 0이 아니면 clean_unverified 의 형태 검증이 약해졌다는 신호다.
    unverified_rows = cleaned.get("unverified_items", [])
    if isinstance(unverified_rows, list):
        shape_valid: list[Any] = []
        shape_rejected: list[Any] = []
        for row in unverified_rows:
            if isinstance(row, dict) and is_unverified_item_shape_valid(
                str(row.get("field_name") or ""), row.get("details")
            ):
                shape_valid.append(row)
            elif isinstance(row, dict):
                shape_rejected.append(row)
            else:
                shape_valid.append(row)
        cleaned["unverified_items"] = shape_valid
        if shape_rejected:
            preview = "; ".join(
                unverified_item_display_text(str(row.get("field_name") or ""), row.get("details"))[:80]
                for row in shape_rejected[:5]
            )
            issues.append(issue(
                "warning",
                "unverified_item_shape_rejected",
                "unverified_items",
                f"확정된 값·완결 문장·재귀 증식으로 판단되는 항목 {len(shape_rejected)}개를 제외했습니다. "
                f"예: {preview}",
                True,
            ))

    for index, row in enumerate(cleaned.get("housing_options", [])):
        if not isinstance(row, dict):
            continue
        minimum = row.get("cost_min")
        maximum = row.get("cost_max")
        if isinstance(minimum, (int, float)) and isinstance(maximum, (int, float)) and minimum > maximum:
            row["cost_min"], row["cost_max"] = maximum, minimum
            issues.append(issue(
                "warning",
                "cost_range_swapped",
                f"housing_options.{index}",
                "최소 비용이 최대 비용보다 커서 두 값을 교환했습니다.",
                True,
            ))

        # 보장 설명 없이 false인 값은 '보장하지 않음'이 아니라 모델이 빈값을 false로
        # 채운 것일 가능성이 높다. 확인 불가 상태인 null로 되돌린다.
        if row.get("is_guaranteed") is False and not row.get("guarantee_conditions"):
            row["is_guaranteed"] = None
            issues.append(issue(
                "warning",
                "unsupported_housing_guarantee_false",
                f"housing_options.{index}.is_guaranteed",
                "보장 불가를 뒷받침하는 조건 설명이 없어 false를 null로 변경했습니다.",
                True,
            ))

    for index, row in enumerate(cleaned.get("estimated_costs", [])):
        if not isinstance(row, dict):
            continue
        minimum = row.get("amount_min")
        maximum = row.get("amount_max")
        if isinstance(minimum, (int, float)) and isinstance(maximum, (int, float)) and minimum > maximum:
            row["amount_min"], row["amount_max"] = maximum, minimum
            issues.append(issue(
                "warning",
                "cost_range_swapped",
                f"estimated_costs.{index}",
                "최소 금액이 최대 금액보다 커서 두 값을 교환했습니다.",
                True,
            ))

    # 출처 없는 주요 구조화 행은 삭제하지 않고 검수 경고로 남긴다.
    for field in (
        "application_deadlines", "language_requirements", "academic_periods",
        "housing_options", "estimated_costs", "required_documents",
    ):
        for index, row in enumerate(cleaned.get(field, [])):
            if isinstance(row, dict) and not row.get("source_url"):
                issues.append(issue(
                    "warning",
                    "missing_row_source",
                    f"{field}.{index}.source_url",
                    "구조화된 정보에 직접 출처 URL이 없습니다. 삭제하지 않고 검수 대상으로 유지합니다.",
                    False,
                ))

    if len(cleaned.get("unverified_items", [])) > 20:
        issues.append(issue(
            "warning",
            "many_unverified_items",
            "unverified_items",
            f"미확인 항목이 {len(cleaned['unverified_items'])}개입니다. 사람 검수 시 우선 확인하세요.",
            False,
        ))

    validate_document(cleaned, load_json(DEFAULT_SCHEMA))
    counts_after = {field: len(cleaned.get(field, [])) for field in LIST_FIELDS}
    errors = sum(item["level"] == "error" for item in issues)
    warnings = sum(item["level"] == "warning" for item in issues)
    report = {
        "schema_version": "1.0.0",
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "valid_schema": True,
        "passed": errors == 0,
        "summary": {
            "errors": errors,
            "warnings": warnings,
            "auto_fixed": sum(item["fixed"] for item in issues),
            "counts_before": counts_before,
            "counts_after": counts_after,
        },
        "issues": issues,
    }
    return cleaned, report


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")

    parser = argparse.ArgumentParser(description="표준 대학 JSON 품질을 검사하고 안전하게 정리합니다.")
    parser.add_argument("input", type=Path, help="Solar가 생성한 표준 JSON")
    parser.add_argument("--output", type=Path, required=True, help="정리된 표준 JSON")
    parser.add_argument("--report", type=Path, required=True, help="품질 검사 보고서 JSON")
    args = parser.parse_args()

    try:
        document = load_json(args.input)
        validate_document(document, load_json(DEFAULT_SCHEMA))
        cleaned, report = clean_document(document)
        write_json(args.output, cleaned)
        write_json(args.report, report)
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    summary = report["summary"]
    print(
        f"품질 검사 완료: errors={summary['errors']}, warnings={summary['warnings']}, "
        f"auto_fixed={summary['auto_fixed']}"
    )
    print(f"cleaned: {args.output}")
    print(f"report: {args.report}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
