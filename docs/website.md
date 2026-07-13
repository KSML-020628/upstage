# SKKU Exchange Atlas

웹 앱은 `web/`에 있으며 Supabase를 읽기 전용으로 조회합니다. 대학과 프로그램이 추가되면 목록과 상세 페이지에 자동 반영됩니다.

## 로컬 설정

`web/.env.example`을 `web/.env.local`로 복사하고 프로젝트 URL과 publishable key를 설정합니다. 웹 앱에는 service-role/secret key를 절대 넣지 않습니다.

Supabase SQL Editor에서 `docs/website_supabase_setup.sql`을 한 번 실행해 공개 읽기 정책과 좌표 컬럼을 준비합니다.

## 화면 구조

- `/`: 지도 중심 대학 탐색 및 검색
- `/universities`: 대학 카드 목록과 필터 UI
- `/universities/[id]`: 프로그램, 지원 일정, 어학, 학사 일정, 기숙사, 비용, 서류, 출처

환경 변수가 없거나 Supabase 조회가 실패하면 Bristol과 Edinburgh 예시 데이터가 표시됩니다.
