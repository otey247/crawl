-- Ride board, photographer picks, catch-up tracking.
create table ride_offers (
  id uuid primary key default gen_random_uuid(),
  crawl_id uuid not null references crawls(id) on delete cascade,
  driver_id uuid not null references users(id) on delete cascade,
  seats smallint not null check (seats between 1 and 8),
  area text not null,
  leaving_note text,
  created_at timestamptz not null default now(),
  unique (crawl_id, driver_id)
);

create table ride_requests (
  crawl_id uuid not null references crawls(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  destination text not null,
  party_size smallint not null default 1 check (party_size between 1 and 4),
  offer_id uuid references ride_offers(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (crawl_id, user_id)
);

alter table photos add column featured_at timestamptz;
alter table photos add column featured_by uuid references users(id) on delete set null;

alter table memberships add column catching_up_since timestamptz;
alter table memberships add column catching_up_stop_id uuid;
