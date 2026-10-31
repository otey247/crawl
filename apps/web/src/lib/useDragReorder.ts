import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

/**
 * Pointer-driven list reordering. Items swap live while dragging by a handle; the new order is
 * committed once on release. Moves are tracked on window (not the handle) because React moves the
 * dragged node when the order changes, which drops pointer capture. Handles also respond to
 * ArrowUp / ArrowDown for keyboard users.
 */
export function useDragReorder(ids: string[], onCommit: (order: string[]) => void) {
  const [draft, setDraft] = useState<string[] | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const items = useRef(new Map<string, HTMLElement>());
  const state = useRef<{ id: string; order: string[]; base: string[] } | null>(null);
  const commit = useRef(onCommit);
  commit.current = onCommit;

  useEffect(() => {
    if (!dragging) return;
    const move = (e: globalThis.PointerEvent) => {
      const s = state.current;
      if (!s) return;
      const others = s.order.filter((x) => x !== s.id);
      // Insert before the first item whose vertical midpoint is below the pointer.
      let index = others.length;
      for (let i = 0; i < others.length; i++) {
        const r = items.current.get(others[i])?.getBoundingClientRect();
        if (r && e.clientY < r.top + r.height / 2) {
          index = i;
          break;
        }
      }
      const next = [...others.slice(0, index), s.id, ...others.slice(index)];
      if (next.join() !== s.order.join()) {
        s.order = next;
        setDraft(next);
      }
    };
    const end = (cancelled: boolean) => () => {
      const s = state.current;
      state.current = null;
      setDragging(null);
      setDraft(null);
      if (s && !cancelled && s.order.join() !== s.base.join()) commit.current(s.order);
    };
    const up = end(false);
    const cancel = end(true);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
    };
  }, [dragging]);

  const register = (id: string) => (el: HTMLElement | null) => {
    if (el) items.current.set(id, el);
    else items.current.delete(id);
  };

  const handleProps = (id: string) => ({
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      e.preventDefault();
      state.current = { id, order: ids, base: ids };
      setDraft(ids);
      setDragging(id);
    },
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      const i = ids.indexOf(id);
      const d = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
      if (!d || i + d < 0 || i + d >= ids.length) return;
      e.preventDefault();
      const next = ids.slice();
      [next[i], next[i + d]] = [next[i + d], next[i]];
      commit.current(next);
    },
    style: { touchAction: 'none' as const, cursor: dragging === id ? 'grabbing' : 'grab' },
  });

  return { order: draft ?? ids, dragging, register, handleProps };
}
