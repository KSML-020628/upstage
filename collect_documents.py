"""발견된 공식 URL의 HTML과 PDF를 수집해 로컬 문서 저장소를 만든다."""

from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
import sys
import time
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

import httpx

from discover_sources import score_candidate


FIRECRAWL_SCRAPE_URL = "https://api.firecrawl.dev/v2/scrape"
UPSTAGE_PARSE_URL = "https://api.upstage.ai/v1/document-digitization"
MAX_PDF_BYTES = 50 * 1024 * 1024
MAX_LOCAL_FILE_BYTES = 50 * 1024 * 1024
SUPPORTED_MANUAL_EXTENSIONS = {
    ".pdf", ".png", ".jpg", ".jpeg", ".tif", ".tiff",
    ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx",
}
MIME_TYPES = {
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}


class CollectionError(RuntimeError):
    pass


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


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
    raise CollectionError(f"{description} 실패: {last_error}") from last_error


class FirecrawlScraper:
    def __init__(self, api_key: str, timeout_seconds: float = 60.0) -> None:
        self.api_key = api_key
        self.timeout_seconds = timeout_seconds

    def collect(self, url: str) -> tuple[str, str, dict[str, Any]]:
        if not self.api_key:
            raise CollectionError("HTML 수집에는 FIRECRAWL_API_KEY가 필요합니다.")
        response = request_with_retry(
            lambda: httpx.post(
                FIRECRAWL_SCRAPE_URL,
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "url": url,
                    "formats": ["markdown"],
                    "onlyMainContent": True,
                    "removeBase64Images": True,
                    "timeout": int(self.timeout_seconds * 1000),
                },
                timeout=self.timeout_seconds + 10,
            ),
            "Firecrawl Scrape",
        )
        body = response.json()
        if not body.get("success"):
            raise CollectionError(f"Firecrawl Scrape 실패: {body}")
        data = body.get("data", {})
        markdown = data.get("markdown")
        if not isinstance(markdown, str) or not markdown.strip():
            raise CollectionError("Firecrawl 응답에 markdown 본문이 없습니다.")
        return markdown, ".md", body


class UpstagePdfParser:
    def __init__(self, api_key: str, timeout_seconds: float = 180.0) -> None:
        self.api_key = api_key
        self.timeout_seconds = timeout_seconds

    def download_pdf(self, url: str) -> tuple[bytes, str]:
        response = request_with_retry(
            lambda: httpx.get(url, follow_redirects=True, timeout=60.0),
            "PDF 다운로드",
        )
        content = response.content
        if len(content) > MAX_PDF_BYTES:
            raise CollectionError(f"PDF가 제한 크기 50MB를 초과합니다: {len(content)} bytes")
        content_type = response.headers.get("content-type", "").lower()
        if not content.startswith(b"%PDF") and "application/pdf" not in content_type:
            raise CollectionError(f"URL 응답이 PDF가 아닙니다: content-type={content_type}")
        filename = Path(urlparse(str(response.url)).path).name or "document.pdf"
        if not filename.lower().endswith(".pdf"):
            filename += ".pdf"
        return content, filename

    def parse_bytes(self, content_bytes: bytes, filename: str) -> tuple[str, str, dict[str, Any]]:
        if not self.api_key:
            raise CollectionError("수동 문서 및 PDF 수집에는 UPSTAGE_API_KEY가 필요합니다.")
        extension = Path(filename).suffix.lower()
        content_type = MIME_TYPES.get(extension) or mimetypes.guess_type(filename)[0] or "application/octet-stream"
        response = request_with_retry(
            lambda: httpx.post(
                UPSTAGE_PARSE_URL,
                headers={"Authorization": f"Bearer {self.api_key}"},
                files={"document": (filename, content_bytes, content_type)},
                data={"ocr": "auto", "model": "document-parse"},
                timeout=self.timeout_seconds,
            ),
            "Upstage Document Parse",
        )
        body = response.json()
        content = body.get("content", {}) if isinstance(body, dict) else {}
        markdown = content.get("markdown") if isinstance(content, dict) else None
        html = content.get("html") if isinstance(content, dict) else None
        if not markdown and isinstance(body, dict):
            markdown = body.get("markdown")
        if not html and isinstance(body, dict):
            html = body.get("html")
        if isinstance(markdown, str) and markdown.strip():
            return markdown, ".md", body
        if isinstance(html, str) and html.strip():
            return html, ".html", body
        raise CollectionError("Upstage 응답에서 HTML 또는 Markdown 본문을 찾지 못했습니다.")

    def collect(self, url: str) -> tuple[str, str, dict[str, Any]]:
        pdf, filename = self.download_pdf(url)
        return self.parse_bytes(pdf, filename)

    def collect_local(self, path: Path) -> tuple[str, str, dict[str, Any]]:
        try:
            size = path.stat().st_size
        except OSError as exc:
            raise CollectionError(f"수동 원본 파일을 읽을 수 없습니다: {path}: {exc}") from exc
        if size > MAX_LOCAL_FILE_BYTES:
            raise CollectionError(f"수동 원본이 제한 크기 50MB를 초과합니다: {path} ({size} bytes)")
        if path.suffix.lower() not in SUPPORTED_MANUAL_EXTENSIONS:
            raise CollectionError(f"지원하지 않는 수동 원본 형식입니다: {path.suffix}")
        return self.parse_bytes(path.read_bytes(), path.name)


def select_sources(discovery: dict[str, Any], all_candidates: bool) -> list[dict[str, Any]]:
    candidates = [item for item in discovery.get("candidates", []) if isinstance(item, dict)]
    if all_candidates:
        raw_sources = candidates
    elif candidates:
        # 과거 발견 파일도 최신 점수 규칙으로 다시 평가해 유형별 대표 자료를 선택한다.
        best_by_type: dict[str, dict[str, Any]] = {}
        for item in candidates:
            source_type = item.get("source_type")
            if not source_type:
                continue
            rescored = dict(item)
            rescored["score"] = score_candidate(
                source_type,
                str(item.get("title", "")),
                str(item.get("description", "")),
                str(item.get("url", "")),
                bool(item.get("is_official")),
            )
            previous = best_by_type.get(source_type)
            if previous is None or rescored["score"] > previous["score"]:
                best_by_type[source_type] = rescored
        raw_sources = list(best_by_type.values())
    else:
        raw_sources = list(discovery.get("primary_sources", {}).values())
    grouped: dict[str, dict[str, Any]] = {}
    for source in raw_sources:
        if not isinstance(source, dict) or not source.get("url"):
            continue
        url = source["url"]
        existing = grouped.get(url)
        if existing:
            source_type = source.get("source_type")
            if source_type and source_type not in existing["source_types"]:
                existing["source_types"].append(source_type)
            continue
        grouped[url] = {
            "url": url,
            "title": source.get("title", ""),
            "is_pdf": bool(source.get("is_pdf")) or urlparse(url).path.lower().endswith(".pdf"),
            "source_types": [source.get("source_type", "unknown")],
        }
    return list(grouped.values())


def document_id(url: str) -> str:
    return hashlib.sha256(url.encode("utf-8")).hexdigest()[:16]


def manual_document_id(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()[:16]


def infer_manual_source_type(filename: str) -> str:
    lowered = unicodedata.normalize("NFC", filename).casefold()
    if (
        "수학보고서" in lowered
        or "파견" in lowered
        or "study report" in lowered
        or "student report" in lowered
    ):
        return "student_report"
    if "fact" in lowered or "study_abroad_guide" in lowered or "study abroad guide" in lowered:
        return "fact_sheet"
    if "agreement" in lowered or "협정" in lowered:
        return "exchange_agreement"
    return "manual_document"


def load_manual_metadata(manual_dir: Path) -> dict[str, dict[str, Any]]:
    metadata_path = manual_dir.parent / "metadata.json"
    if not metadata_path.exists():
        metadata_path = manual_dir / "metadata.json"
    if not metadata_path.exists():
        return {}
    try:
        payload = json.loads(metadata_path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        raise CollectionError(f"수동 자료 metadata.json을 읽지 못했습니다: {exc}") from exc
    documents = payload.get("documents", []) if isinstance(payload, dict) else []
    return {
        str(item["file_name"]): item
        for item in documents
        if isinstance(item, dict) and item.get("file_name")
    }


def select_manual_sources(manual_dir: Path) -> list[dict[str, Any]]:
    if not manual_dir.exists():
        return []
    metadata = load_manual_metadata(manual_dir)
    sources: list[dict[str, Any]] = []
    for path in sorted(manual_dir.iterdir(), key=lambda item: item.name.casefold()):
        if not path.is_file() or path.name == "metadata.json":
            continue
        if path.suffix.lower() not in SUPPORTED_MANUAL_EXTENSIONS:
            print(f"WARNING: 지원하지 않는 수동 원본을 건너뜁니다: {path.name}")
            continue
        details = metadata.get(path.name, {})
        source_type = str(details.get("source_type") or infer_manual_source_type(path.name))
        sources.append({
            "path": path,
            "title": str(details.get("title") or path.stem),
            "source_types": [source_type],
            "is_pdf": path.suffix.lower() == ".pdf",
        })
    return sources


def write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def collect_one(
    source: dict[str, Any],
    output_dir: Path,
    html_collect: Callable[[str], tuple[str, str, dict[str, Any]]],
    pdf_collect: Callable[[str], tuple[str, str, dict[str, Any]]],
    overwrite: bool,
) -> dict[str, Any]:
    url = source["url"]
    doc_id = document_id(url)
    provider = "upstage" if source["is_pdf"] else "firecrawl"
    raw_path = output_dir / f"{doc_id}.response.json"
    existing_content = next(iter(output_dir.glob(f"{doc_id}.content.*")), None)
    collected_at = utc_now()

    if existing_content and raw_path.exists() and not overwrite:
        content = existing_content.read_text(encoding="utf-8")
        return {
            "document_id": doc_id,
            "source_kind": "web",
            "source_types": source["source_types"],
            "title": source["title"],
            "url": url,
            "local_path": None,
            "is_pdf": source["is_pdf"],
            "provider": provider,
            "status": "skipped",
            "collected_at": collected_at,
            "content_path": existing_content.as_posix(),
            "raw_response_path": raw_path.as_posix(),
            "content_sha256": hashlib.sha256(content.encode("utf-8")).hexdigest(),
            "content_length": len(content),
            "error": None,
        }

    try:
        collector = pdf_collect if source["is_pdf"] else html_collect
        content, suffix, raw_response = collector(url)
        content_path = output_dir / f"{doc_id}.content{suffix}"
        content_path.write_text(content, encoding="utf-8")
        write_json(raw_path, raw_response)
        return {
            "document_id": doc_id,
            "source_kind": "web",
            "source_types": source["source_types"],
            "title": source["title"],
            "url": url,
            "local_path": None,
            "is_pdf": source["is_pdf"],
            "provider": provider,
            "status": "succeeded",
            "collected_at": collected_at,
            "content_path": content_path.as_posix(),
            "raw_response_path": raw_path.as_posix(),
            "content_sha256": hashlib.sha256(content.encode("utf-8")).hexdigest(),
            "content_length": len(content),
            "error": None,
        }
    except Exception as exc:
        return {
            "document_id": doc_id,
            "source_kind": "web",
            "source_types": source["source_types"],
            "title": source["title"],
            "url": url,
            "local_path": None,
            "is_pdf": source["is_pdf"],
            "provider": provider,
            "status": "failed",
            "collected_at": collected_at,
            "content_path": None,
            "raw_response_path": None,
            "content_sha256": None,
            "content_length": 0,
            "error": str(exc),
        }


def collect_manual_one(
    source: dict[str, Any],
    output_dir: Path,
    local_collect: Callable[[Path], tuple[str, str, dict[str, Any]]],
    overwrite: bool,
) -> dict[str, Any]:
    path: Path = source["path"]
    doc_id = manual_document_id(path)
    raw_path = output_dir / f"{doc_id}.response.json"
    existing_content = next(iter(output_dir.glob(f"{doc_id}.content.*")), None)
    collected_at = utc_now()
    base = {
        "document_id": doc_id,
        "source_kind": "manual",
        "source_types": source["source_types"],
        "title": source["title"],
        "url": None,
        "local_path": path.as_posix(),
        "is_pdf": source["is_pdf"],
        "provider": "upstage",
        "collected_at": collected_at,
    }

    if existing_content and raw_path.exists() and not overwrite:
        content = existing_content.read_text(encoding="utf-8")
        return {
            **base,
            "status": "skipped",
            "content_path": existing_content.as_posix(),
            "raw_response_path": raw_path.as_posix(),
            "content_sha256": hashlib.sha256(content.encode("utf-8")).hexdigest(),
            "content_length": len(content),
            "error": None,
        }

    try:
        content, suffix, raw_response = local_collect(path)
        content_path = output_dir / f"{doc_id}.content{suffix}"
        content_path.write_text(content, encoding="utf-8")
        write_json(raw_path, raw_response)
        return {
            **base,
            "status": "succeeded",
            "content_path": content_path.as_posix(),
            "raw_response_path": raw_path.as_posix(),
            "content_sha256": hashlib.sha256(content.encode("utf-8")).hexdigest(),
            "content_length": len(content),
            "error": None,
        }
    except Exception as exc:
        return {
            **base,
            "status": "failed",
            "content_path": None,
            "raw_response_path": None,
            "content_sha256": None,
            "content_length": 0,
            "error": str(exc),
        }


def collect_all(
    discovery: dict[str, Any],
    output_dir: Path,
    html_collect: Callable[[str], tuple[str, str, dict[str, Any]]],
    pdf_collect: Callable[[str], tuple[str, str, dict[str, Any]]],
    manual_sources: list[dict[str, Any]] | None = None,
    local_collect: Callable[[Path], tuple[str, str, dict[str, Any]]] | None = None,
    all_candidates: bool = False,
    overwrite: bool = False,
) -> dict[str, Any]:
    started_at = utc_now()
    output_dir.mkdir(parents=True, exist_ok=True)
    sources = select_sources(discovery, all_candidates)
    manual_sources = manual_sources or []
    # URL로 발견한 PDF와 같은 파일명이 수동 폴더에 있으면 로컬 원본을 우선한다.
    manual_names = {source["path"].name.casefold() for source in manual_sources}
    sources = [
        source for source in sources
        if not (source["is_pdf"] and Path(urlparse(source["url"]).path).name.casefold() in manual_names)
    ]
    documents = [
        collect_one(source, output_dir, html_collect, pdf_collect, overwrite)
        for source in sources
    ]
    if manual_sources:
        if local_collect is None:
            raise CollectionError("수동 원본이 있지만 local_collect 함수가 없습니다.")
        documents.extend(
            collect_manual_one(source, output_dir, local_collect, overwrite)
            for source in manual_sources
        )
    summary = {
        "total": len(documents),
        "succeeded": sum(item["status"] == "succeeded" for item in documents),
        "failed": sum(item["status"] == "failed" for item in documents),
        "skipped": sum(item["status"] == "skipped" for item in documents),
    }
    return {
        "schema_version": "1.0.0",
        "university_name": discovery["university_name"],
        "started_at": started_at,
        "completed_at": utc_now(),
        "summary": summary,
        "documents": documents,
    }


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")

    parser = argparse.ArgumentParser(description="발견된 공식 HTML/PDF 자료를 수집합니다.")
    parser.add_argument("discovery_json", type=Path, help="discover_sources.py 결과 JSON")
    parser.add_argument("--output-dir", type=Path, required=True, help="문서와 manifest 저장 디렉터리")
    parser.add_argument("--all-candidates", action="store_true", help="대표 자료가 아닌 모든 후보도 수집")
    parser.add_argument("--overwrite", action="store_true", help="이미 수집한 문서도 다시 요청")
    parser.add_argument("--manual-dir", type=Path, help="직접 다운로드한 원본 파일 디렉터리")
    parser.add_argument("--dry-run", action="store_true", help="API 호출 없이 수집 대상만 출력")
    args = parser.parse_args()

    try:
        discovery = json.loads(args.discovery_json.read_text(encoding="utf-8-sig"))
        firecrawl = FirecrawlScraper(os.getenv("FIRECRAWL_API_KEY", ""))
        upstage = UpstagePdfParser(os.getenv("UPSTAGE_API_KEY", ""))
        manual_sources = select_manual_sources(args.manual_dir) if args.manual_dir else []
        if args.dry_run:
            web_sources = select_sources(discovery, args.all_candidates)
            manual_names = {source["path"].name.casefold() for source in manual_sources}
            web_sources = [
                source for source in web_sources
                if not (
                    source["is_pdf"]
                    and Path(urlparse(source["url"]).path).name.casefold() in manual_names
                )
            ]
            print(f"웹 수집 대상: {len(web_sources)}개")
            for source in web_sources:
                print(f"  WEB  [{','.join(source['source_types'])}] {source['url']}")
            print(f"수동 원본 대상: {len(manual_sources)}개")
            for source in manual_sources:
                print(f"  FILE [{','.join(source['source_types'])}] {source['path']}")
            return 0
        manifest = collect_all(
            discovery,
            args.output_dir,
            firecrawl.collect,
            upstage.collect,
            manual_sources,
            upstage.collect_local,
            args.all_candidates,
            args.overwrite,
        )
        manifest_path = args.output_dir / "manifest.json"
        write_json(manifest_path, manifest)
        summary = manifest["summary"]
        print(
            f"수집 완료: total={summary['total']}, succeeded={summary['succeeded']}, "
            f"failed={summary['failed']}, skipped={summary['skipped']}"
        )
        print(f"manifest: {manifest_path}")
        return 0 if summary["failed"] == 0 else 2
    except (OSError, ValueError, json.JSONDecodeError, CollectionError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
