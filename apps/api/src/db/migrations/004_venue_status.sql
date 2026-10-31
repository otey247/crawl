-- Venues reported closed stay in the table (OSM still lists them) but drop out of discovery.
alter table venues add column status text not null default 'open' check (status in ('open', 'reported_closed', 'closed'));
alter table venues add column status_note text;
