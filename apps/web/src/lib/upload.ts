import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';

/**
 * Client side of the photo pipeline:
 *   resize to a 2048 px long edge → re-encode JPEG @ 80% (drops EXIF/GPS) →
 *   presigned PUT with progress → :complete. Failed uploads retry with backoff and
 *   wait for the browser to come back online.
 */

export interface UploadItem {
  id: string;
  name: string;
  preview: string;
  progress: number;
  status: 'queued' | 'preparing' | 'uploading' | 'processing' | 'done' | 'failed';
  error?: string;
  attempts: number;
}

const MAX_EDGE = 2048;

async function prepare(file: File): Promise<{ blob: Blob; width: number; height: number }> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Could not encode image'))), 'image/jpeg', 0.8));
  return { blob, width, height };
}

function put(url: string, blob: Blob, onProgress: (p: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('content-type', 'image/jpeg');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(`Upload failed (${xhr.status})`)));
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.send(blob);
  });
}

export function usePhotoUploader(crawlId: string) {
  const [items, setItemsState] = useState<UploadItem[]>([]);
  const itemsRef = useRef<UploadItem[]>([]);
  const setItems = (fn: (xs: UploadItem[]) => UploadItem[]) =>
    setItemsState((xs) => {
      const next = fn(xs);
      itemsRef.current = next;
      return next;
    });
  const files = useRef(new Map<string, File>());
  const running = useRef(false);

  const update = (id: string, patch: Partial<UploadItem>) => setItems((xs) => xs.map((x) => (x.id === id ? { ...x, ...patch } : x)));

  const pump = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      while (navigator.onLine) {
        const next = itemsRef.current.find((x) => x.status === 'queued');
        if (!next) break;
        const file = files.current.get(next.id)!;
        try {
          next.status = 'preparing';
          update(next.id, { status: 'preparing' });
          const { blob, width, height } = await prepare(file);
          const { photoId, uploadUrl } = await api.uploadUrl(crawlId, { contentType: 'image/jpeg', width, height, takenAt: new Date(file.lastModified).toISOString() });
          update(next.id, { status: 'uploading' });
          await put(uploadUrl, blob, (p) => update(next.id, { progress: p }));
          update(next.id, { status: 'processing', progress: 1 });
          await api.completePhoto(crawlId, photoId);
          update(next.id, { status: 'done' });
          files.current.delete(next.id);
          setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== next.id)), 2500);
        } catch (err) {
          const attempts = next.attempts + 1;
          const msg = err instanceof Error ? err.message : 'Upload failed';
          if (attempts >= 4) update(next.id, { status: 'failed', error: msg, attempts });
          else {
            update(next.id, { status: 'failed', error: `${msg} — retrying`, attempts });
            setTimeout(() => (update(next.id, { status: 'queued', progress: 0 }), pump()), 2000 * 2 ** attempts);
          }
        }
      }
    } finally {
      running.current = false;
    }
  }, [crawlId]);

  useEffect(() => {
    const online = () => pump();
    window.addEventListener('online', online);
    return () => window.removeEventListener('online', online);
  }, [pump]);

  const add = useCallback(
    (list: FileList | File[]) => {
      const next: UploadItem[] = [];
      for (const f of Array.from(list)) {
        if (!f.type.startsWith('image/')) continue;
        const id = crypto.randomUUID();
        files.current.set(id, f);
        next.push({ id, name: f.name, preview: URL.createObjectURL(f), progress: 0, status: 'queued', attempts: 0 });
      }
      setItems((xs) => [...xs, ...next]);
      setTimeout(pump, 0);
    },
    [pump],
  );

  const retry = (id: string) => {
    update(id, { status: 'queued', attempts: 0, error: undefined, progress: 0 });
    setTimeout(pump, 0);
  };
  const dismiss = (id: string) => {
    files.current.delete(id);
    setItems((xs) => xs.filter((x) => x.id !== id));
  };

  return { items, add, retry, dismiss };
}
