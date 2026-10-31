-- Crawl schema. Coordinates are plain lat/lng doubles so the schema runs on stock Postgres;
-- when PostGIS is available, 002_postgis.sql adds geography columns and GiST indexes.

create table users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  display_name text not null,
  avatar_url text,
  dob_verified_at timestamptz,
  push_tokens text[] not null default '{}',
  is_dev_seed boolean not null default false,
  created_at timestamptz not null default now()
);

create table magic_links (
  token_hash text primary key,
  email text not null,
  display_name text,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table cities (
  id text primary key,
  name text not null,
  timezone text not null,
  center_lat double precision not null,
  center_lng double precision not null
);

create table neighborhoods (
  id text primary key,
  city_id text not null references cities(id),
  name text not null,
  center_lat double precision not null,
  center_lng double precision not null,
  zoom double precision not null default 15,
  bbox double precision[] not null -- [south, west, north, east]
);

create table venues (
  id uuid primary key default gen_random_uuid(),
  osm_id text unique,
  name text not null,
  name_override text,
  lat double precision not null,
  lng double precision not null,
  address text,
  neighborhood_id text references neighborhoods(id),
  category text not null default 'bar' check (category in ('pub','bar','biergarten','cocktail')),
  price_level smallint,
  tags text[] not null default '{}',
  opening_hours text,
  image_url text,
  claimed_by uuid references users(id),
  source text not null default 'osm',
  synced_at timestamptz,
  created_at timestamptz not null default now()
);
create index venues_latlng on venues (lat, lng);
create index venues_name on venues (lower(coalesce(name_override, name)));

create table crawls (
  id uuid primary key default gen_random_uuid(),
  organizer_id uuid not null references users(id),
  title text not null,
  description text,
  visibility text not null default 'private' check (visibility in ('public','private')),
  date date not null,
  start_at timestamptz not null,
  timezone text not null,
  status text not null default 'draft' check (status in ('draft','planned','live','ended')),
  neighborhood_id text references neighborhoods(id),
  approved_route_id uuid,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index crawls_public on crawls (visibility, status, start_at);

create table specials (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references venues(id) on delete cascade,
  crawl_id uuid references crawls(id) on delete cascade,
  title text not null,
  details text,
  days_of_week smallint[] not null default '{}',
  start_time text not null,
  end_time text not null,
  valid_from date,
  valid_to date,
  source text not null check (source in ('venue','organizer','crowd')),
  confidence real not null,
  confirmations int not null default 0,
  last_confirmed_at timestamptz,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create index specials_venue on specials (venue_id);

create table crawl_stops (
  id uuid primary key default gen_random_uuid(),
  crawl_id uuid not null references crawls(id) on delete cascade,
  venue_id uuid not null references venues(id),
  position int not null,
  dwell_min int not null default 45,
  locked boolean not null default false,
  planned_arrival_at timestamptz,
  planned_departure_at timestamptz,
  arrived_at timestamptz,
  departed_at timestamptz,
  skipped boolean not null default false,
  unique (crawl_id, venue_id)
);
create index crawl_stops_crawl on crawl_stops (crawl_id, position);

create table routes (
  id uuid primary key default gen_random_uuid(),
  crawl_id uuid not null references crawls(id) on delete cascade,
  status text not null check (status in ('pending','proposed','approved','superseded','failed')),
  stop_order uuid[] not null default '{}',
  geometry jsonb not null default '[]',
  total_distance_m double precision not null default 0,
  total_walk_s double precision not null default 0,
  total_s double precision not null default 0,
  preferences jsonb not null,
  explanation text,
  method text,
  metrics jsonb not null default '{}',
  error text,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create index routes_crawl on routes (crawl_id, created_at desc);
alter table crawls add constraint crawls_approved_route foreign key (approved_route_id) references routes(id) on delete set null;

create table route_legs (
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null references routes(id) on delete cascade,
  seq int not null,
  from_stop_id uuid,
  to_stop_id uuid not null,
  distance_m double precision not null,
  walk_s double precision not null,
  geometry jsonb not null default '[]'
);
create index route_legs_route on route_legs (route_id, seq);

create table memberships (
  crawl_id uuid not null references crawls(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null default 'participant' check (role in ('organizer','co_host','participant')),
  crew_role text check (crew_role in ('designated_driver','navigator','photographer')),
  rsvp text not null default 'going' check (rsvp in ('going','maybe','declined')),
  location_sharing boolean not null default false,
  joined_at timestamptz not null default now(),
  primary key (crawl_id, user_id)
);
create index memberships_user on memberships (user_id);

create table invites (
  id uuid primary key default gen_random_uuid(),
  crawl_id uuid not null references crawls(id) on delete cascade,
  token text not null unique,
  created_by uuid not null references users(id),
  max_uses int,
  uses int not null default 0,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table invite_targets (
  crawl_id uuid not null references crawls(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  invited_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  primary key (crawl_id, user_id)
);

create table live_state (
  crawl_id uuid primary key references crawls(id) on delete cascade,
  current_stop_id uuid,
  leader_user_id uuid references users(id),
  last_lat double precision,
  last_lng double precision,
  last_position_at timestamptz,
  near_stop_id uuid,
  near_since timestamptz,
  away_since timestamptz,
  schedule_drift_s double precision not null default 0,
  pace_factor double precision not null default 1,
  special_states jsonb not null default '{}',
  simulating boolean not null default false,
  updated_at timestamptz not null default now()
);

create table position_log (
  crawl_id uuid not null references crawls(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  lat double precision not null,
  lng double precision not null,
  accuracy_m double precision,
  at timestamptz not null
);
create index position_log_crawl on position_log (crawl_id, at);

create table special_alerts (
  id uuid primary key default gen_random_uuid(),
  crawl_id uuid not null references crawls(id) on delete cascade,
  stop_id uuid not null,
  special_id uuid not null,
  kind text not null check (kind in ('highlight','at_risk','missed')),
  sent_at timestamptz not null default now(),
  unique (crawl_id, special_id, kind)
);

create table photos (
  id uuid primary key default gen_random_uuid(),
  crawl_id uuid not null references crawls(id) on delete cascade,
  uploader_id uuid not null references users(id),
  stop_id uuid references crawl_stops(id) on delete set null,
  storage_key text not null,
  thumb_key text,
  medium_key text,
  width int,
  height int,
  taken_at timestamptz,
  status text not null default 'pending' check (status in ('pending','ready','hidden')),
  hidden_reason text,
  created_at timestamptz not null default now()
);
create index photos_crawl on photos (crawl_id, created_at desc);

create table photo_reports (
  id uuid primary key default gen_random_uuid(),
  photo_id uuid not null references photos(id) on delete cascade,
  reporter_id uuid not null references users(id),
  reason text not null,
  created_at timestamptz not null default now(),
  unique (photo_id, reporter_id)
);

create table messages (
  id uuid primary key default gen_random_uuid(),
  crawl_id uuid not null references crawls(id) on delete cascade,
  user_id uuid references users(id),
  body text not null,
  kind text not null default 'text' check (kind in ('text','system')),
  created_at timestamptz not null default now()
);
create index messages_crawl on messages (crawl_id, created_at desc);

create table check_ins (
  id uuid primary key default gen_random_uuid(),
  crawl_id uuid not null references crawls(id) on delete cascade,
  stop_id uuid not null references crawl_stops(id) on delete cascade,
  venue_id uuid not null references venues(id),
  user_id uuid not null references users(id) on delete cascade,
  checked_in_at timestamptz not null default now(),
  unique (crawl_id, stop_id, user_id)
);
create index check_ins_user on check_ins (user_id, checked_in_at desc);

create table notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  crawl_id uuid references crawls(id) on delete cascade,
  kind text not null,
  title text not null,
  body text not null,
  data jsonb not null default '{}',
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_user on notifications (user_id, created_at desc);

create table routing_cache (
  key text primary key,
  value jsonb not null,
  created_at timestamptz not null default now()
);
