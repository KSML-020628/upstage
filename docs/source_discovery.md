# 공식 자료 URL 발견 단계

`discover_sources.py`는 대학명, 공식 도메인, 학년도를 입력받아 Firecrawl Search API로
교환학생 관련 공식 자료 후보를 찾는다. 이 단계에서는 페이지 본문이나 PDF를 파싱하지 않는다.

## 환경변수

```powershell
$env:FIRECRAWL_API_KEY = "fc-..."
```

API 키는 코드나 Git에 저장하지 않는다.

## 실행

```powershell
& "C:\Users\minju\miniconda3\python.exe" `
  ".\discover_sources.py" `
  --university "University of Bristol" `
  --domain "bristol.ac.uk" `
  --academic-year "2026/27" `
  --output ".\data\university_of_bristol\discovered_sources.json"
```

검색은 현재 9회 수행되며 자료 유형별 기본 상위 5개 결과를 요청한다. 비용을 줄이려면
`--limit 3`처럼 낮출 수 있다.

## 결과

- `primary_sources`: 자료 유형별 최고 점수 후보. 못 찾으면 `null`.
- `candidates`: 공식 도메인 검사를 통과한 전체 후보.
- `score`: 키워드, 공식 도메인, PDF 여부, 연도 표현을 이용한 규칙 기반 우선순위.
- `discovery_query`: 해당 URL을 발견한 검색어.

자료 유형은 다음과 같다.

- `incoming_exchange`
- `international_office`
- `fact_sheet`
- `academic_calendar`
- `course_catalog`
- `housing`
- `language_requirement`
- `application_guide`

## 오프라인 테스트

```powershell
& "C:\Users\minju\miniconda3\python.exe" -m unittest discover -s tests -v
```

Firecrawl 없이 CLI 전체 흐름을 확인하려면:

```powershell
& "C:\Users\minju\miniconda3\python.exe" `
  ".\discover_sources.py" `
  --university "University of Bristol" `
  --domain "bristol.ac.uk" `
  --academic-year "2026/27" `
  --fixture ".\tests\fixtures\bristol_search_results.json"
```
