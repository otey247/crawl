import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Plus, Users } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import type { CrawlSummaryDTO } from '@crawl/core';
import { CrewBadge, VenueImage } from '../components/domain';
import { Button, Empty, PageSpinner } from '../components/ui';
import { api } from '../lib/api';
import { fmtWhen } from '../lib/format';

export function MyCrawls() {
  const nav = useNavigate();
  const crawls = useQuery({ queryKey: ['my-crawls'], queryFn: api.myCrawls });
  if (crawls.isLoading) return <PageSpinner />;
  const list = crawls.data ?? [];
  const sections: [string, CrawlSummaryDTO[]][] = [
    ['Live now', list.filter((c) => c.status === 'live')],
    ['Upcoming', list.filter((c) => c.status === 'planned' || c.status === 'draft')],
    ['Past', list.filter((c) => c.status === 'ended')],
  ];
  return (
    <div className="px-4" style={{ paddingTop: 'max(20px, env(safe-area-inset-top))' }}>
      <div className="flex items-center justify-between">
        <h1 className="font-display text-[34px] font-bold">My Crawls</h1>
        <Button size="sm" onClick={() => nav('/crawls/new')}>
          <Plus className="size-4" /> New
        </Button>
      </div>
      {list.length === 0 ? (
        <Empty icon={<Users className="size-6" />} title="No crawls yet" body="Create one or join a public crawl from Explore." action={<Button onClick={() => nav('/')}>Explore Soulard</Button>} />
      ) : (
        sections.map(([title, items]) =>
          items.length ? (
            <section key={title} className="mt-6">
              <h2 className="mb-3 text-[13px] font-bold uppercase tracking-[0.14em] text-dim">{title}</h2>
              <div className="space-y-3">
                {items.map((c) => (
                  <CrawlRow key={c.id} crawl={c} />
                ))}
              </div>
            </section>
          ) : null,
        )
      )}
    </div>
  );
}

export function CrawlRow({ crawl, right }: { crawl: CrawlSummaryDTO; right?: React.ReactNode }) {
  const m = crawl.myMembership;
  return (
    <Link to={`/crawls/${crawl.id}`} className="flex items-center gap-3 rounded-3xl border border-line bg-surface p-2.5 pr-4 hover:border-line-strong">
      <VenueImage name={crawl.cover?.venueName ?? crawl.title} category={crawl.cover?.category ?? 'pub'} imageUrl={crawl.cover?.imageUrl} size="thumb" compact className="size-[76px] shrink-0 rounded-2xl" />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wider text-dim">
          {crawl.status === 'live' ? <span className="size-2 rounded-full bg-alert" /> : null}
          {crawl.status === 'live' ? 'Live' : crawl.status === 'draft' ? 'Draft' : fmtWhen(crawl.startAt, crawl.timezone)}
        </p>
        <p className="truncate font-display text-[19px] font-semibold leading-tight">{crawl.title}</p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[13px] text-dim">
          <span>
            {crawl.stopCount} stops · {crawl.goingCount} going
          </span>
          {m?.role === 'organizer' ? <span className="font-semibold text-fg">· Organizer</span> : m?.role === 'co_host' ? <span className="font-semibold text-fg">· Co-host</span> : null}
          {m?.crewRole ? <CrewBadge role={m.crewRole} /> : null}
        </div>
      </div>
      {right ?? <ChevronRight className="size-5 shrink-0 text-dim" />}
    </Link>
  );
}
