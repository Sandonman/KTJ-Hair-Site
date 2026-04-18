create table if not exists public.client_notes (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  client_name text not null,
  client_phone text,
  client_email text,
  formula_notes text,
  style_notes text,
  general_notes text,
  hair_photo_path text
);
