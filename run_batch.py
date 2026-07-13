from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from run_pipeline import STAGES, run_pipeline as run_one


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def save(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def load_batch(path: Path, root: Path) -> list[dict[str, Any]]:
    document = json.loads(path.read_text(encoding="utf-8"))
    defaults = document.get("defaults", {})
    result: list[dict[str, Any]] = []
    for item in document.get("universities", []):
        config = {**defaults, **item}
        slug = str(config["slug"])
        config["manual_dir"] = str(
            config.get("manual_dir")
            or Path("data") / slug / "manual sources" / "inbox"
        )
        if not (root / config["manual_dir"]).exists():
            raise ValueError(f"수학보고서 폴더가 없습니다: {root / config['manual_dir']}")
        result.append(config)
    if not result:
        raise ValueError("배치 대상 대학이 없습니다.")
    return result


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")

    parser = argparse.ArgumentParser(description="여러 대학 파이프라인을 순차 실행합니다.")
    parser.add_argument(
        "manifest",
        type=Path,
        nargs="?",
        default=Path("configs/batch_universities.json"),
    )
    parser.add_argument("--from-stage", choices=STAGES, default="discover")
    parser.add_argument("--to-stage", choices=STAGES, default="inspect")
    parser.add_argument("--only", action="append")
    parser.add_argument("--start-at", type=int, default=1)
    parser.add_argument("--refresh-discovery", action="store_true")
    parser.add_argument("--overwrite-collection", action="store_true")
    parser.add_argument("--replace-existing", action="store_true")
    parser.add_argument("--stop-on-error", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if STAGES.index(args.from_stage) > STAGES.index(args.to_stage):
        parser.error("--from-stage는 --to-stage보다 앞 단계여야 합니다.")

    root = Path.cwd()
    configs = load_batch(args.manifest, root)
    if args.only:
        needles = [item.casefold() for item in args.only]
        configs = [
            config
            for config in configs
            if any(
                needle in f"{config['university_name']} {config['slug']}".casefold()
                for needle in needles
            )
        ]
    configs = configs[max(0, args.start_at - 1):]
    report = {
        "started_at": now(),
        "completed_at": None,
        "status": "running",
        "total": len(configs),
        "succeeded": 0,
        "failed": 0,
        "results": [],
    }
    report_path = root / "data" / "batch_pipeline_run.json"

    for index, config in enumerate(configs, 1):
        name = config["university_name"]
        print(f"\n[{index}/{len(configs)}] {name}", flush=True)
        if args.dry_run:
            report["results"].append(
                {"university_name": name, "status": "dry_run", "config": config}
            )
            continue
        try:
            item = run_one(
                config,
                root,
                args.from_stage,
                args.to_stage,
                args.refresh_discovery,
                args.overwrite_collection,
                args.replace_existing,
            )
            report["succeeded"] += 1
            report["results"].append(
                {"university_name": name, "status": "completed", "report": item}
            )
            print(f"COMPLETED: {name}", flush=True)
        except KeyboardInterrupt:
            report["completed_at"] = now()
            report["status"] = "interrupted"
            report["results"].append(
                {"university_name": name, "status": "interrupted"}
            )
            save(report_path, report)
            print(
                f"\n중단됨: 현재 대학은 캐시를 재사용해 다시 실행할 수 있습니다. "
                f"보고서: {report_path}",
                file=sys.stderr,
            )
            return 130
        except Exception as exc:
            report["failed"] += 1
            report["results"].append(
                {"university_name": name, "status": "failed", "error": str(exc)}
            )
            print(f"FAILED: {name}: {exc}", file=sys.stderr, flush=True)
            save(report_path, report)
            if args.stop_on_error:
                break

    report["completed_at"] = now()
    report["status"] = "completed_with_errors" if report["failed"] else "completed"
    save(report_path, report)
    print(
        f"\nBATCH FINISHED: total={report['total']} "
        f"succeeded={report['succeeded']} failed={report['failed']}"
    )
    print(f"report: {report_path}")
    return 1 if report["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
