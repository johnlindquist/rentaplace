// The desk's request key, made in code from the request itself: guest, home, dates and number of guests.
// The model never chooses it, so the same request twice is the same key and places one hold.
import { createHash } from 'node:crypto';
/** @param {string} guest @param {{ slug: string, from: string, to: string, guests: number | string }} p */
export function requestKey(guest, p) { return 'desk-' + createHash('sha256').update([guest, p.slug, p.from, p.to, Number(p.guests)].join('|')).digest('hex').slice(0, 32); }
