-- @requires postgis
-- Applied only when the PostGIS extension is available (e.g. the postgis/postgis image).
create extension if not exists postgis;
alter table venues add column if not exists location geography(Point, 4326)
  generated always as (ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography) stored;
create index if not exists venues_location on venues using gist (location);
