# Solar Pro 표준 JSON 추출

`extract_university.py`는 `parsed_documents/manifest.json`에서 성공 또는 건너뜀 상태의
본문을 읽고 Solar Pro 3에 5개 영역으로 나눠 요청한다.

1. 대학 및 프로그램 기본정보
2. 지원 일정·어학·서류
3. 학사일정·수강 정보
4. 숙소·비용
5. 학생생활·현지 경험

공식 자료, 내부 보조 자료, 비공식 학생 후기는 서로 다른 권위 라벨로 전달된다.
학생 후기는 개인 경험으로만 사용하며 공식 최신 자료를 덮어쓰지 않는다.

## Dry-run

```powershell
& "C:\Users\minju\miniconda3\python.exe" `
  ".\extract_university.py" `
  ".\data\university_of_bristol\parsed_documents\manifest.json" `
  --university "University of Bristol" `
  --academic-year "2026/27" `
  --program-name "Study Abroad" `
  --output ".\data\university_of_bristol\bristol.standard.generated.json" `
  --dry-run
```

## 실제 실행

```powershell
$env:UPSTAGE_API_KEY = "up_..."

& "C:\Users\minju\miniconda3\python.exe" `
  ".\extract_university.py" `
  ".\data\university_of_bristol\parsed_documents\manifest.json" `
  --university "University of Bristol" `
  --academic-year "2026/27" `
  --program-name "Study Abroad" `
  --output ".\data\university_of_bristol\bristol.standard.generated.json"
```

실제 실행은 Solar API를 5회 호출한다. 그룹별 프롬프트, 부분 JSON, 원본 API 응답은
`extraction_runs/<run-id>/`에 저장된다. 최종 결과는
`schemas/university_research.schema.json` 검증을 통과해야만 출력 파일로 저장된다.
