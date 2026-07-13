# 한 명령 전체 파이프라인

대학별 설정 파일을 만든 뒤 `run_pipeline.py` 한 번으로 다음 단계를 실행한다.

```text
discover → collect → extract → quality → save → inspect
```

## 환경변수

```powershell
$env:FIRECRAWL_API_KEY = "fc-..."
$env:UPSTAGE_API_KEY = "up_..."
$env:SUPABASE_URL = "https://....supabase.co"
$env:SUPABASE_KEY = "sb_secret_..."
```

## 전체 실행

```powershell
& "C:\Users\minju\miniconda3\python.exe" `
  ".\run_pipeline.py" `
  ".\configs\bristol.json"
```

새 대학은 `configs/university.example.json`을 복사해 대학명, 공식 도메인, 학년도,
프로그램명, 수동 자료 경로를 변경한다.

## 안전한 재실행

- 기존 URL 발견 결과는 재사용한다.
- 이미 수집한 문서는 건너뛴다.
- 문서 해시가 같으면 Solar 부분 결과를 재사용한다.
- Supabase 행 수가 예상과 같으면 저장을 건너뛰고 기본정보만 동기화한다.
- 기존 행 수가 다르면 자동 삭제하지 않고 중단한다.

기존 DB 내용을 명시적으로 교체하려면:

```powershell
& "C:\Users\minju\miniconda3\python.exe" `
  ".\run_pipeline.py" `
  ".\configs\bristol.json" `
  --replace-existing
```

## 특정 단계만 실행

```powershell
# 품질 검사부터 최종 검증까지
& "C:\Users\minju\miniconda3\python.exe" `
  ".\run_pipeline.py" `
  ".\configs\bristol.json" `
  --from-stage quality

# Supabase 저장과 검증만
& "C:\Users\minju\miniconda3\python.exe" `
  ".\run_pipeline.py" `
  ".\configs\bristol.json" `
  --from-stage save
```

사용 가능한 단계명:

```text
discover, collect, extract, quality, save, inspect
```

## 강제 갱신

```text
--refresh-discovery     Firecrawl 검색을 다시 실행
--overwrite-collection 기존 문서도 다시 수집·파싱
--replace-existing      기존 Supabase 하위 행 교체
```

각 실행 결과는 대학 폴더의 `pipeline_run.json`에 저장된다.
