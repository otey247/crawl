import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Car, Minus, Plus, UserMinus, Users } from 'lucide-react';
import { useState } from 'react';
import type { CrawlDetailDTO, RideBoardDTO, RideOfferDTO } from '@crawl/core';
import { CrewBadge } from '../components/domain';
import { Avatar, Button, Segmented, errorMessage, inputCls, useToast } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';

/**
 * Ride board: Designated Drivers offer seats toward an area, everyone else asks for a ride home
 * (neighborhood, not an address) and takes a seat. Lives at the top of the People tab.
 */
export function RideBoard({ crawl }: { crawl: CrawlDetailDTO }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { me } = useAuth();
  const key = ['rides', crawl.id];
  const board = useQuery({ queryKey: key, queryFn: () => api.rides(crawl.id), enabled: crawl.permissions.isMember });
  const set = (b: RideBoardDTO) => qc.setQueryData(key, b);
  const onError = (e: unknown) => toast({ title: errorMessage(e) });
  const seat = useMutation({ mutationFn: (v: { offerId: string; userId: string }) => api.seatRider(crawl.id, v.offerId, v.userId), onSuccess: set, onError });
  const unseat = useMutation({ mutationFn: (v: { offerId: string; userId: string }) => api.unseatRider(crawl.id, v.offerId, v.userId), onSuccess: set, onError });
  const cancelRequest = useMutation({ mutationFn: () => api.cancelRequest(crawl.id), onSuccess: set, onError });

  const b = board.data;
  if (!b) return null;
  const drivers = crawl.members.filter((m) => m.crewRole === 'designated_driver');
  const mine = b.mine;
  const myRide = mine?.offerId ? b.offers.find((o) => o.id === mine.offerId) : null;

  return (
    <section aria-label="Ride board" className="rounded-3xl border border-line bg-surface p-4">
      <div className="flex items-center gap-2">
        <Car className="size-5 text-amber" />
        <h3 className="flex-1 font-display text-[20px] font-semibold">Rides home</h3>
        <span className="text-[13px] text-dim">
          {b.offers.reduce((n, o) => n + o.seatsLeft, 0)} seats open · {b.waiting.length} waiting
        </span>
      </div>

      {b.canOffer ? <DriverPanel crawl={crawl} board={b} onBoard={set} /> : null}

      {!b.canOffer ? (
        mine ? (
          <div className="mt-3 rounded-2xl bg-raised p-4">
            {myRide ? (
              <>
                <p className="text-[16px] font-semibold">Riding with {myRide.driver.displayName}</p>
                <p className="text-[14px] text-dim">
                  To {mine.destination}
                  {myRide.leavingNote ? ` · ${myRide.leavingNote}` : ''}
                </p>
                <Button size="sm" variant="secondary" className="mt-3" loading={unseat.isPending} onClick={() => unseat.mutate({ offerId: myRide.id, userId: me!.id })}>
                  <UserMinus className="size-4" /> Leave this ride
                </Button>
              </>
            ) : (
              <>
                <p className="text-[16px] font-semibold">Waiting for a ride to {mine.destination}</p>
                <p className="text-[14px] text-dim">
                  {mine.partySize > 1 ? `${mine.partySize} people · ` : ''}Drivers have been notified. Grab an open seat below when one fits.
                </p>
                <Button size="sm" variant="ghost" className="mt-2 -ml-3 text-dim" loading={cancelRequest.isPending} onClick={() => cancelRequest.mutate()}>
                  I don’t need a ride
                </Button>
              </>
            )}
          </div>
        ) : (
          <RequestForm crawlId={crawl.id} onBoard={set} />
        )
      ) : null}

      <div className="mt-4 space-y-2">
        {b.offers
          .filter((o) => o.id !== b.myOffer?.id)
          .map((o) => (
            <OfferRow
              key={o.id}
              offer={o}
              canJoin={!!mine && !mine.offerId && o.seatsLeft >= mine.partySize}
              joining={seat.isPending}
              onJoin={() => seat.mutate({ offerId: o.id, userId: me!.id })}
            />
          ))}
        {b.offers.length === 0 ? (
          <p className="text-[14px] text-dim">
            {drivers.length
              ? `${drivers.map((d) => d.user.displayName.split(' ')[0]).join(' and ')} ${drivers.length > 1 ? 'are' : 'is'} driving but hasn’t posted seats yet.`
              : 'No Designated Driver yet. The organizer can assign one below, or use Safety for cabs and ride apps.'}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function OfferRow({ offer, canJoin, joining, onJoin }: { offer: RideOfferDTO; canJoin: boolean; joining: boolean; onJoin: () => void }) {
  return (
    <div className="flex items-center gap-3 rounded-2xl bg-raised p-3">
      <Avatar user={offer.driver} size={40} />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-[15px] font-semibold">
          {offer.driver.displayName}
          <CrewBadge role="designated_driver" />
        </p>
        <p className="truncate text-[13px] text-dim">
          Toward {offer.area}
          {offer.leavingNote ? ` · ${offer.leavingNote}` : ''} · {offer.seatsLeft} of {offer.seats} seats left
        </p>
      </div>
      {canJoin ? (
        <Button size="sm" loading={joining} onClick={onJoin}>
          Take a seat
        </Button>
      ) : null}
    </div>
  );
}

function RequestForm({ crawlId, onBoard }: { crawlId: string; onBoard: (b: RideBoardDTO) => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [destination, setDestination] = useState('');
  const [party, setParty] = useState('1');
  const m = useMutation({
    mutationFn: () => api.requestRide(crawlId, { destination, partySize: Number(party) }),
    onSuccess: (b) => {
      onBoard(b);
      toast({ title: 'Ride request posted', body: 'Designated Drivers on this crawl were notified.' });
    },
    onError: (e) => toast({ title: errorMessage(e) }),
  });
  if (!open)
    return (
      <Button variant="secondary" className="mt-3 w-full" onClick={() => setOpen(true)}>
        Need a ride home?
      </Button>
    );
  return (
    <form
      className="mt-3 space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        m.mutate();
      }}
    >
      <label className="block">
        <span className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-dim">Heading to</span>
        <input className={inputCls} required minLength={2} maxLength={60} value={destination} onChange={(e) => setDestination(e.target.value)} placeholder="Neighborhood or cross streets" />
        <span className="mt-1 block text-[12px] text-faint">Everyone on the crawl can see this, so skip your exact address.</span>
      </label>
      <div>
        <span className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-dim">How many people</span>
        <Segmented size="sm" value={party} onChange={setParty} options={['1', '2', '3', '4'].map((v) => ({ value: v, label: v }))} />
      </div>
      <Button type="submit" className="w-full" loading={m.isPending}>
        Ask for a ride
      </Button>
    </form>
  );
}

function DriverPanel({ crawl, board, onBoard }: { crawl: CrawlDetailDTO; board: RideBoardDTO; onBoard: (b: RideBoardDTO) => void }) {
  const toast = useToast();
  const offer = board.myOffer;
  const [editing, setEditing] = useState(!offer);
  const [seats, setSeats] = useState(offer?.seats ?? 3);
  const [area, setArea] = useState(offer?.area ?? '');
  const [note, setNote] = useState(offer?.leavingNote ?? '');
  const onError = (e: unknown) => toast({ title: errorMessage(e) });
  const save = useMutation({ mutationFn: () => api.offerRide(crawl.id, { seats, area, leavingNote: note || null }), onSuccess: (b) => (onBoard(b), setEditing(false)), onError });
  const cancel = useMutation({ mutationFn: () => api.cancelOffer(crawl.id), onSuccess: (b) => (onBoard(b), setEditing(true)), onError });
  const seat = useMutation({ mutationFn: (userId: string) => api.seatRider(crawl.id, offer!.id, userId), onSuccess: onBoard, onError });
  const unseat = useMutation({ mutationFn: (userId: string) => api.unseatRider(crawl.id, offer!.id, userId), onSuccess: onBoard, onError });

  if (editing)
    return (
      <form
        className="mt-3 space-y-3 rounded-2xl bg-raised p-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <p className="text-[15px] font-semibold">You’re a Designated Driver. Offer seats home?</p>
        <div className="flex items-center gap-3">
          <span className="flex-1 text-[14px] text-dim">Seats</span>
          <div className="flex items-center gap-1 rounded-full border border-line p-1">
            <button type="button" aria-label="Fewer seats" className="flex size-8 items-center justify-center rounded-full hover:bg-surface" onClick={() => setSeats((s) => Math.max(1, s - 1))}>
              <Minus className="size-4" />
            </button>
            <span className="w-8 text-center text-[15px] font-semibold tabular">{seats}</span>
            <button type="button" aria-label="More seats" className="flex size-8 items-center justify-center rounded-full hover:bg-surface" onClick={() => setSeats((s) => Math.min(8, s + 1))}>
              <Plus className="size-4" />
            </button>
          </div>
        </div>
        <input className={inputCls} required minLength={2} maxLength={60} value={area} onChange={(e) => setArea(e.target.value)} placeholder="Heading toward (e.g. Tower Grove)" />
        <input className={inputCls} maxLength={80} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Leaving when? (optional)" />
        <div className="flex gap-2">
          <Button type="submit" className="flex-1" loading={save.isPending}>
            {offer ? 'Save' : 'Offer seats'}
          </Button>
          {offer ? (
            <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          ) : null}
        </div>
      </form>
    );

  return (
    <div className="mt-3 rounded-2xl bg-raised p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[16px] font-semibold">
            Your car · {offer!.seatsLeft} of {offer!.seats} seats left
          </p>
          <p className="text-[14px] text-dim">
            Toward {offer!.area}
            {offer!.leavingNote ? ` · ${offer!.leavingNote}` : ''}
          </p>
        </div>
        <button className="text-[14px] font-semibold text-amber" onClick={() => setEditing(true)}>
          Edit
        </button>
      </div>
      {offer!.riders.length ? (
        <ul className="mt-3 space-y-2">
          {offer!.riders.map((r) => (
            <li key={r.user.id} className="flex items-center gap-3">
              <Avatar user={r.user} size={32} />
              <span className="min-w-0 flex-1 truncate text-[14px]">
                <span className="font-semibold">{r.user.displayName}</span> <span className="text-dim">to {r.destination}{r.partySize > 1 ? ` · ${r.partySize}` : ''}</span>
              </span>
              <button aria-label={`Remove ${r.user.displayName}`} className="p-1.5 text-dim hover:text-fg" onClick={() => unseat.mutate(r.user.id)}>
                <UserMinus className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {board.waiting.length ? (
        <div className="mt-4 border-t border-line pt-3">
          <p className="flex items-center gap-1.5 text-[13px] font-semibold text-dim">
            <Users className="size-4" /> Waiting for a ride
          </p>
          <ul className="mt-2 space-y-2">
            {board.waiting.map((w) => (
              <li key={w.user.id} className="flex items-center gap-3">
                <Avatar user={w.user} size={32} />
                <span className="min-w-0 flex-1 truncate text-[14px]">
                  <span className="font-semibold">{w.user.displayName}</span> <span className="text-dim">to {w.destination}{w.partySize > 1 ? ` · ${w.partySize}` : ''}</span>
                </span>
                <Button size="sm" disabled={offer!.seatsLeft < w.partySize} loading={seat.isPending && seat.variables === w.user.id} onClick={() => seat.mutate(w.user.id)}>
                  Seat
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <Button size="sm" variant="ghost" className="mt-3 -ml-3 text-dim" loading={cancel.isPending} onClick={() => confirm('Stop offering rides? Your riders go back on the board.') && cancel.mutate()}>
        Stop offering rides
      </Button>
    </div>
  );
}
