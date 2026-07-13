# 조사 프롬프트 → 표준 JSON 매핑

표준 계약 버전: `1.0.0`

이 문서는 기존 22개 조사 영역을 `university_research.schema.json`의 필드로 연결한다.
현재 Supabase에 전용 컬럼이 없는 서술형 정보는 대학 JSONB 필드 또는
`exchange_program.additional_requirements`에 보존한다.

| 조사 영역 | 표준 JSON 저장 위치 | 비고 |
|---|---|---|
| 1. 성균관대 자료 검증 | `unverified_items`, `source_links` | 상대교 공식 정보와 충돌하면 `unverified_items`에 기록 |
| 2. 대학 기본정보 | `university` | 대학명, 국가, 도시, 홈페이지, 학생 수 |
| 3. 캠퍼스 위치·구성 | `university.latitude`, `longitude`, `facilities` | 복수 캠퍼스 상세화는 향후 별도 테이블 후보 |
| 4. 공항·대학 이동 | `university.local_life` | 교통비는 `estimated_costs`에도 별도 저장 |
| 5. 대학 평가·랭킹 | `exchange_program.additional_requirements.rankings` | 적용연도와 평가기관을 함께 보존 |
| 6. 강점 분야·교육 성격 | `university.strengths`, `summary` | 공식 근거가 없으면 `unverified_items` |
| 7. 지원 자격·마감일 | `exchange_program`, `application_deadlines` | GPA·학년·quota와 마감일 분리 |
| 8. 지원 서류·타임라인 | `required_documents` | 준비 시점은 `preparation_stage` |
| 9. 어학 정보 | `language_requirements` | 시험별로 한 행씩 저장 |
| 10. 학사 일정 | `academic_periods` | 학기·오리엔테이션·시험을 기간별 저장 |
| 11. 수강 신청·학점 | `exchange_program.course_registration_notes` | 최소·최대 학점은 `additional_requirements` |
| 12. 학과·전공·제한 과목 | `exchange_program.course_restrictions`, `additional_requirements` | 구조화 검색 수요가 커지면 별도 테이블로 분리 |
| 13. 캠퍼스 시설 | `university.facilities` | 문자열 배열 |
| 14. 기숙사·숙소 | `housing_options` | 객실 유형·비용·보장 조건별로 한 행 |
| 15. 예상 비용 | `estimated_costs` | 금액·통화·기간을 분리하고 원문 보존 |
| 16. 대중교통·학생 할인 | `university.local_life`, `estimated_costs` | 교통 링크는 `source_links` |
| 17. 학생생활 | `university.student_life` | Buddy, Mentor, ESN, 동아리 등 |
| 18. 현지생활 | `university.local_life` | 치안·병원·통신·비자 접근성 등 |
| 19. 항공편 | `university.local_life`, `estimated_costs` | 항공권 링크는 `source_links` |
| 20. 교환학생 후기 | `source_links` | `is_official=false`; 경험을 일반 사실로 저장하지 않음 |
| 21. 공식 자료 링크 | `source_links` | 자료 하나당 한 행 |
| 22. 확인하기 어려운 정보 | `unverified_items` | 정해진 `reason` 값 사용 |

## 값 표현 원칙

- 확인하지 못한 단일 값: `null`
- 현재 결과에 항목이 없는 목록: `[]`
- 날짜: 정확한 경우에만 `YYYY-MM-DD`; 불명확한 표현은 `*_text`
- 비용: 숫자, ISO 4217 통화 코드, 기간을 분리하고 `original_text` 보존
- Boolean: 확인된 참/거짓만 `true`/`false`; 미확인은 `null`
- URL: `https://` 또는 `http://`를 포함한 직접 링크
- 출처가 없는 주요 사실: 값으로 확정하지 말고 `unverified_items`에 기록

## 적재 시 처리

`unverified_items`는 현재 별도 Supabase 테이블이 없으므로
`exchange_programs.additional_requirements.unverified_items`에 보존한다.
추후 검수 화면에서 항목별 상태 변경이 필요해지면 전용 테이블로 분리한다.
