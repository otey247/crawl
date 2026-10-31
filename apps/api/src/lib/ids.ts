import { createHash, randomBytes } from 'node:crypto';

/** 128-bit URL-safe token. */
export const token128 = () => randomBytes(16).toString('base64url');
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/** Route-param regexes so `/:id::verb` (Google-style custom methods) parses unambiguously. */
export const UUID_PARAM = '([0-9a-fA-F-]{36})';
export const TOKEN_PARAM = '([A-Za-z0-9_-]{10,64})';
