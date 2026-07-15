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
  application_deadlines?: Record<string, unknown>[];
  language_requirements?: Record<string, unknown>[];
  academic_periods?: Record<string, unknown>[];
  housing_options?: Record<string, unknown>[];
  estimated_costs?: Record<string, unknown>[];
  required_documents?: Record<string, unknown>[];
  source_links?: Record<string, unknown>[];
};

export type ProfileSection = {
  section_number: string;
  section_title: string;
  summary: string;
  source_note?: string;
  evidence_url?: string;
};
