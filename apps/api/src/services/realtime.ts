import type { Server } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '@crawl/core';

type IO = Server<ClientToServerEvents, ServerToClientEvents>;
type EventName = keyof ServerToClientEvents;
type Payload<E extends EventName> = Parameters<ServerToClientEvents[E]>[0];

let io: IO | null = null;

export const rooms = {
  crawl: (id: string) => `crawl:${id}`,
  hosts: (id: string) => `crawl:${id}:hosts`,
  user: (id: string) => `user:${id}`,
};

export function setIO(server: IO) {
  io = server;
}

export function emitToCrawl<E extends EventName>(crawlId: string, event: E, payload: Payload<E>) {
  (io?.to(rooms.crawl(crawlId)).emit as any)?.(event, payload);
}

/** Crawl members who are not organizer / co-host. */
export function emitToParticipants<E extends EventName>(crawlId: string, event: E, payload: Payload<E>) {
  (io?.to(rooms.crawl(crawlId)).except(rooms.hosts(crawlId)).emit as any)?.(event, payload);
}

export function emitToHosts<E extends EventName>(crawlId: string, event: E, payload: Payload<E>) {
  (io?.to(rooms.hosts(crawlId)).emit as any)?.(event, payload);
}

export function emitToUser<E extends EventName>(userId: string, event: E, payload: Payload<E>) {
  (io?.to(rooms.user(userId)).emit as any)?.(event, payload);
}

/** Keep socket rooms in sync after membership or role changes. */
export async function syncUserRooms(userId: string, crawlId: string, role: string | null) {
  if (!io) return;
  const sockets = io.in(rooms.user(userId));
  if (!role) {
    sockets.socketsLeave([rooms.crawl(crawlId), rooms.hosts(crawlId)]);
    return;
  }
  if (role === 'organizer' || role === 'co_host') sockets.socketsJoin(rooms.hosts(crawlId));
  else sockets.socketsLeave(rooms.hosts(crawlId));
}
