create table if not exists public.presentations (
  id uuid primary key,
  title text not null,
  size bigint not null check (size >= 0 and size <= 52428800),
  uploaded_at timestamptz not null,
  ppt_name text,
  ppt_ext text check (ppt_ext is null or ppt_ext in ('.pptx', '.ppt', '.ppsx', '.pps')),
  ppt_size bigint check (ppt_size is null or (ppt_size >= 0 and ppt_size <= 52428800))
);

alter table public.presentations enable row level security;
revoke all on table public.presentations from anon, authenticated;
grant all on table public.presentations to service_role;

insert into storage.buckets (id, name, public, file_size_limit)
values ('presentations', 'presentations', false, 52428800)
on conflict (id) do update
set public = false,
    file_size_limit = 52428800;
