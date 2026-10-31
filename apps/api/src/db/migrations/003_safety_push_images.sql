-- Home-safe check after a crawl, web push subscriptions, reminder de-duplication, image credits.
alter table memberships add column home_safe_at timestamptz;

create table push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_success_at timestamptz
);
create index push_subscriptions_user on push_subscriptions (user_id);

create table reminders_sent (
  crawl_id uuid not null references crawls(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  kind text not null,
  sent_at timestamptz not null default now(),
  primary key (crawl_id, user_id, kind)
);

alter table venues add column image_credit jsonb;
