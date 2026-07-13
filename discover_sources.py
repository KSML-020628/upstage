"""대학 공식 도메인에서 교환학생 관련 자료 URL을 자동 발견한다."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

import httpx


FIRECRAWL_SEARCH_URL = "https://api.firecrawl.dev/v2/search"
SOURCE_TYPES = (
    "incoming_exchange",
    "international_office",
    "fact_sheet",
    "academic_calendar",
    "course_catalog",
    "housing",
    "language_requirement",
    "application_guide",
)

TRACKING_PARAMETERS = {"fbclid", "gclid", "from", "ref", "source"}

KEYWORDS = {
    "incoming_exchange": ("incoming", "study abroad", "exchange student", "inbound"),
    "international_office": ("international office", "global engagement", "international contact"),
    "fact_sheet": ("fact sheet", "factsheet", "study abroad guide", "exchange guide", ".pdf"),
    "academic_calendar": ("academic calendar", "academic year", "term dates", "university dates"),
    "course_catalog": ("course catalog", "course catalogue", "unit catalogue", "module catalogue"),
    "housing": ("accommodation", "housing", "residence"),
    "language_requirement": ("language requirement", "english requirement", "ielts", "toefl"),
    "application_guide": ("application", "apply", "entry requirement", "deadline", "nomination"),
}

# 일반 검색 결과가 우연히 키워드 하나를 포함해 대표 자료가 되는 것을 방지한다.
STRONG_SIGNALS = {
    "incoming_exchange": ("incoming study abroad", "study abroad programmes", "/inbound/"),
    "international_office": ("international office", "/international/contact", "global engagement"),
    "fact_sheet": ("fact sheet", "factsheet", "study abroad guide", ".pdf"),
    "academic_calendar": ("study abroad dates", "key dates", "/university/dates", "/study-abroad-dates"),
    "course_catalog": ("what you can study", "subjects and study guides", "unit catalogue", "unit catalog", "optional units"),
    "housing": ("study abroad accommodation", "accommodation costs", "/accommodation/study-abroad"),
    "language_requirement": ("inbound study abroad", "profile h", "english language requirements"),
    "application_guide": ("entry requirements", "how to apply", "application deadline"),
}

NEGATIVE_SIGNALS = {
    "academic_calendar": (
        "fees and dates", "fees-funding", "tuition fee", "mbchb",
        "medicine-vet-medicine", "medical school", "veterinary",
    ),
    "course_catalog": ("programme overview", "fees", "accommodation"),
    "housing": ("language requirement", "course catalogue"),
}


class DiscoveryError(RuntimeError):
    pass


@dataclass(frozen=True)
class SearchTask:
    source_type: str
    query: str


def normalize_domain(value: str) -> str:
    value = value.strip().lower()
    if "://" not in value:
        value = f"https://{value}"
    hostname = urlparse(value).hostname
    if not hostname:
        raise ValueError(f"유효하지 않은 공식 도메인입니다: {value}")
    return hostname.removeprefix("www.")


def is_official_url(url: str, official_domain: str) -> bool:
    hostname = (urlparse(url).hostname or "").lower().removeprefix("www.")
    return hostname == official_domain or hostname.endswith(f".{official_domain}")


def canonicalize_url(url: str) -> str:
    parsed = urlparse(url.strip())
    query = [
        (key, value)
        for key, value in parse_qsl(parsed.query, keep_blank_values=True)
        if not key.lower().startswith("utm_") and key.lower() not in TRACKING_PARAMETERS
    ]
    path = re.sub(r"/{2,}", "/", parsed.path) or "/"
    return urlunparse((
        parsed.scheme.lower(),
        parsed.netloc.lower(),
        path,
        "",
        urlencode(query),
        "",
    ))


def build_search_tasks(university_name: str, domain: str, academic_year: str | None) -> list[SearchTask]:
    year = f' "{academic_year}"' if academic_year else ""
    site = f"site:{domain}"
    return [
        SearchTask("incoming_exchange", f'{site} "{university_name}" incoming exchange study abroad'),
        SearchTask("international_office", f'{site} "{university_name}" international office contact'),
        SearchTask("fact_sheet", f'{site} "{university_name}" exchange fact sheet study abroad guide{year}'),
        SearchTask("fact_sheet", f'{site} filetype:pdf "study abroad" guide{year}'),
        SearchTask("academic_calendar", f'{site} academic calendar term dates{year}'),
        SearchTask("course_catalog", f'{site} course catalog catalogue exchange students'),
        SearchTask("housing", f'{site} study abroad exchange accommodation housing{year}'),
        SearchTask("language_requirement", f'{site} study abroad English language requirements IELTS TOEFL{year}'),
        SearchTask("application_guide", f'{site} incoming exchange application deadline nomination requirements{year}'),
    ]


def value_of(item: Any, name: str, default: Any = "") -> Any:
    if isinstance(item, dict):
        return item.get(name, default)
    return getattr(item, name, default)


def score_candidate(source_type: str, title: str, description: str, url: str, official: bool) -> int:
    haystack = f"{title} {description} {url}".lower()
    score = 35 if official else 0
    score += min(40, sum(10 for keyword in KEYWORDS[source_type] if keyword in haystack))
    score += min(30, sum(15 for signal in STRONG_SIGNALS[source_type] if signal in haystack))
    score -= sum(25 for signal in NEGATIVE_SIGNALS.get(source_type, ()) if signal in haystack)
    if source_type == "fact_sheet" and urlparse(url).path.lower().endswith(".pdf"):
        score += 15
    if re.search(r"20\d{2}(?:[-_/]|%2f)?\d{2}", haystack, re.IGNORECASE):
        score += 5
    return max(0, min(score, 100))


def candidate_from_result(
    result: Any,
    task: SearchTask,
    official_domain: str,
) -> dict[str, Any] | None:
    raw_url = str(value_of(result, "url", "") or "").strip()
    if not raw_url.startswith(("http://", "https://")):
        return None
    url = canonicalize_url(raw_url)
    official = is_official_url(url, official_domain)
    if not official:
        return None
    title = str(value_of(result, "title", "") or "").strip()
    description = str(value_of(result, "description", "") or "").strip()
    return {
        "source_type": task.source_type,
        "title": title,
        "url": url,
        "description": description,
        "is_official": official,
        "is_pdf": urlparse(url).path.lower().endswith(".pdf"),
        "score": score_candidate(task.source_type, title, description, url, official),
        "discovery_query": task.query,
    }


class FirecrawlSearchClient:
    def __init__(self, api_key: str, timeout_seconds: float = 60.0) -> None:
        if not api_key:
            raise DiscoveryError("FIRECRAWL_API_KEY 환경 변수를 설정해야 합니다.")
        self.api_key = api_key
        self.timeout_seconds = timeout_seconds

    def search(self, query: str, domain: str, limit: int) -> list[dict[str, Any]]:
        payload = {
            "query": query,
            "limit": limit,
            "sources": ["web"],
            "includeDomains": [domain],
            "ignoreInvalidURLs": True,
        }
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        last_error: Exception | None = None
        for attempt in range(3):
            try:
                response = httpx.post(
                    FIRECRAWL_SEARCH_URL,
                    headers=headers,
                    json=payload,
                    timeout=self.timeout_seconds,
                )
                if response.status_code == 429 or response.status_code >= 500:
                    raise httpx.HTTPStatusError(
                        f"Firecrawl 임시 오류: HTTP {response.status_code}",
                        request=response.request,
                        response=response,
                    )
                response.raise_for_status()
                body = response.json()
                if not body.get("success"):
                    raise DiscoveryError(f"Firecrawl 검색 실패: {body}")
                return list(body.get("data", {}).get("web", []))
            except (httpx.HTTPError, ValueError) as exc:
                last_error = exc
                if attempt < 2:
                    time.sleep(2**attempt)
        raise DiscoveryError(f"Firecrawl 검색 요청 실패: {last_error}") from last_error


def discover_sources(
    university_name: str,
    official_domain: str,
    academic_year: str | None,
    search: Callable[[str, str, int], list[Any]],
    limit: int = 5,
    provider: str = "firecrawl",
) -> dict[str, Any]:
    domain = normalize_domain(official_domain)
    candidates_by_key: dict[tuple[str, str], dict[str, Any]] = {}

    for task in build_search_tasks(university_name, domain, academic_year):
        for result in search(task.query, domain, limit):
            candidate = candidate_from_result(result, task, domain)
            if not candidate:
                continue
            key = (candidate["source_type"], candidate["url"])
            previous = candidates_by_key.get(key)
            if previous is None or candidate["score"] > previous["score"]:
                candidates_by_key[key] = candidate

    candidates = sorted(
        candidates_by_key.values(),
        key=lambda item: (item["source_type"], -item["score"], item["url"]),
    )
    primary_sources: dict[str, dict[str, Any] | None] = {}
    for source_type in SOURCE_TYPES:
        matching = [item for item in candidates if item["source_type"] == source_type]
        primary_sources[source_type] = matching[0] if matching else None

    return {
        "schema_version": "1.0.0",
        "university_name": university_name,
        "official_domain": domain,
        "academic_year": academic_year,
        "discovered_at": datetime.now(timezone.utc).isoformat(),
        "provider": provider,
        "primary_sources": primary_sources,
        "candidates": candidates,
    }


def load_fixture(path: Path) -> Callable[[str, str, int], list[Any]]:
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(data, dict):
        raise DiscoveryError("fixture 최상위 값은 객체여야 합니다.")

    def search(query: str, _domain: str, limit: int) -> list[Any]:
        lowered = query.lower()
        query_markers = (
            ("fact_sheet", ("fact sheet", "filetype:pdf")),
            ("international_office", ("international office contact",)),
            ("academic_calendar", ("academic calendar", "term dates")),
            ("course_catalog", ("course catalog", "course catalogue")),
            ("housing", ("accommodation housing",)),
            ("language_requirement", ("language requirements", "ielts toefl")),
            ("application_guide", ("application deadline", "nomination requirements")),
            ("incoming_exchange", ("incoming exchange",)),
        )
        for source_type, markers in query_markers:
            if any(marker in lowered for marker in markers):
                return list(data.get(source_type, []))[:limit]
        return []

    return search


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")

    parser = argparse.ArgumentParser(description="대학 공식 교환학생 자료 URL을 발견합니다.")
    parser.add_argument("--university", required=True, help="대학 공식 영문명")
    parser.add_argument("--domain", required=True, help="공식 도메인 (예: bristol.ac.uk)")
    parser.add_argument("--academic-year", help="대상 학년도 (예: 2026/27)")
    parser.add_argument("--limit", type=int, default=5, choices=range(1, 11), metavar="1-10")
    parser.add_argument("--output", type=Path, help="결과 JSON 경로; 생략하면 표준출력")
    parser.add_argument("--fixture", type=Path, help="네트워크 대신 테스트 검색 결과 사용")
    args = parser.parse_args()

    try:
        if args.fixture:
            search = load_fixture(args.fixture)
            provider = "fixture"
        else:
            search = FirecrawlSearchClient(os.getenv("FIRECRAWL_API_KEY", "")).search
            provider = "firecrawl"
        result = discover_sources(
            args.university,
            args.domain,
            args.academic_year,
            search,
            args.limit,
            provider,
        )
        output = json.dumps(result, ensure_ascii=False, indent=2)
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(output + "\n", encoding="utf-8")
            print(f"저장 완료: {args.output} ({len(result['candidates'])}개 후보)")
        else:
            print(output)
    except (DiscoveryError, OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
