"""Upstage 대학 JSON을 정규화된 Supabase 테이블에 저장한다.

사용 예:
    python save_university.py university.json
    python save_university.py university.json --replace-existing
    Get-Content university.json -Raw | python save_university.py -
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from supabase import Client, create_client

from validate_university import DEFAULT_SCHEMA, load_json as load_schema_json, validate_document


LOGGER = logging.getLogger(__name__)

CHILD_TABLES = (
    "application_deadlines",
    "language_requirements",
    "academic_periods",
    "housing_options",
    "estimated_costs",
    "required_documents",
    "source_links",
)

# 이미 영문 컬럼명으로 정규화된 배열도 입력할 수 있다.
NORMALIZED_LIST_KEYS = {
    "application_deadlines": "application_deadlines",
    "language_requirements": "language_requirements",
    "academic_periods": "academic_periods",
    "housing_options": "housing_options",
    "estimated_costs": "estimated_costs",
    "required_documents": "required_documents",
    "source_links": "source_links",
}

# 각 테이블에 실제로 허용할 컬럼. AI가 만든 알 수 없는 키는 DB로 보내지 않는다.
TABLE_COLUMNS = {
    "application_deadlines": {
        "semester", "deadline_type", "deadline_date", "deadline_text",
        "timezone", "notes", "source_url",
    },
    "language_requirements": {
        "language", "test_type", "overall_score", "score_details", "level",
        "is_required", "exemption_conditions", "notes", "source_url",
    },
    "academic_periods": {
        "semester", "period_type", "start_date", "end_date", "start_text",
        "end_text", "notes", "source_url",
    },
    "housing_options": {
        "housing_category", "meal_type", "room_type", "cost_min", "cost_max",
        "currency", "billing_period", "cost_text", "is_guaranteed",
        "guarantee_conditions", "application_deadline", "application_method",
        "meal_included", "notes", "source_url",
    },
    "estimated_costs": {
        "cost_type", "amount_min", "amount_max", "currency", "billing_period",
        "reference_period", "original_text", "notes", "source_url",
    },
    "required_documents": {
        "document_type", "document_name", "is_required", "preparation_stage",
        "submission_method", "language", "notes", "source_url",
    },
    "source_links": {
        "source_type", "title", "url", "is_official", "published_year",
        "checked_at", "notes",
    },
}

UNIVERSITY_COLUMNS = {
    "university_name", "country", "city", "official_website_url",
    "international_office_url", "incoming_exchange_url", "latitude", "longitude",
    "student_count", "international_student_count", "summary", "strengths",
    "facilities", "student_life", "local_life",
}

PROGRAM_COLUMNS = {
    "academic_year", "program_name", "semester_options", "exchange_type", "quota",
    "minimum_gpa", "minimum_year_level", "tuition_waived", "application_process",
    "course_registration_notes", "course_restrictions", "additional_requirements",
    "document_name", "verification_status", "verified_at",
}


class UniversityDataError(ValueError):
    """입력 데이터가 예상 형식과 다를 때 발생한다."""


class SupabaseStorageError(RuntimeError):
    """Supabase 작업이 실패했을 때 발생한다."""


def get_supabase_client() -> Client:
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_KEY")
    if not url or not key:
        raise RuntimeError(
            "SUPABASE_URL과 SUPABASE_KEY 환경 변수를 모두 설정해야 합니다."
        )
    return create_client(url, key)


def load_json(path: str) -> dict[str, Any]:
    try:
        raw = sys.stdin.read() if path == "-" else Path(path).read_text(encoding="utf-8-sig")
    except OSError as exc:
        raise RuntimeError(f"JSON 파일을 읽지 못했습니다: {exc}") from exc

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise UniversityDataError(
            f"유효하지 않은 JSON입니다 (line {exc.lineno}, column {exc.colno}): {exc.msg}"
        ) from exc
    if not isinstance(data, dict):
        raise UniversityDataError("최상위 JSON 값은 객체(object)여야 합니다.")
    return data


def require_text(source: dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = source.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    raise UniversityDataError(f"필수 문자열 값이 없습니다: {' / '.join(keys)}")


def clean_rows(table: str, rows: Any) -> list[dict[str, Any]]:
    """테이블 허용 컬럼만 남기고 null 값은 제외한다."""
    if rows is None:
        return []
    if not isinstance(rows, list):
        raise UniversityDataError(f"'{table}' 값은 배열(list)이어야 합니다.")

    cleaned: list[dict[str, Any]] = []
    allowed = TABLE_COLUMNS[table]
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            raise UniversityDataError(f"'{table}[{index}]'는 객체여야 합니다.")
        item = {key: value for key, value in row.items() if key in allowed and value is not None}
        if item:
            cleaned.append(item)
    return cleaned


def parse_money(text: Any) -> tuple[float | None, float | None, str | None]:
    """비용 원문에서 숫자 범위와 통화 코드를 보조적으로 추출한다."""
    if not isinstance(text, str):
        return None, None, None
    numbers = [float(value.replace(",", "")) for value in re.findall(r"\d[\d,]*(?:\.\d+)?", text)]
    currency = "GBP" if "£" in text else "EUR" if "€" in text else "USD" if "$" in text else None
    if not numbers:
        return None, None, currency
    return numbers[0], numbers[1] if len(numbers) > 1 else numbers[0], currency


def normalized_url(value: Any) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    url = value.strip()
    if not urlparse(url).scheme:
        url = f"https://{url}"
    return url


def transform_standard_source(source: dict[str, Any]) -> dict[str, Any]:
    """JSON Schema 1.0.0 표준 문서를 Supabase 적재 구조로 변환한다."""
    schema = load_schema_json(DEFAULT_SCHEMA)
    validate_document(source, schema)

    university = {
        key: value
        for key, value in source["university"].items()
        if key in UNIVERSITY_COLUMNS and value is not None
    }
    program = {
        key: value
        for key, value in source["exchange_program"].items()
        if key in PROGRAM_COLUMNS and value is not None
    }

    # 아직 전용 DB 테이블이 없는 미확인 항목도 소실되지 않도록 프로그램 JSONB에 보존한다.
    unverified_items = source.get("unverified_items", [])
    if unverified_items:
        additional = dict(program.get("additional_requirements") or {})
        additional["unverified_items"] = unverified_items
        additional["research_date"] = source["research_date"]
        additional["schema_version"] = source["schema_version"]
        program["additional_requirements"] = additional

    children = {
        table: clean_rows(table, source.get(table, []))
        for table in CHILD_TABLES
    }
    return {"university": university, "program": program, "children": children}


def transform_source(source: dict[str, Any]) -> dict[str, Any]:
    """한글 Upstage 결과를 각 테이블의 영문 컬럼 구조로 변환한다."""
    if source.get("schema_version") == "1.0.0":
        return transform_standard_source(source)

    university_name = require_text(source, "대학명", "university_name")
    academic_year = require_text(source, "학년도", "academic_year")
    program_name = require_text(source, "프로그램명", "program_name")

    university = {"university_name": university_name}
    for key in ("country", "city", "official_website_url", "international_office_url", "incoming_exchange_url"):
        if source.get(key) is not None:
            university[key] = source[key]

    program: dict[str, Any] = {
        "academic_year": academic_year,
        "program_name": program_name,
    }
    if source.get("문서명"):
        program["document_name"] = source["문서명"]
    if source.get("프로그램목록"):
        program["additional_requirements"] = {"pathways": source["프로그램목록"]}

    children = {
        table: clean_rows(table, source.get(input_key))
        for input_key, table in NORMALIZED_LIST_KEYS.items()
    }

    # 입력 예시의 학기 일정 매핑
    for row in source.get("학업기간_학기별일정", []) or []:
        if not isinstance(row, dict):
            raise UniversityDataError("'학업기간_학기별일정'의 각 항목은 객체여야 합니다.")
        period_name = row.get("기간유형")
        children["academic_periods"].append({
            "semester": period_name,
            "period_type": "semester",
            "start_text": row.get("시작연월"),
            "end_text": row.get("종료연월"),
        })

    # 입력 예시의 주거 비용표 매핑
    for row in source.get("주거비용표", []) or []:
        if not isinstance(row, dict):
            raise UniversityDataError("'주거비용표'의 각 항목은 객체여야 합니다.")
        original = row.get("비용범위")
        minimum, maximum, currency = parse_money(original)
        children["housing_options"].append({
            "housing_category": "university",
            "meal_type": row.get("숙소유형_상위"),
            "room_type": row.get("객실유형"),
            "cost_min": minimum,
            "cost_max": maximum,
            "currency": currency,
            "billing_period": "semester",
            "cost_text": original,
        })

    # 지원자 유형별 숙소 보장 조건은 별도 행으로 보존한다.
    for row in source.get("숙소보장정책", []) or []:
        if not isinstance(row, dict):
            raise UniversityDataError("'숙소보장정책'의 각 항목은 객체여야 합니다.")
        children["housing_options"].append({
            "housing_category": "university",
            "guarantee_conditions": row.get("보장조건및내용"),
            "notes": row.get("지원자유형"),
        })

    # 등록금 표 매핑
    for row in source.get("등록금정보", []) or []:
        if not isinstance(row, dict):
            raise UniversityDataError("'등록금정보'의 각 항목은 객체여야 합니다.")
        original = row.get("금액")
        minimum, maximum, currency = parse_money(original)
        children["estimated_costs"].append({
            "cost_type": "tuition",
            "amount_min": minimum,
            "amount_max": maximum,
            "currency": currency,
            "billing_period": row.get("요금항목"),
            "reference_period": academic_year,
            "original_text": original,
            "notes": row.get("요금구분_상위"),
        })

    # 단일 생활비 링크도 출처 행으로 만든다.
    living_cost_url = normalized_url(source.get("생활비안내링크"))
    if living_cost_url:
        children["source_links"].append({
            "source_type": "living_cost_guide",
            "title": "Living expenses guide",
            "url": living_cost_url,
            "is_official": True,
            "published_year": academic_year,
        })

    # 변환 과정에서 생성된 None 제거 및 허용 컬럼 재검증
    children = {table: clean_rows(table, rows) for table, rows in children.items()}
    return {"university": university, "program": program, "children": children}


def execute(operation: Any, description: str) -> Any:
    try:
        return operation.execute()
    except Exception as exc:
        raise SupabaseStorageError(f"{description} 실패: {exc}") from exc


def find_or_create_university(client: Client, payload: dict[str, Any]) -> dict[str, Any]:
    response = execute(
        client.table("universities").select("id,university_name").eq(
            "university_name", payload["university_name"]
        ).limit(1),
        "대학 조회",
    )
    if response.data:
        existing = response.data[0]
        execute(
            client.table("universities").update(payload).eq("id", existing["id"]),
            "대학 기본정보 갱신",
        )
        return {**existing, **payload}

    response = execute(client.table("universities").insert(payload), "대학 삽입")
    if not response.data:
        raise SupabaseStorageError("대학 삽입 결과가 비어 있습니다. RLS와 SELECT 권한을 확인하세요.")
    return response.data[0]


def find_program(client: Client, university_id: str, payload: dict[str, Any]) -> dict[str, Any] | None:
    response = execute(
        client.table("exchange_programs").select("id").eq(
            "university_id", university_id
        ).eq("academic_year", payload["academic_year"]).eq(
            "program_name", payload["program_name"]
        ).limit(1),
        "교환 프로그램 조회",
    )
    return response.data[0] if response.data else None


def create_program(client: Client, university_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    response = execute(
        client.table("exchange_programs").insert({**payload, "university_id": university_id}),
        "교환 프로그램 삽입",
    )
    if not response.data:
        raise SupabaseStorageError("교환 프로그램 삽입 결과가 비어 있습니다.")
    return response.data[0]


def delete_existing_children(client: Client, program_id: str) -> None:
    for table in CHILD_TABLES:
        execute(
            client.table(table).delete().eq("exchange_program_id", program_id),
            f"기존 {table} 삭제",
        )


def insert_children(
    client: Client,
    university_id: str,
    program_id: str,
    children: dict[str, list[dict[str, Any]]],
) -> dict[str, int]:
    counts: dict[str, int] = {}
    for table in CHILD_TABLES:
        rows = children[table]
        if not rows:
            counts[table] = 0
            continue
        linked_rows = []
        for row in rows:
            linked = {**row, "exchange_program_id": program_id}
            if table == "source_links":
                linked["university_id"] = university_id
            linked_rows.append(linked)
        response = execute(client.table(table).insert(linked_rows), f"{table} 삽입")
        counts[table] = len(response.data or [])
    return counts


def save_document(client: Client, source: dict[str, Any], replace_existing: bool) -> dict[str, Any]:
    transformed = transform_source(source)
    university = find_or_create_university(client, transformed["university"])
    university_id = university["id"]
    existing = find_program(client, university_id, transformed["program"])

    if existing and not replace_existing:
        raise UniversityDataError(
            "동일한 대학·학년도·프로그램이 이미 존재합니다. "
            "기존 하위 데이터를 교체하려면 --replace-existing을 사용하세요."
        )

    if existing:
        program_id = existing["id"]
        execute(
            client.table("exchange_programs").update(transformed["program"]).eq("id", program_id),
            "교환 프로그램 갱신",
        )
        delete_existing_children(client, program_id)
    else:
        program_id = create_program(client, university_id, transformed["program"])["id"]

    counts = insert_children(client, university_id, program_id, transformed["children"])
    return {
        "university_id": university_id,
        "exchange_program_id": program_id,
        "inserted_rows": counts,
    }


def inspect_existing(client: Client, source: dict[str, Any]) -> dict[str, Any]:
    """동일 대학·학년도·프로그램의 기존 저장 상태를 변경 없이 조회한다."""
    transformed = transform_source(source)
    university_name = transformed["university"]["university_name"]
    response = execute(
        client.table("universities").select("id,university_name").eq(
            "university_name", university_name
        ).limit(1),
        "기존 대학 조회",
    )
    if not response.data:
        return {"exists": False, "reason": "university_not_found"}

    university = response.data[0]
    program = find_program(client, university["id"], transformed["program"])
    if not program:
        return {
            "exists": False,
            "reason": "program_not_found",
            "university_id": university["id"],
        }

    counts: dict[str, int] = {}
    for table in CHILD_TABLES:
        count_response = execute(
            client.table(table).select("id", count="exact").eq(
                "exchange_program_id", program["id"]
            ).limit(0),
            f"{table} 개수 조회",
        )
        counts[table] = int(count_response.count or 0)
    return {
        "exists": True,
        "university_id": university["id"],
        "exchange_program_id": program["id"],
        "row_counts": counts,
    }


def main() -> int:
    # Windows PowerShell의 기본 CP949에서도 £, € 등 원문 통화 기호를 출력한다.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")

    parser = argparse.ArgumentParser(description="대학 JSON을 정규화된 Supabase 테이블에 저장합니다.")
    parser.add_argument("json_path", help="입력 JSON 파일 경로 ('-'이면 표준입력)")
    parser.add_argument(
        "--replace-existing",
        action="store_true",
        help="동일 프로그램이 있으면 기존 하위 데이터를 삭제하고 다시 저장",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Supabase에 쓰지 않고 변환 결과만 출력",
    )
    parser.add_argument(
        "--inspect-existing",
        action="store_true",
        help="동일 프로그램의 기존 하위 테이블 행 수만 조회",
    )
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    try:
        source = load_json(args.json_path)
        if args.dry_run:
            print(json.dumps(transform_source(source), ensure_ascii=False, indent=2))
            return 0
        if args.inspect_existing:
            print(json.dumps(inspect_existing(get_supabase_client(), source), ensure_ascii=False, indent=2))
            return 0
        result = save_document(get_supabase_client(), source, args.replace_existing)
    except (UniversityDataError, SupabaseStorageError, RuntimeError) as exc:
        LOGGER.error("%s", exc)
        return 1
    except KeyboardInterrupt:
        LOGGER.error("사용자에 의해 작업이 중단되었습니다.")
        return 130
    except Exception:
        LOGGER.exception("예상하지 못한 오류가 발생했습니다.")
        return 1

    LOGGER.info("저장 완료: %s", json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
