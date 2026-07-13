"""대학 한 곳의 발견→수집→추출→검증→Supabase 저장을 한 명령으로 실행한다."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from collect_documents import (
    FirecrawlScraper,
    UpstagePdfParser,
    collect_all,
    select_manual_sources,
    write_json as write_collection_json,
)
from discover_sources import FirecrawlSearchClient, discover_sources
from extract_university import SolarClient, extract_all, load_documents
from quality_check import clean_document
from save_university import (
    execute,
    get_supabase_client,
    inspect_existing,
    save_document,
    transform_source,
)
from validate_university import DEFAULT_SCHEMA, load_json, validate_document


STAGES = ("discover", "collect", "extract", "quality", "save", "inspect")


class PipelineError(RuntimeError):
    pass


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", value.lower()).strip("_")
    if not slug:
        raise PipelineError("대학명에서 안전한 slug를 만들 수 없습니다.")
    return slug


def load_config(path: Path) -> dict[str, Any]:
    config = load_json(path)
    required = ("university_name", "official_domain", "academic_year", "program_name")
    missing = [key for key in required if not isinstance(config.get(key), str) or not config[key].strip()]
    if missing:
        raise PipelineError(f"설정 파일의 필수 문자열 값이 없습니다: {', '.join(missing)}")
    return config


def stage_enabled(stage: str, from_stage: str, to_stage: str) -> bool:
    return STAGES.index(from_stage) <= STAGES.index(stage) <= STAGES.index(to_stage)


def manifest_fingerprint(manifest: dict[str, Any], config: dict[str, Any]) -> str:
    values = [
        config["university_name"],
        config["academic_year"],
        config["program_name"],
    ]
    for item in manifest.get("documents", []):
        if item.get("status") in {"succeeded", "skipped"}:
            values.append(str(item.get("content_sha256") or item.get("document_id")))
    return hashlib.sha256("|".join(values).encode("utf-8")).hexdigest()[:12]


def expected_row_counts(document: dict[str, Any]) -> dict[str, int]:
    transformed = transform_source(document)
    return {table: len(rows) for table, rows in transformed["children"].items()}


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def finish_report(report: dict[str, Any]) -> dict[str, Any]:
    report["status"] = "completed"
    report["completed_at"] = utc_now()
    return report


def run_pipeline(
    config: dict[str, Any],
    project_root: Path,
    from_stage: str = "discover",
    to_stage: str = "inspect",
    refresh_discovery: bool = False,
    overwrite_collection: bool = False,
    replace_existing: bool = False,
) -> dict[str, Any]:
    university_name = config["university_name"]
    academic_year = config["academic_year"]
    program_name = config["program_name"]
    slug = config.get("slug") or slugify(university_name)
    university_dir = project_root / "data" / slug
    discovery_path = university_dir / "discovered_sources.live.json"
    parsed_dir = university_dir / "parsed_documents"
    manifest_path = parsed_dir / "manifest.json"
    generated_path = university_dir / str(config.get("generated_file", "standard.generated.json"))
    cleaned_path = university_dir / str(config.get("cleaned_file", "standard.cleaned.json"))
    quality_path = university_dir / str(config.get("quality_report_file", "quality_report.json"))
    manual_dir_value = config.get("manual_dir")
    manual_dir = project_root / manual_dir_value if manual_dir_value else university_dir / "manual_sources" / "inbox"

    report: dict[str, Any] = {
        "schema_version": "1.0.0",
        "university_name": university_name,
        "started_at": utc_now(),
        "completed_at": None,
        "status": "running",
        "stages": {},
        "artifacts": {
            "discovery": discovery_path.as_posix(),
            "manifest": manifest_path.as_posix(),
            "generated": generated_path.as_posix(),
            "cleaned": cleaned_path.as_posix(),
            "quality_report": quality_path.as_posix(),
        },
    }

    try:
        if stage_enabled("discover", from_stage, to_stage):
            if discovery_path.exists() and not refresh_discovery:
                discovery = load_json(discovery_path)
                report["stages"]["discover"] = {"status": "reused", "candidates": len(discovery["candidates"])}
            else:
                search_client = FirecrawlSearchClient(os.getenv("FIRECRAWL_API_KEY", ""))
                discovery = discover_sources(
                    university_name,
                    config["official_domain"],
                    academic_year,
                    search_client.search,
                    int(config.get("search_limit", 3)),
                )
                write_json(discovery_path, discovery)
                report["stages"]["discover"] = {"status": "completed", "candidates": len(discovery["candidates"])}
        else:
            discovery = load_json(discovery_path)
        if to_stage == "discover":
            return finish_report(report)

        if stage_enabled("collect", from_stage, to_stage):
            firecrawl = FirecrawlScraper(os.getenv("FIRECRAWL_API_KEY", ""))
            upstage = UpstagePdfParser(os.getenv("UPSTAGE_API_KEY", ""))
            manual_sources = select_manual_sources(manual_dir)
            manifest = collect_all(
                discovery,
                parsed_dir,
                firecrawl.collect,
                upstage.collect,
                manual_sources=manual_sources,
                local_collect=upstage.collect_local,
                overwrite=overwrite_collection,
            )
            write_collection_json(manifest_path, manifest)
            succeeded = int(manifest["summary"].get("succeeded", 0))
            failed = int(manifest["summary"].get("failed", 0))
            collect_status = "completed_with_warnings" if failed else "completed"
            report["stages"]["collect"] = {"status": collect_status, **manifest["summary"]}
            # 공식 사이트의 오래된 PDF 링크 하나가 404여도, 수집된 다른 근거로
            # 추출을 계속할 수 있어야 한다. 쓸 수 있는 문서가 하나도 없을 때만 중단한다.
            if succeeded == 0:
                raise PipelineError("성공적으로 수집된 문서가 없습니다.")
        else:
            manifest = load_json(manifest_path)
        if to_stage == "collect":
            return finish_report(report)

        if stage_enabled("extract", from_stage, to_stage):
            _, documents = load_documents(manifest_path)
            fingerprint = manifest_fingerprint(manifest, config)
            run_dir = university_dir / "extraction_runs" / fingerprint
            api_key = os.getenv("UPSTAGE_API_KEY", "")
            client = SolarClient(api_key, str(config.get("solar_model", "solar-pro3"))) if api_key else None

            def require_key(_system: str, _user: str):
                raise PipelineError("캐시되지 않은 Solar 그룹 추출에는 UPSTAGE_API_KEY가 필요합니다.")

            generated = extract_all(
                documents,
                client.complete_json if client else require_key,
                university_name,
                academic_year,
                program_name,
                datetime.now().date().isoformat(),
                run_dir,
            )
            write_json(generated_path, generated)
            report["stages"]["extract"] = {"status": "completed", "run_id": fingerprint}
        else:
            generated = load_json(generated_path)
        if to_stage == "extract":
            return finish_report(report)

        if stage_enabled("quality", from_stage, to_stage):
            cleaned, quality = clean_document(generated)
            write_json(cleaned_path, cleaned)
            write_json(quality_path, quality)
            report["stages"]["quality"] = {"status": "completed", **quality["summary"]}
        else:
            cleaned = load_json(cleaned_path)
        if to_stage == "quality":
            return finish_report(report)

        validate_document(cleaned, load_json(DEFAULT_SCHEMA))

        if stage_enabled("save", from_stage, to_stage):
            client = get_supabase_client()
            current = inspect_existing(client, cleaned)
            expected = expected_row_counts(cleaned)
            if current.get("exists") and current.get("row_counts") == expected:
                transformed = transform_source(cleaned)
                execute(
                    client.table("universities").update(transformed["university"]).eq(
                        "id", current["university_id"]
                    ),
                    "대학 기본정보 동기화",
                )
                execute(
                    client.table("exchange_programs").update(transformed["program"]).eq(
                        "id", current["exchange_program_id"]
                    ),
                    "교환 프로그램 기본정보 동기화",
                )
                report["stages"]["save"] = {"status": "already_complete", "row_counts": expected}
            elif current.get("exists") and not replace_existing:
                raise PipelineError(
                    f"기존 DB 행 수가 예상과 다릅니다. current={current.get('row_counts')}, "
                    f"expected={expected}. 교체하려면 --replace-existing을 사용하세요."
                )
            else:
                saved = save_document(client, cleaned, replace_existing)
                report["stages"]["save"] = {"status": "completed", **saved}
        if to_stage == "save":
            return finish_report(report)

        if stage_enabled("inspect", from_stage, to_stage):
            client = get_supabase_client()
            inspected = inspect_existing(client, cleaned)
            expected = expected_row_counts(cleaned)
            if not inspected.get("exists") or inspected.get("row_counts") != expected:
                raise PipelineError(f"Supabase 최종 검증 불일치: actual={inspected}, expected={expected}")
            report["stages"]["inspect"] = {"status": "completed", **inspected}

        return finish_report(report)
    except Exception as exc:
        report["status"] = "failed"
        report["completed_at"] = utc_now()
        report["error"] = str(exc)
        raise PipelineError(str(exc)) from exc
    finally:
        write_json(university_dir / "pipeline_run.json", report)


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")

    parser = argparse.ArgumentParser(description="대학 조사 전체 파이프라인을 한 번에 실행합니다.")
    parser.add_argument("config", type=Path, help="대학별 pipeline 설정 JSON")
    parser.add_argument("--from-stage", choices=STAGES, default="discover")
    parser.add_argument("--to-stage", choices=STAGES, default="inspect")
    parser.add_argument("--refresh-discovery", action="store_true")
    parser.add_argument("--overwrite-collection", action="store_true")
    parser.add_argument("--replace-existing", action="store_true")
    parser.add_argument("--dry-run", action="store_true", help="설정과 실행 단계만 확인")
    args = parser.parse_args()

    try:
        config = load_config(args.config)
        if STAGES.index(args.from_stage) > STAGES.index(args.to_stage):
            raise PipelineError("--from-stage는 --to-stage보다 앞 단계여야 합니다.")
        if args.dry_run:
            print(json.dumps({
                "config": config,
                "stages": list(STAGES[STAGES.index(args.from_stage):STAGES.index(args.to_stage) + 1]),
                "replace_existing": args.replace_existing,
            }, ensure_ascii=False, indent=2))
            return 0
        report = run_pipeline(
            config,
            Path.cwd(),
            args.from_stage,
            args.to_stage,
            args.refresh_discovery,
            args.overwrite_collection,
            args.replace_existing,
        )
        print(f"PIPELINE COMPLETED: {report['university_name']}")
        for name, result in report["stages"].items():
            print(f"  {name}: {result['status']}")
        return 0
    except Exception as exc:
        print(f"PIPELINE FAILED: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
