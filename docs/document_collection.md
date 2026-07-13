# HTML 및 PDF 문서 수집

`collect_documents.py`는 `discover_sources.py` 결과에서 자료 유형별 대표 URL을 선택한다.
HTML은 Firecrawl Scrape로 Markdown을 만들고, PDF는 파일을 내려받아 Upstage Document
Parse로 HTML 또는 Markdown을 만든다.

## 환경변수

```powershell
$env:FIRECRAWL_API_KEY = "fc-..."
$env:UPSTAGE_API_KEY = "up_..."
```

## 실행

```powershell
& "C:\Users\minju\miniconda3\python.exe" `
  ".\collect_documents.py" `
  ".\data\university_of_bristol\discovered_sources.live.json" `
  --output-dir ".\data\university_of_bristol\parsed_documents"
```

기본 실행은 자료 유형별 대표 URL만 수집한다. 모든 후보를 수집하려면
`--all-candidates`를 사용하지만 API 사용량이 크게 증가할 수 있다.

이미 성공한 문서는 URL 기반 ID로 감지해 `skipped` 처리한다. 강제로 다시 수집하려면
`--overwrite`를 사용한다.

## 출력

```text
parsed_documents/
├── manifest.json
├── <document_id>.content.md
├── <document_id>.content.html
└── <document_id>.response.json
```

## 수동 다운로드 자료 포함

직접 다운로드한 PDF, Word, Excel, PowerPoint, 이미지를 함께 처리하려면 실제 폴더를
`--manual-dir`로 전달한다.

```powershell
& "C:\Users\minju\miniconda3\python.exe" `
  ".\collect_documents.py" `
  ".\data\university_of_bristol\discovered_sources.live.json" `
  --output-dir ".\data\university_of_bristol\parsed_documents" `
  --manual-dir ".\data\university_of_bristol\manual sources\inbox"
```

원본은 이동하거나 수정하지 않는다. 웹에서 발견한 PDF와 같은 파일명이 수동 폴더에
있으면 다운로드 없이 로컬 원본을 우선한다.

- `content.*`: 다음 Solar 추출 단계에 전달할 본문
- `response.json`: Firecrawl 또는 Upstage 원본 응답
- `manifest.json`: URL, 수집 상태, 오류, 해시, 저장 경로

종료 코드는 전체 성공 `0`, 실행 설정 오류 `1`, 일부 문서 실패 `2`다. 일부 실패가 있어도
성공한 문서는 그대로 보존한다.
