"""수집된 문서를 Solar Pro로 분석해 표준 대학 조사 JSON을 생성한다."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any, Callable

import httpx

from validate_university import DEFAULT_SCHEMA, load_json, validate_document


UPSTAGE_CHAT_URL = "https://api.upstage.ai/v1/chat/completions"
DEFAULT_MODEL = "solar-pro3"
MAX_GROUP_CHARACTERS = 60000


class ExtractionError(RuntimeError):
    pass


@dataclass(frozen=True)
class ExtractionGroup:
    name: str
    source_types: tuple[str, ...]
    output_instruction: str


GROUPS = (
    ExtractionGroup(
        "core",
        ("fact_sheet", "incoming_exchange", "international_office", "exchange_agreement"),
        """Return an object with keys university, exchange_program, unverified_items.
university may contain: university_name, country, city, official_website_url,
international_office_url, incoming_exchange_url, latitude, longitude, student_count,
international_student_count, summary, strengths, facilities, student_life, local_life.
exchange_program may contain: academic_year, program_name, semester_options, exchange_type,
quota, minimum_gpa, minimum_year_level, tuition_waived, application_process,
course_registration_notes, course_restrictions, additional_requirements, document_name.
Do not include verification_status or verified_at.""",
    ),
    ExtractionGroup(
        "application",
        ("application_guide", "language_requirement", "fact_sheet", "incoming_exchange"),
        """Return an object with keys application_deadlines, language_requirements,
required_documents, unverified_items. Use the exact field names from the supplied standard
JSON contract. Dates must be YYYY-MM-DD only when the exact day is stated; otherwise keep
deadline_date null and preserve the wording in deadline_text.
application_deadlines fields: semester, deadline_type, deadline_date, deadline_text,
timezone, notes, source_url.
language_requirements fields: language, test_type, overall_score, score_details, level,
is_required, exemption_conditions, notes, source_url.
required_documents fields: document_type, document_name, is_required, preparation_stage,
submission_method, language, notes, source_url.""",
    ),
    ExtractionGroup(
        "academic",
        ("academic_calendar", "course_catalog", "fact_sheet", "incoming_exchange"),
        """Return an object with keys academic_periods, exchange_program_updates,
unverified_items. academic_periods must use the standard contract fields.
exchange_program_updates may contain only semester_options, course_registration_notes,
course_restrictions, additional_requirements.
academic_periods fields: semester, period_type, start_date, end_date, start_text, end_text,
notes, source_url.
Extract at most 20 academic_periods. Include only university-wide or Visiting Student /
International Exchange dates. Ignore MBChB, Medicine, Veterinary, and other department-specific
calendars. Do not enumerate individual courses as academic periods.""",
    ),
    ExtractionGroup(
        "housing_costs",
        ("housing", "fact_sheet", "student_report"),
        """Return an object with keys housing_options, estimated_costs, unverified_items.
Separate numeric amounts, three-letter currency codes, and billing periods. Preserve the
original wording in cost_text or original_text. Student reports are unofficial supporting
evidence and must not override newer official prices or guarantees.
housing_options fields: housing_category, meal_type, room_type, cost_min, cost_max, currency,
billing_period, cost_text, is_guaranteed, guarantee_conditions, application_deadline,
application_method, meal_included, notes, source_url.
estimated_costs fields: cost_type, amount_min, amount_max, currency, billing_period,
reference_period, original_text, notes, source_url.""",
    ),
    ExtractionGroup(
        "student_life",
        ("student_report", "international_office", "incoming_exchange"),
        """Return an object with keys university_updates, unverified_items.
university_updates may contain only summary, strengths, facilities, student_life, local_life.
Clearly treat student reports as individual experiences, not universally applicable facts.
Do not turn opinions into official claims.""",
    ),
)

UNVERIFIED_REASONS = {
    "not_found_in_official_sources",
    "not_publicly_available",
    "only_in_skku_material",
    "outdated_source",
    "varies_by_department_or_semester",
    "only_in_unofficial_sources",
    "ambiguous",
}

NULLABLE_SENTINELS = {"null", "none", "n/a", "na", "not available"}
NULLABLE_FIELD_NAMES = {
    "deadline_date", "start_date", "end_date", "application_deadline", "checked_at",
    "verified_at", "source_url", "official_website_url", "international_office_url",
    "incoming_exchange_url",
}

SYSTEM_PROMPT = """You extract exchange-university information from supplied source documents.
Return one valid JSON object and no Markdown fences or commentary.

Evidence rules:
1. Newer official university sources have highest priority.
2. Official fact sheets and official web pages are factual evidence.
3. SKKU/internal material is secondary evidence and may be outdated.
4. Student reports are unofficial personal experiences. Use them only for student-life context.
5. Never invent missing values or infer an exact date, price, guarantee, score, or quota.
6. Use null for unknown scalar values and [] for an empty result list.
7. When evidence is missing, ambiguous, outdated, or unofficial-only, add an unverified_items entry.
8. Every unverified item uses category, field_name, reason, details, source_url.
9. Allowed reason values: not_found_in_official_sources, not_publicly_available,
only_in_skku_material, outdated_source, varies_by_department_or_semester,
only_in_unofficial_sources, ambiguous.
10. Keep source wording in English where it is useful; do not translate names of programs."""


def request_with_retry(request: Callable[[], httpx.Response], description: str) -> httpx.Response:
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            response = request()
            if response.status_code == 429 or response.status_code >= 500:
                raise httpx.HTTPStatusError(
                    f"{description} 임시 오류: HTTP {response.status_code}",
                    request=response.request,
                    response=response,
                )
            response.raise_for_status()
            return response
        except httpx.HTTPError as exc:
            last_error = exc
            if attempt < 2:
                time.sleep(2**attempt)
    raise ExtractionError(f"{description} 실패: {last_error}") from last_error


def parse_json_object(text: str) -> dict[str, Any]:
    cleaned = text.strip()
    cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s*```$", "", cleaned)
    try:
        value = json.loads(cleaned)
    except json.JSONDecodeError:
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start < 0 or end <= start:
            raise ExtractionError("Solar 응답에서 JSON 객체를 찾지 못했습니다.")
        try:
            value = json.loads(cleaned[start : end + 1])
        except json.JSONDecodeError as exc:
            raise ExtractionError(f"Solar JSON 파싱 실패: {exc}") from exc
    if not isinstance(value, dict):
        raise ExtractionError("Solar 응답의 최상위 값이 객체가 아닙니다.")
    return value


class SolarClient:
    def __init__(self, api_key: str, model: str = DEFAULT_MODEL, timeout_seconds: float = 180.0) -> None:
        if not api_key:
            raise ExtractionError("UPSTAGE_API_KEY 환경 변수를 설정해야 합니다.")
        self.api_key = api_key
        self.model = model
        self.timeout_seconds = timeout_seconds
        self.last_response: dict[str, Any] | None = None

    def complete_json(self, system_prompt: str, user_prompt: str) -> tuple[dict[str, Any], dict[str, Any]]:
        response = request_with_retry(
            lambda: httpx.post(
                UPSTAGE_CHAT_URL,
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": self.model,
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_prompt},
                    ],
                    "temperature": 0,
                    # 프롬프트 지시만으로 설명문을 반환하는 경우가 있어 API 레벨에서
                    # JSON 객체 출력을 강제한다.
                    "response_format": {"type": "json_object"},
                    # solar-pro3의 내부 추론과 최종 JSON이 같은 출력 예산을 사용하므로
                    # 낮은 추론 강도와 충분한 출력 한도를 함께 지정한다.
                    "reasoning_effort": "low",
                    "max_tokens": 16384,
                },
                timeout=self.timeout_seconds,
            ),
            f"Solar 추출 ({self.model})",
        )
        body = response.json()
        self.last_response = body
        try:
            choice = body["choices"][0]
            message = choice["message"]
            content = message.get("content")
        except (KeyError, IndexError, TypeError) as exc:
            raise ExtractionError(f"Solar 응답 형식이 예상과 다릅니다: {body}") from exc
        if isinstance(content, list):
            content = "".join(
                str(part.get("text", "")) if isinstance(part, dict) else str(part)
                for part in content
            )
        if not isinstance(content, str) or not content.strip():
            raise ExtractionError(
                f"Solar 응답 본문이 비어 있습니다. finish_reason={choice.get('finish_reason')}, "
                f"message_keys={sorted(message.keys())}. 내부 추론은 최종 JSON으로 사용하지 않습니다."
            )
        try:
            parsed = parse_json_object(content)
        except ExtractionError as exc:
            preview = content[:800].replace("\n", " ")
            raise ExtractionError(
                f"{exc} finish_reason={choice.get('finish_reason')}, response_preview={preview!r}"
            ) from exc
        return parsed, body


def load_documents(manifest_path: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    manifest = load_json(manifest_path)
    documents: list[dict[str, Any]] = []
    for item in manifest.get("documents", []):
        if item.get("status") not in {"succeeded", "skipped"} or not item.get("content_path"):
            continue
        path = Path(item["content_path"])
        if not path.is_absolute():
            # manifest 경로는 프로젝트 루트 기준으로 기록된다.
            path = Path.cwd() / path
        try:
            content = path.read_text(encoding="utf-8")
        except OSError as exc:
            raise ExtractionError(f"파싱 문서를 읽지 못했습니다: {path}: {exc}") from exc
        documents.append({**item, "content": content})
    if not documents:
        raise ExtractionError("manifest에 추출 가능한 성공 문서가 없습니다.")
    return manifest, documents


def document_matches_group(document: dict[str, Any], group: ExtractionGroup) -> bool:
    if not bool(set(document.get("source_types", [])) & set(group.source_types)):
        return False
    if group.name == "academic":
        identity = f"{document.get('title', '')} {document.get('url', '')}".casefold()
        excluded = ("mbchb", "medicine-vet-medicine", "medical school", "veterinary")
        if any(term in identity for term in excluded):
            return False
    return True


def build_group_context(documents: list[dict[str, Any]], group: ExtractionGroup) -> str:
    selected = [item for item in documents if document_matches_group(item, group)]
    if not selected:
        return "No matching source documents were collected."
    per_document = max(3000, MAX_GROUP_CHARACTERS // len(selected))
    blocks: list[str] = []
    for item in selected:
        source = item.get("url") or item.get("local_path") or "unknown"
        authority = "UNOFFICIAL STUDENT REPORT" if "student_report" in item.get("source_types", []) else (
            "MANUAL SECONDARY SOURCE" if item.get("source_kind") == "manual" and "fact_sheet" not in item.get("source_types", [])
            else "OFFICIAL SOURCE"
        )
        content = item["content"]
        if len(content) > per_document:
            content = content[:per_document] + "\n[TRUNCATED]"
        blocks.append(
            f"\n--- DOCUMENT ---\nAUTHORITY: {authority}\nSOURCE_TYPES: "
            f"{','.join(item.get('source_types', []))}\nTITLE: {item.get('title', '')}\n"
            f"SOURCE: {source}\nCONTENT:\n{content}"
        )
    return "\n".join(blocks)


def build_user_prompt(
    group: ExtractionGroup,
    documents: list[dict[str, Any]],
    university_name: str,
    academic_year: str,
    program_name: str,
) -> str:
    context = build_group_context(documents, group)
    return f"""Target university: {university_name}
Target academic year: {academic_year}
Target exchange program: {program_name}
Extraction group: {group.name}

{group.output_instruction}

Source documents:
{context}
"""


def clean_unverified(items: Any) -> list[dict[str, Any]]:
    if not isinstance(items, list):
        return []
    cleaned: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        reason = item.get("reason")
        if reason not in UNVERIFIED_REASONS:
            reason = "ambiguous"
        category = str(item.get("category") or "general")
        field_name = str(item.get("field_name") or "unknown")
        source_url = item.get("source_url")
        if not isinstance(source_url, str) or not source_url.startswith(("http://", "https://")):
            source_url = None
        cleaned.append({
            "category": category,
            "field_name": field_name,
            "reason": reason,
            "details": item.get("details"),
            "source_url": source_url,
        })
    return cleaned


def merge_dict_non_null(target: dict[str, Any], updates: Any) -> None:
    if not isinstance(updates, dict):
        return
    for key, value in updates.items():
        if value is not None and value != [] and value != {}:
            target[key] = value


def deduplicate_rows(rows: list[Any]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        marker = json.dumps(row, ensure_ascii=False, sort_keys=True)
        if marker not in seen:
            seen.add(marker)
            result.append(row)
    return result


def normalize_text_list(value: Any) -> list[str] | None:
    if value is None:
        return None
    if isinstance(value, list):
        return [str(item) for item in value if item is not None and str(item).strip()]
    if isinstance(value, str) and value.strip():
        return [value.strip()]
    return [str(value)]


def normalize_text_value(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return value.strip() or None
    if isinstance(value, list):
        parts: list[str] = []
        for item in value:
            if isinstance(item, dict):
                note = item.get("note") or item.get("description") or item.get("text")
                source = item.get("source_url")
                text = str(note).strip() if note is not None else json.dumps(item, ensure_ascii=False)
                if source:
                    text += f" [Source: {source}]"
                parts.append(text)
            elif item is not None and str(item).strip():
                parts.append(str(item).strip())
        return "\n\n".join(parts) or None
    if isinstance(value, dict):
        note = value.get("note") or value.get("description") or value.get("text")
        if note is not None:
            return str(note).strip() or None
        return json.dumps(value, ensure_ascii=False, sort_keys=True)
    return str(value)


def normalize_university_types(university: dict[str, Any]) -> None:
    for key in ("strengths", "facilities", "student_life", "local_life"):
        if key in university:
            university[key] = normalize_text_list(university[key])


def normalize_program_types(program: dict[str, Any]) -> None:
    for key in ("semester_options", "course_restrictions"):
        if key in program:
            program[key] = normalize_text_list(program[key])
    for key in (
        "exchange_type", "minimum_year_level", "application_process",
        "course_registration_notes", "document_name",
    ):
        if key in program:
            program[key] = normalize_text_value(program[key])


UNIVERSITY_FIELDS = {
    "university_name", "country", "city", "official_website_url",
    "international_office_url", "incoming_exchange_url", "latitude",
    "longitude", "student_count", "international_student_count", "summary",
    "strengths", "facilities", "student_life", "local_life",
}

PROGRAM_FIELDS = {
    "academic_year", "program_name", "semester_options", "exchange_type",
    "quota", "minimum_gpa", "minimum_year_level", "tuition_waived",
    "application_process", "course_registration_notes", "course_restrictions",
    "additional_requirements", "document_name", "verification_status",
    "verified_at",
}


def remove_contract_extras(
    university: dict[str, Any],
    program: dict[str, Any],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Solar가 계약 밖에 둔 값을 검증 가능한 위치로 정리한다."""
    nested_unverified = clean_unverified(university.pop("unverified_items", None))
    nested_unverified.extend(clean_unverified(program.pop("unverified_items", None)))

    preserved: dict[str, Any] = {}
    for container_name, container, allowed in (
        ("university", university, UNIVERSITY_FIELDS),
        ("exchange_program", program, PROGRAM_FIELDS),
    ):
        for key in list(container):
            if key in allowed:
                continue
            value = container.pop(key)
            # 출처는 deterministic_source_links에서 문서별로 별도 보존된다.
            if key != "source_url" and value not in (None, "", [], {}):
                preserved[f"{container_name}.{key}"] = value
    return nested_unverified, preserved


def numeric_value(value: Any) -> float | int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str) and re.fullmatch(r"\s*\d+(?:\.\d+)?\s*", value):
        number = float(value.strip())
        return int(number) if number.is_integer() else number
    return None


def normalize_language_rows(rows: Any) -> list[dict[str, Any]]:
    if not isinstance(rows, list):
        return []
    normalized: list[dict[str, Any]] = []
    for raw in rows:
        if not isinstance(raw, dict):
            continue
        row = dict(raw)
        score_details = row.get("score_details")
        if isinstance(score_details, dict):
            details = dict(score_details)
        elif score_details is None:
            details = {}
        else:
            details = {"description": score_details}

        overall_raw = row.get("overall_score")
        overall = numeric_value(overall_raw)
        if overall is None and overall_raw is not None:
            details.setdefault("overall_requirement", overall_raw)
        row["overall_score"] = overall
        row["score_details"] = details or None

        exemptions = row.get("exemption_conditions")
        if isinstance(exemptions, list):
            row["exemption_conditions"] = "\n".join(str(item) for item in exemptions)
        elif exemptions is not None and not isinstance(exemptions, str):
            row["exemption_conditions"] = str(exemptions)
        normalized.append(row)
    return normalized


def normalize_nullable_sentinels(value: Any) -> None:
    if isinstance(value, dict):
        for key, item in list(value.items()):
            if (
                key in NULLABLE_FIELD_NAMES
                and isinstance(item, str)
                and item.strip().casefold() in NULLABLE_SENTINELS
            ):
                value[key] = None
            else:
                normalize_nullable_sentinels(item)
    elif isinstance(value, list):
        for item in value:
            normalize_nullable_sentinels(item)


def deterministic_source_links(documents: list[dict[str, Any]], checked_at: str) -> list[dict[str, Any]]:
    links: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for item in documents:
        url = item.get("url")
        if not url:
            continue
        for source_type in item.get("source_types", ["other"]):
            key = (source_type, url)
            if key in seen:
                continue
            seen.add(key)
            links.append({
                "source_type": source_type,
                "title": item.get("title"),
                "url": url,
                "is_official": True,
                "published_year": None,
                "checked_at": checked_at,
                "notes": None,
            })
    return links


def assemble_standard_document(
    partials: dict[str, dict[str, Any]],
    documents: list[dict[str, Any]],
    university_name: str,
    academic_year: str,
    program_name: str,
    research_date: str,
) -> dict[str, Any]:
    university: dict[str, Any] = {
        "university_name": university_name,
        "country": None,
        "city": None,
    }
    program: dict[str, Any] = {
        "academic_year": academic_year,
        "program_name": program_name,
    }
    core = partials.get("core", {})
    merge_dict_non_null(university, core.get("university"))
    merge_dict_non_null(program, core.get("exchange_program"))
    merge_dict_non_null(program, partials.get("academic", {}).get("exchange_program_updates"))
    merge_dict_non_null(university, partials.get("student_life", {}).get("university_updates"))
    program["academic_year"] = academic_year
    program["program_name"] = program_name
    program["verification_status"] = "partial"
    program["verified_at"] = None
    nested_unverified, contract_extras = remove_contract_extras(university, program)
    normalize_university_types(university)
    normalize_program_types(program)

    # 모델이 자유서술을 문자열/배열로 반환해도 JSONB 객체로 안전하게 보존한다.
    raw_additional = program.get("additional_requirements")
    if isinstance(raw_additional, dict):
        normalized_additional = dict(raw_additional)
    elif raw_additional is None:
        normalized_additional = {}
    else:
        normalized_additional = {"extracted_notes": raw_additional}
    if contract_extras:
        normalized_additional["model_extra_fields"] = contract_extras
    if normalized_additional:
        program["additional_requirements"] = normalized_additional
    else:
        program.pop("additional_requirements", None)

    manual_sources = [
        {
            "title": item.get("title"),
            "source_types": item.get("source_types", []),
            "local_path": item.get("local_path"),
        }
        for item in documents
        if item.get("source_kind") == "manual"
    ]
    if manual_sources:
        additional = dict(program.get("additional_requirements") or {})
        additional["manual_sources"] = manual_sources
        program["additional_requirements"] = additional

    unverified: list[Any] = list(nested_unverified)
    for partial in partials.values():
        unverified.extend(clean_unverified(partial.get("unverified_items")))

    result = {
        "schema_version": "1.0.0",
        "research_date": research_date,
        "university": university,
        "exchange_program": program,
        "application_deadlines": deduplicate_rows(partials.get("application", {}).get("application_deadlines", [])),
        "language_requirements": deduplicate_rows(
            normalize_language_rows(partials.get("application", {}).get("language_requirements", []))
        ),
        "academic_periods": deduplicate_rows(partials.get("academic", {}).get("academic_periods", [])),
        "housing_options": deduplicate_rows(partials.get("housing_costs", {}).get("housing_options", [])),
        "estimated_costs": deduplicate_rows(partials.get("housing_costs", {}).get("estimated_costs", [])),
        "required_documents": deduplicate_rows(partials.get("application", {}).get("required_documents", [])),
        "source_links": deterministic_source_links(documents, research_date),
        "unverified_items": deduplicate_rows(unverified),
    }
    normalize_nullable_sentinels(result)
    return result


def extract_all(
    documents: list[dict[str, Any]],
    complete_json: Callable[[str, str], tuple[dict[str, Any], dict[str, Any]]],
    university_name: str,
    academic_year: str,
    program_name: str,
    research_date: str,
    run_dir: Path,
) -> dict[str, Any]:
    run_dir.mkdir(parents=True, exist_ok=True)
    partials: dict[str, dict[str, Any]] = {}
    for group in GROUPS:
        prompt = build_user_prompt(group, documents, university_name, academic_year, program_name)
        prompt_path = run_dir / f"{group.name}.prompt.txt"
        partial_path = run_dir / f"{group.name}.partial.json"
        response_path = run_dir / f"{group.name}.response.json"
        prompt_path.write_text(prompt, encoding="utf-8")

        # 이전 실행에서 유효한 부분 결과가 있으면 API를 다시 호출하지 않는다.
        if partial_path.exists():
            cached = load_json(partial_path)
            partials[group.name] = cached
            continue

        try:
            partial, raw_response = complete_json(SYSTEM_PROMPT, prompt)
        except Exception:
            owner = getattr(complete_json, "__self__", None)
            last_response = getattr(owner, "last_response", None)
            if isinstance(last_response, dict):
                response_path.write_text(
                    json.dumps(last_response, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8",
                )
            raise
        partials[group.name] = partial
        partial_path.write_text(
            json.dumps(partial, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        response_path.write_text(
            json.dumps(raw_response, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    result = assemble_standard_document(
        partials, documents, university_name, academic_year, program_name, research_date
    )
    validate_document(result, load_json(DEFAULT_SCHEMA))
    return result


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")

    parser = argparse.ArgumentParser(description="수집 문서를 Solar Pro로 분석해 표준 JSON을 생성합니다.")
    parser.add_argument("manifest", type=Path, help="parsed_documents/manifest.json")
    parser.add_argument("--university", required=True, help="대학 공식 영문명")
    parser.add_argument("--academic-year", required=True, help="대상 학년도")
    parser.add_argument("--program-name", default="Study Abroad", help="교환 프로그램명")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="Upstage Solar 모델명")
    parser.add_argument("--output", type=Path, required=True, help="표준 JSON 저장 경로")
    parser.add_argument("--run-dir", type=Path, help="그룹별 프롬프트와 원본 응답 저장 경로")
    parser.add_argument("--dry-run", action="store_true", help="API 호출 없이 그룹별 문서 선택만 확인")
    args = parser.parse_args()

    try:
        _, documents = load_documents(args.manifest)
        if args.dry_run:
            print(f"사용 가능한 문서: {len(documents)}개")
            for group in GROUPS:
                selected = [item for item in documents if document_matches_group(item, group)]
                total_chars = len(build_group_context(documents, group))
                print(f"{group.name}: documents={len(selected)}, context_chars={total_chars}")
            return 0

        api_key = os.getenv("UPSTAGE_API_KEY", "")
        client = SolarClient(api_key, args.model) if api_key else None

        def require_key(_system_prompt: str, _user_prompt: str):
            if client is None:
                raise ExtractionError(
                    "캐시되지 않은 그룹을 Solar로 추출하려면 UPSTAGE_API_KEY가 필요합니다."
                )
            raise AssertionError("unreachable")

        run_dir = args.run_dir or args.output.parent / "extraction_runs" / hashlib.sha256(
            f"{args.university}|{args.academic_year}|{args.program_name}".encode("utf-8")
        ).hexdigest()[:12]
        result = extract_all(
            documents,
            client.complete_json if client is not None else require_key,
            args.university,
            args.academic_year,
            args.program_name,
            date.today().isoformat(),
            run_dir,
        )
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"추출 완료: {args.output}")
        print(f"중간 결과: {run_dir}")
        return 0
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
