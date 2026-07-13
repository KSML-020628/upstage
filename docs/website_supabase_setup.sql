-- Website location fields. NULL means not yet verified.
alter table public.universities
  add column if not exists latitude double precision,
  add column if not exists longitude double precision;

-- Public website users only need SELECT access. Keep writes restricted to the
-- backend service-role key used by the collection pipeline.
alter table public.universities enable row level security;
alter table public.exchange_programs enable row level security;
alter table public.application_deadlines enable row level security;
alter table public.language_requirements enable row level security;
alter table public.academic_periods enable row level security;
alter table public.housing_options enable row level security;
alter table public.estimated_costs enable row level security;
alter table public.required_documents enable row level security;
alter table public.source_links enable row level security;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'universities', 'exchange_programs', 'application_deadlines',
    'language_requirements', 'academic_periods', 'housing_options',
    'estimated_costs', 'required_documents', 'source_links'
  ] loop
    if not exists (
      select 1
      from pg_policies
      where schemaname = 'public'
        and tablename = table_name
        and policyname = 'Public read access'
    ) then
      execute format(
        'create policy "Public read access" on public.%I for select to anon, authenticated using (true)',
        table_name
      );
    end if;
  end loop;
end $$;

update public.universities
set latitude = 51.4584, longitude = -2.6030
where university_name = 'University of Bristol';

update public.universities
set latitude = 55.9445, longitude = -3.1892
where university_name = 'University of Edinburgh';
