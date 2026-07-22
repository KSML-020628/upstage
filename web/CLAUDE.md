# Exchange Atlas — 작업 규칙

## 표시 계층 규칙
- fact 표시 문자열은 `lib/display/present-fact.ts` 에서만 생성한다.
  `route.ts` / `ChatbotWidget.tsx` / `page.tsx` 에서 직접 조립하지 않는다.
- `housing_guaranteed`·`is_guaranteed` 는 null/false/true 3상태를 뭉개지 않는다.
  null(미확인)은 표시하지 않는다("보장 아님"으로 렌더 금지).
- 표 셀 값에 그룹 헤더와 같은 단어를 접두하지 않는다.
- 한국어 UI이므로 일반 용어는 한국어로 통일한다. 대학 고유명사는 번역하지 않는다.
- 새 fieldKey 를 추가하면 presenter 함수와 `tests/present-fact.golden.test.ts` 케이스를 함께 추가한다.
- 짧은 답변(shortAnswer)에는 조건을 **모두** 확인한 대학(matched)만 이름을 나열한다.
  부분 확인 대학(partially_matched)은 개수만 언급하고 이름을 노출하지 않는다
  (`authoritativeShortAnswer` in `app/api/chat/route.ts`).
- 한글 대학명 별칭은 `app/lib/chat/university-aliases.ts` 의 `UNIVERSITY_ALIASES` 에 등록하고,
  구어체에서 흔히 생략되는 "대학교"/"대" 접미사가 없는 형태도 매칭되는지 확인한다
  (`aliasVariants`가 접미사를 벗겨낸 어간도 함께 비교한다).
- 같은 fact가 언어만 다르게 중복 저장된 경우(예: application_deadlines 에 영어 행과
  한국어 번역 행이 별도 row로 들어간 사례)는 표시 단계가 아니라 데이터 하이드레이션
  단계(`app/lib/supabase.ts`)에서 (semester, deadline type, date) 기준으로 한 번만
  남기고 정리한다. 표시 함수가 같은 사실을 두 번 나열하지 않도록 한다.

## 버그 수정 규칙
- 버그는 인스턴스가 아니라 클래스를 고친다.
  같은 원인의 형제 케이스를 전부 찾아 목록화한 뒤 공통 지점 한 곳을 수정한다.
- 수정 후 반드시 `node --test tests/present-fact.golden.test.ts` 와 `node qa-runner.mjs`
  (로컬 개발 서버 대상)를 실행하고 결과를 보고한다.
- qa-runner 의 검사 규칙이 오탐을 낸다고 판단되면, 실제 데이터를 직접 조회해
  근거를 확인한 뒤에만 규칙을 조정한다. 근거 없이 규칙을 느슨하게 바꿔 통과시키지 않는다.
