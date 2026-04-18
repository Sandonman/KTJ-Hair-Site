create extension if not exists pgcrypto;

create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text not null,
  phone text not null,
  email text not null,
  service text not null,
  add_haircut boolean default false,
  appointment_date text not null,
  appointment_time text not null,
  notes text,
  current_hair_image_url text,
  inspiration_image_url text,
  status text not null default 'new'
);

create table if not exists public.contact_messages (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text not null,
  email text not null,
  phone text,
  message text not null,
  status text not null default 'new'
);
