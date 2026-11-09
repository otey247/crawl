import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Download, EyeOff, Flag, ImagePlus, Images, RotateCw, Star, Trash2, X } from 'lucide-react';
import { DateTime } from 'luxon';
import { useEffect, useRef, useState } from 'react';
import type { CrawlDetailDTO, PhotoDTO } from '@crawl/core';
import { Avatar, Button, Empty, Segmented, Spinner, errorMessage, useToast } from '../components/ui';
import { api, downloadWithAuth } from '../lib/api';
import { useAuth } from '../lib/auth';
import { usePhotoUploader } from '../lib/upload';

/** Shared album for one crawl: realtime masonry grid, per-stop grouping, swipe viewer, moderation. */
export function PhotoGallery({ crawl }: { crawl: CrawlDetailDTO }) {
  const { me } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const uploader = usePhotoUploader(crawl.id);
  const [grouping, setGrouping] = useState<'recent' | 'stop'>('recent');
  // The viewer swipes through whichever list it was opened from (picks strip or the album).
  const [viewer, setViewer] = useState<{ list: 'picks' | 'album'; index: number } | null>(null);
  const picks = useQuery({ queryKey: ['photo-picks', crawl.id], queryFn: () => api.photoPicks(crawl.id), enabled: crawl.permissions.isMember });
  const canPick = crawl.permissions.canModeratePhotos || crawl.myMembership?.crewRole === 'photographer';
  const [dragging, setDragging] = useState(false);

  const photos = useInfiniteQuery({
    queryKey: ['photos', crawl.id],
    queryFn: ({ pageParam }) => api.photos(crawl.id, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const all = photos.data?.pages.flatMap((p) => p.items) ?? [];
  const canUpload = crawl.permissions.isMember && crawl.status !== 'draft';
  const stopName = (id: string | null) => crawl.stops.find((s) => s.id === id)?.venue.name ?? 'Between stops';

  const groups: { title: string; items: PhotoDTO[] }[] =
    grouping === 'recent'
      ? [{ title: '', items: all }]
      : [...crawl.stops.map((s) => s.id), null]
          .map((sid) => ({ title: stopName(sid), items: all.filter((p) => p.stopId === sid) }))
          .filter((g) => g.items.length);

  const flat = groups.flatMap((g) => g.items);

  return (
    <div
      onDragOver={(e) => {
        if (!canUpload) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (canUpload && e.dataTransfer.files.length) uploader.add(e.dataTransfer.files);
      }}
      className={dragging ? 'rounded-3xl outline-2 outline-dashed outline-amber' : ''}
    >
      <div className="flex items-center gap-2">
        {canUpload ? (
          <Button onClick={() => input.current?.click()} className="flex-1">
            <ImagePlus className="size-5" /> Add photos
          </Button>
        ) : null}
        {crawl.status === 'ended' && all.length ? (
          <Button
            variant="secondary"
            onClick={() => downloadWithAuth(api.archiveUrl(crawl.id), `${crawl.title}-photos.zip`).catch((e) => toast({ title: errorMessage(e) }))}
          >
            <Download className="size-4" /> Album .zip
          </Button>
        ) : null}
        <input
          ref={input}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) uploader.add(e.target.files);
            e.target.value = '';
          }}
        />
      </div>
      <p className="mt-2 text-[12px] text-faint">Photos are shared with crawl members only. Location data is removed before upload. Ask before posting people who’d rather not be in photos.</p>

      {uploader.items.length ? (
        <div className="mt-4 space-y-2" aria-label="Uploads">
          {uploader.items.map((u) => (
            <div key={u.id} className="flex items-center gap-3 rounded-2xl bg-raised p-2 pr-3">
              <img src={u.preview} alt="" className="size-12 rounded-xl object-cover" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] font-medium">{u.name}</p>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-line">
                  <div className="h-full rounded-full bg-amber transition-all" style={{ width: `${Math.round((u.status === 'done' || u.status === 'processing' ? 1 : u.progress) * 100)}%` }} />
                </div>
                <p className="mt-1 text-[12px] text-dim">
                  {u.status === 'failed' ? u.error : u.status === 'processing' ? 'Processing…' : u.status === 'done' ? 'Added to album' : u.status === 'queued' ? (navigator.onLine ? 'Queued' : 'Waiting for connection') : u.status === 'preparing' ? 'Preparing…' : 'Uploading…'}
                </p>
              </div>
              {u.status === 'failed' ? (
                <>
                  <button aria-label="Retry" className="p-1.5" onClick={() => uploader.retry(u.id)}>
                    <RotateCw className="size-4" />
                  </button>
                  <button aria-label="Dismiss" className="p-1.5 text-dim" onClick={() => uploader.dismiss(u.id)}>
                    <X className="size-4" />
                  </button>
                </>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {picks.data?.length ? (
        <section className="mt-5" aria-label="Photographer's picks">
          <h3 className="mb-2 flex items-center gap-1.5 text-[15px] font-semibold">
            <Star className="size-4 fill-amber text-amber" /> Photographer’s picks
          </h3>
          <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4">
            {picks.data.map((p, i) => (
              <button key={p.id} onClick={() => setViewer({ list: 'picks', index: i })} className="relative size-28 shrink-0 overflow-hidden rounded-2xl bg-raised" aria-label={`Pick by ${p.uploader.displayName}`}>
                <img src={p.thumbUrl} alt="" loading="lazy" className="size-full object-cover" />
                {p.featured ? <Star className="absolute right-1.5 top-1.5 size-4 fill-amber text-amber drop-shadow" /> : null}
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {all.length ? (
        <div className="mt-5">
          <Segmented size="sm" value={grouping} onChange={setGrouping} options={[{ value: 'recent', label: 'Newest' }, { value: 'stop', label: 'By bar' }]} />
        </div>
      ) : null}

      {photos.isLoading ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : all.length === 0 ? (
        <Empty icon={<Images className="size-6" />} title="No photos yet" body={canUpload ? 'Be the first to add one. Everyone on the crawl sees them instantly.' : 'Photos show up here once the crawl gets going.'} />
      ) : (
        groups.map((g) => (
          <section key={g.title || 'all'} className="mt-4">
            {g.title ? <h3 className="mb-2 text-[15px] font-semibold">{g.title}</h3> : null}
            <div className="columns-2 gap-2 [column-fill:_balance]">
              {g.items.map((p) => (
                <button key={p.id} className="relative mb-2 block w-full overflow-hidden rounded-2xl bg-raised" onClick={() => setViewer({ list: 'album', index: flat.indexOf(p) })} aria-label={`Photo by ${p.uploader.displayName}`}>
                  {p.featured ? <Star className="absolute right-2 top-2 z-10 size-4 fill-amber text-amber drop-shadow" aria-label="Photographer's pick" /> : null}
                  <img src={p.thumbUrl} alt="" loading="lazy" className="block w-full" style={p.width && p.height ? { aspectRatio: `${p.width}/${p.height}` } : undefined} />
                  {p.status === 'hidden' ? (
                    <span className="absolute inset-0 flex items-center justify-center bg-black/70 text-[13px] font-semibold">
                      <EyeOff className="mr-1.5 size-4" /> Hidden
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          </section>
        ))
      )}
      {photos.hasNextPage ? (
        <Button variant="secondary" className="mt-2 w-full" loading={photos.isFetchingNextPage} onClick={() => photos.fetchNextPage()}>
          Load more
        </Button>
      ) : null}

      {viewer !== null && (viewer.list === 'picks' ? picks.data ?? [] : flat)[viewer.index] ? (
        <Viewer
          photos={viewer.list === 'picks' ? picks.data ?? [] : flat}
          index={viewer.index}
          onIndex={(index) => setViewer({ ...viewer, index })}
          canPick={canPick}
          onClose={() => setViewer(null)}
          crawl={crawl}
          meId={me?.id}
          stopName={stopName}
          onChanged={() => {
            qc.invalidateQueries({ queryKey: ['photos', crawl.id] });
            qc.invalidateQueries({ queryKey: ['photo-picks', crawl.id] });
          }}
        />
      ) : null}
    </div>
  );
}

function Viewer({
  photos,
  index,
  onIndex,
  onClose,
  crawl,
  meId,
  stopName,
  onChanged,
  canPick,
}: {
  photos: PhotoDTO[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  crawl: CrawlDetailDTO;
  meId?: string;
  stopName: (id: string | null) => string;
  onChanged: () => void;
  canPick: boolean;
}) {
  const toast = useToast();
  const p = photos[index];
  const startX = useRef<number | null>(null);
  const [dx, setDx] = useState(0);
  const go = (d: number) => {
    const n = index + d;
    if (n >= 0 && n < photos.length) onIndex(n);
  };
  useEffect(() => {
    const k = (e: KeyboardEvent) => (e.key === 'ArrowRight' ? go(1) : e.key === 'ArrowLeft' ? go(-1) : e.key === 'Escape' ? onClose() : null);
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });
  const pick = useMutation({
    mutationFn: (featured: boolean) => api.featurePhoto(crawl.id, p.id, featured),
    onSuccess: (dto) => (onChanged(), toast({ title: dto.featured ? 'Added to picks' : 'Removed from picks' })),
    onError: (e) => toast({ title: errorMessage(e) }),
  });
  const del = useMutation({ mutationFn: () => api.deletePhoto(crawl.id, p.id), onSuccess: () => (onChanged(), photos.length > 1 ? onIndex(Math.max(0, index - 1)) : onClose()), onError: (e) => toast({ title: errorMessage(e) }) });
  const hide = useMutation({ mutationFn: (hidden: boolean) => api.setPhotoHidden(crawl.id, p.id, hidden), onSuccess: () => (onChanged(), toast({ title: 'Updated' })), onError: (e) => toast({ title: errorMessage(e) }) });
  const report = useMutation({ mutationFn: () => api.reportPhoto(p.id, 'Inappropriate'), onSuccess: (r) => toast({ title: 'Reported', body: r.hidden ? 'This photo is hidden pending review.' : 'Thanks — the organizer can review it.' }), onError: (e) => toast({ title: errorMessage(e) }) });
  const mine = p.uploader.id === meId;

  return (
    <div className="fixed inset-0 z-[55] flex flex-col bg-black" role="dialog" aria-modal aria-label="Photo viewer">
      <div className="flex items-center gap-3 p-4" style={{ paddingTop: 'max(16px, env(safe-area-inset-top))' }}>
        <button aria-label="Close" onClick={onClose} className="flex size-11 items-center justify-center rounded-full bg-white/10">
          <X className="size-5" />
        </button>
        <Avatar user={p.uploader} size={34} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold">{p.uploader.displayName}</p>
          <p className="truncate text-[12px] text-dim">
            {stopName(p.stopId)} · {DateTime.fromISO(p.takenAt ?? p.createdAt, { zone: crawl.timezone }).toFormat('h:mm a')}
          </p>
        </div>
        <span className="text-[13px] text-dim tabular">
          {index + 1}/{photos.length}
        </span>
      </div>
      <div
        className="relative flex flex-1 touch-pan-y items-center justify-center overflow-hidden"
        onPointerDown={(e) => (startX.current = e.clientX)}
        onPointerMove={(e) => startX.current !== null && setDx(e.clientX - startX.current)}
        onPointerUp={() => {
          if (Math.abs(dx) > 60) go(dx < 0 ? 1 : -1);
          startX.current = null;
          setDx(0);
        }}
        onPointerCancel={() => ((startX.current = null), setDx(0))}
      >
        <img src={p.url} alt="" draggable={false} className="max-h-full max-w-full select-none object-contain transition-transform" style={{ transform: `translateX(${dx}px)` }} />
        {index > 0 ? (
          <button aria-label="Previous" onClick={() => go(-1)} className="absolute left-3 hidden size-11 items-center justify-center rounded-full bg-white/10 sm:flex">
            <ChevronLeft className="size-5" />
          </button>
        ) : null}
        {index < photos.length - 1 ? (
          <button aria-label="Next" onClick={() => go(1)} className="absolute right-3 hidden size-11 items-center justify-center rounded-full bg-white/10 sm:flex">
            <ChevronRight className="size-5" />
          </button>
        ) : null}
      </div>
      <div className="flex justify-center gap-2 p-4" style={{ paddingBottom: 'max(16px, env(safe-area-inset-bottom))' }}>
        {mine || crawl.permissions.canDelete ? (
          <Button variant="secondary" size="sm" loading={del.isPending} onClick={() => confirm('Delete this photo for everyone?') && del.mutate()}>
            <Trash2 className="size-4" /> Delete
          </Button>
        ) : null}
        {canPick && p.status === 'ready' ? (
          <Button variant={p.featured ? 'primary' : 'secondary'} size="sm" loading={pick.isPending} onClick={() => pick.mutate(!p.featured)}>
            <Star className={`size-4 ${p.featured ? 'fill-current' : ''}`} /> {p.featured ? 'Picked' : 'Pick'}
          </Button>
        ) : null}
        {crawl.permissions.canModeratePhotos ? (
          <Button variant="secondary" size="sm" loading={hide.isPending} onClick={() => hide.mutate(p.status !== 'hidden')}>
            <EyeOff className="size-4" /> {p.status === 'hidden' ? 'Unhide' : 'Hide'}
          </Button>
        ) : null}
        {!mine ? (
          <Button variant="secondary" size="sm" loading={report.isPending} onClick={() => report.mutate()}>
            <Flag className="size-4" /> Report
          </Button>
        ) : null}
      </div>
    </div>
  );
}
