# 여러 대학 일괄 실행

`configs/batch_universities.json`에 등록된 대학을 순서대로 처리합니다. 한 대학이 실패해도 기본적으로 다음 대학을 계속 실행하며 결과는 `data/batch_pipeline_run.json`에 저장됩니다.

## 설정만 점검

```powershell
& "C:\Users\minju\miniconda3\python.exe" ".\run_batch.py" --dry-run
```

## 전체 실행

```powershell
& "C:\Users\minju\miniconda3\python.exe" ".\run_batch.py" --replace-existing
```

## 일부 대학만 실행

```powershell
& "C:\Users\minju\miniconda3\python.exe" ".\run_batch.py" --only "KU Leuven" --only "Helsinki"
```

## 중간 단계부터 재개

```powershell
& "C:\Users\minju\miniconda3\python.exe" ".\run_batch.py" --start-at 5 --from-stage collect --replace-existing
```

지원하지 않는 원본 확장자는 경고 후 건너뜁니다. 변환한 PDF가 같은 폴더에 있으면 PDF가 정상 처리됩니다.
