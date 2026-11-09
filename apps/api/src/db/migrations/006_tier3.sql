-- Templates, St. Louis events, venue claims, weather cache, follows.
create table templates (
  id uuid primary key default gen_random_uuid(),
  slug text unique,
  title text not null,
  description text,
  neighborhood_id text references neighborhoods(id),
  created_by uuid references users(id) on delete set null,
  source_crawl_id uuid references crawls(id) on delete set null,
  visibility text not null default 'public' check (visibility in ('public', 'private')),
  curated boolean not null default false,
  stops jsonb not null,            -- [{ venueId, dwellMin }]
  tags text[] not null default '{}',
  uses int not null default 0,
  created_at timestamptz not null default now()
);

create table events (
  id uuid primary key default gen_random_uuid(),
  external_id text unique,
  city_id text not null references cities(id),
  neighborhood_ids text[] not null default '{}',
  kind text not null check (kind in ('parade', 'holiday', 'sports', 'festival')),
  title text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  crowd_factor real not null default 1 check (crowd_factor between 1 and 3),
  advice text[] not null default '{}',
  source_url text,
  verified boolean not null default false
);
create index events_time on events (starts_at, ends_at);

alter table venues add column website text;

create table venue_claims (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references venues(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  contact_email text not null,
  contact_phone text,
  role text not null,
  message text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  verification text not null check (verification in ('email_domain', 'manual')),
  code_hash text,
  code_expires_at timestamptz,
  attempts int not null default 0,
  reviewed_by uuid references users(id),
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz not null default now(),
  unique (venue_id, user_id)
);

alter table users add column is_admin boolean not null default false;
alter table users add column activity_visibility text not null default 'followers' check (activity_visibility in ('followers', 'nobody'));

create table follows (
  follower_id uuid not null references users(id) on delete cascade,
  followee_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, followee_id),
  check (follower_id <> followee_id)
);
create index follows_followee on follows (followee_id);

create table weather_cache (
  key text primary key,
  value jsonb not null,
  fetched_at timestamptz not null default now()
);
