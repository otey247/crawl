import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import { config } from '../config.js';

/**
 * Object storage behind presigned URLs. The local driver mimics S3/Azure Blob semantics:
 * PUT to a short-lived signed URL, GET through signed URLs that expire after an hour,
 * and no public URLs. Swap `LocalStorage` for an S3/Blob implementation in production.
 */
export interface ObjectStorage {
  presignPut(key: string, contentType: string, ttlS?: number): string;
  presignGet(key: string, ttlS?: number): string;
  put(key: string, body: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  size(key: string): Promise<number | null>;
  remove(key: string): Promise<void>;
  verify(op: 'put' | 'get', key: string, expires: number, sig: string, contentType?: string): boolean;
}

function sign(payload: string) {
  return createHmac('sha256', config.jwtSecret).update(payload).digest('base64url');
}

class LocalStorage implements ObjectStorage {
  private path(key: string) {
    const p = normalize(join(config.storage.localDir, key));
    if (!p.startsWith(normalize(config.storage.localDir))) throw new Error('bad key');
    return p;
  }
  presignPut(key: string, contentType: string, ttlS = config.storage.uploadUrlTtlS) {
    const expires = Math.floor(Date.now() / 1000) + ttlS;
    const sig = sign(`put\n${key}\n${expires}\n${contentType}`);
    return `${config.apiUrl}/v1/storage/${encodeURIComponent(key)}?expires=${expires}&sig=${sig}&ct=${encodeURIComponent(contentType)}`;
  }
  presignGet(key: string, ttlS = config.storage.signedUrlTtlS) {
    // Round expiry to the TTL bucket so URLs are cache-friendly within a window.
    const expires = Math.ceil(Date.now() / 1000 / 600) * 600 + ttlS;
    const sig = sign(`get\n${key}\n${expires}\n`);
    return `${config.apiUrl}/v1/storage/${encodeURIComponent(key)}?expires=${expires}&sig=${sig}`;
  }
  verify(op: 'put' | 'get', key: string, expires: number, sig: string, contentType = '') {
    if (!Number.isFinite(expires) || expires < Date.now() / 1000) return false;
    const expected = Buffer.from(sign(`${op}\n${key}\n${expires}\n${op === 'put' ? contentType : ''}`));
    const given = Buffer.from(sig);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }
  async put(key: string, body: Buffer) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body);
  }
  get(key: string) {
    return readFile(this.path(key));
  }
  async size(key: string) {
    try {
      return (await stat(this.path(key))).size;
    } catch {
      return null;
    }
  }
  async remove(key: string) {
    await rm(this.path(key), { force: true });
  }
}

export const storage: ObjectStorage = new LocalStorage();
