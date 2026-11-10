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

create table if not exists public.presenter_credentials (
  id integer primary key check (id = 1),
  salt text not null,
  password_hash text not null,
  updated_at timestamptz not null default now()
);

alter table public.presenter_credentials enable row level security;
revoke all on table public.presenter_credentials from anon, authenticated;
grant all on table public.presenter_credentials to service_role;

insert into storage.buckets (id, name, public, file_size_limit)
values ('presentations', 'presentations', false, 52428800)
on conflict (id) do update
set public = false,
    file_size_limit = 52428800;
