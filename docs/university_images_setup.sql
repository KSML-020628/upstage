alter table public.universities
add column if not exists image_url text;

comment on column public.universities.image_url is
'Public URL of a copyright-cleared university representative image.';
