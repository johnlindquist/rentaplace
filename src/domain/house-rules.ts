import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { ROOT } from '../config.ts';
import { listingBySlug } from '../db.ts';
import { AppError } from '../errors.ts';

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function parseHouseRules(markdown: string, home: string) {
  const [metadata, ...sections] = markdown.replace(/\r\n/g, '\n').split(/^## /m);
  const title = metadata?.match(/^# (.+)$/m)?.[1]?.trim();
  const revision = metadata?.match(/^Revision: (\d{4}-\d{2}-\d{2})$/m)?.[1];
  if (!title || !revision || metadata?.match(/^Home: (.+)$/m)?.[1] !== home) {
    throw new Error(`Invalid house rules metadata for ${home}`);
  }
  const headings = new Set<string>();
  const passages = sections.map(section => {
    const [first, ...lines] = section.split('\n');
    const heading = (first || '').trim();
    const topic = heading.toLowerCase();
    const text = lines.join('\n').trim();
    if (!heading || !text || headings.has(topic)) throw new Error(`Invalid or repeated house rules heading for ${home}`);
    headings.add(topic);
    const source = `/api/listings/${encodeURIComponent(home)}/house-rules?${new URLSearchParams({ topic })}`;
    return { home, revision, heading, text, source };
  });
  return { title, revision, passages };
}

export function houseRules(db: DatabaseSync, slug: string, topic: string, directory = join(ROOT, 'knowledge/houses')) {
  const listing = slugPattern.test(slug) ? listingBySlug(db, slug) : undefined;
  if (!listing || listing.status !== 'active') throw new AppError(404, 'HOME_NOT_FOUND', 'We could not find that home.');
  const home = listing.slug;
  const listingFacts = { title: listing.title, amenities: listing.amenities, source: `/homes/${encodeURIComponent(home)}` };
  let markdown: string;
  try {
    markdown = readFileSync(join(directory, `${home}.md`), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { home, listing: listingFacts, status: 'NO_HOUSE_RULES', title: null, revision: null, passages: [] };
  }
  const document = parseHouseRules(markdown, home);
  const key = topic.trim().toLowerCase();
  const passages = key ? document.passages.filter(passage => passage.heading.toLowerCase() === key) : document.passages;
  return { home, listing: listingFacts, ...document, status: passages.length ? 'FOUND' : 'TOPIC_NOT_FOUND', passages };
}
