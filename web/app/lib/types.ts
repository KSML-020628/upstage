export type University = {
  id: string;
  university_name: string;
  country: string;
  city: string;
  summary: string;
  official_website_url?: string;
  incoming_exchange_url?: string;
  latitude: number;
  longitude: number;
  image_url?: string;
  exchange_programs?: ExchangeProgram[];
  profile_sections?: ProfileSection[];
  unknowns?: string[];
};

export type ExchangeProgram = {
  id: string;
  university_id: string;
  academic_year: string;
  program_name: string;
  exchange_type?: string;
  application_process?: string;
  course_registration_notes?: string;
  application_deadlines?: ApplicationDeadline[];
  language_requirements?: LanguageRequirement[];
  academic_periods?: AcademicPeriod[];
  housing_options?: HousingOption[];
  estimated_costs?: EstimatedCost[];
  course_restrictions?: CourseRestriction[];
  quota_facts?: FlexibleRow[];
  required_documents?: RequiredDocument[];
  source_links?: SourceLink[];
};

type FlexibleRow = Record<string, unknown>;

export type ApplicationDeadline = FlexibleRow & {
  semester?: string | null;
  deadline_type?: string | null;
  deadline_date?: string | null;
  deadline_text?: string | null;
  date?: string | null;
  source_url?: string | null;
  source_type?: string | null;
  evidence_quote?: string | null;
  confidence?: number | string | null;
  review_status?: string | null;
};

export type LanguageRequirement = FlexibleRow & {
  language?: string | null;
  test_type?: string | null;
  minimum_score?: number | string | null;
  minimum_subscores?: Record<string, unknown> | string | null;
  cefr_level?: string | null;
  overall_score?: number | string | null;
  level?: string | null;
  is_required?: boolean | null;
  notes?: string | null;
  source_url?: string | null;
  source_type?: string | null;
  evidence_quote?: string | null;
  confidence?: number | string | null;
  review_status?: string | null;
};

export type AcademicPeriod = FlexibleRow & {
  semester?: string | null;
  period_type?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  source_url?: string | null;
  evidence_quote?: string | null;
};

export type HousingOption = FlexibleRow & {
  housing_available?: boolean | null;
  housing_guaranteed?: boolean | null;
  housing_type?: string | null;
  housing_category?: string | null;
  meal_type?: string | null;
  room_type?: string | null;
  cost_min?: number | string | null;
  cost_max?: number | string | null;
  currency?: string | null;
  billing_period?: string | null;
  application_required?: boolean | null;
  deadline?: string | null;
  is_guaranteed?: boolean | null;
  source_url?: string | null;
  source_type?: string | null;
  evidence_quote?: string | null;
  confidence?: number | string | null;
  review_status?: string | null;
};

export type EstimatedCost = FlexibleRow & {
  cost_type?: string | null;
  amount_min?: number | string | null;
  amount_max?: number | string | null;
  currency?: string | null;
  billing_period?: string | null;
  reference_period?: string | null;
  normalized_krw_min?: number | string | null;
  normalized_krw_max?: number | string | null;
  original_text?: string | null;
  source_url?: string | null;
  source_type?: string | null;
  evidence_quote?: string | null;
  confidence?: number | string | null;
  review_status?: string | null;
};

export type CourseRestriction = FlexibleRow & {
  restriction_type?: string | null;
  department_or_school?: string | null;
  restriction_text?: string | null;
  applies_to_exchange?: boolean | null;
  source_url?: string | null;
  source_type?: string | null;
  evidence_quote?: string | null;
  confidence?: number | string | null;
  review_status?: string | null;
};

export type RequiredDocument = FlexibleRow & {
  document_type?: string | null;
  document_name?: string | null;
  is_required?: boolean | null;
  preparation_stage?: string | null;
};

export type SourceLink = FlexibleRow & {
  title?: string | null;
  url?: string | null;
  source_type?: string | null;
  is_official?: boolean | null;
  evidence_quote?: string | null;
};

export type ProfileSection = {
  section_number: string;
  section_title: string;
  summary: string;
  source_note?: string;
  evidence_url?: string;
};
