'use client';

import Link from 'next/link';
import { useState } from 'react';
import { cn } from '@/lib/utils';

type Day = { date: string; status: string };
type Home = { slug: string; title: string; image: string; days: Day[] };
export type PortfolioData = { month: string; days: string[]; listings: Home[] };

const weekday = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'narrow', timeZone: 'UTC' });

const BAR: Record<string, string> = {
  booked: 'bg-primary/70',
  pending: 'bg-pending',
  held: 'bg-pending/50',
  blocked: 'bg-[repeating-linear-gradient(135deg,var(--blocked),var(--blocked)_2px,var(--blocked-soft)_2px,var(--blocked-soft)_5px)]',
  available: '',
};

/** Every home across one month. Selecting an open day fills in the block form below. */
export function PortfolioCalendar({ data, formId }: { data: PortfolioData; formId: string }) {
  const [hovered, setHovered] = useState('');
  const [note, setNote] = useState('Select a day to start blocking dates, or open a home’s full calendar.');
  const columns = { gridTemplateColumns: `225px repeat(${data.days.length}, minmax(27px, 1fr))` };

  function describe(home: Home, day: Day) {
    setNote(`${home.title} · ${day.date} · ${day.status}`);
  }

  function choose(home: Home, day: Day) {
    if (day.status !== 'available') {
      setNote(`This date is ${day.status}. Manage existing reservations from the Reservations page.`);
      return;
    }
    const form = document.getElementById(formId) as HTMLFormElement | null;
    if (!form) return;
    const set = (name: string, value: string) => {
      const field = form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | null;
      if (field) field.value = value;
    };
    const end = new Date(`${day.date}T12:00:00Z`);
    end.setUTCDate(end.getUTCDate() + 1);
    set('slug', home.slug);
    set('from', day.date);
    set('to', end.toISOString().slice(0, 10));
    form.dispatchEvent(new CustomEvent('calendar:choose', { detail: { slug: home.slug } }));
    form.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    (form.elements.namedItem('reason') as HTMLInputElement | null)?.focus({ preventScroll: true });
  }

  return (
    <div className="space-y-3">
      <div className="max-h-[680px] overflow-auto rounded-2xl border bg-card">
        <div className="min-w-[1120px]">
          <div className="sticky top-0 z-10 grid min-h-11 border-b bg-muted" style={columns}>
            <div className="sticky left-0 z-10 flex items-center border-r bg-muted px-3 text-xs font-medium">{data.listings.length} {data.listings.length === 1 ? 'home' : 'homes'}</div>
            {data.days.map((date) => (
              <div key={date} className="flex flex-col items-center justify-center text-[11px]"><span className="text-[9px] text-muted-foreground">{weekday(date)}</span><strong className="font-medium">{Number(date.slice(-2))}</strong></div>
            ))}
          </div>
          {data.listings.map((home) => (
            <div key={home.slug} className="grid min-h-12 border-b last:border-b-0" style={columns}>
              <Link href={`/host/calendar?month=${data.month}&slug=${home.slug}`} className="sticky left-0 z-[1] flex items-center gap-2.5 overflow-hidden border-r bg-card px-3 text-xs font-medium whitespace-nowrap hover:text-primary">
                <img src={home.image} alt="" width={36} height={24} className="h-6 w-9 flex-none rounded object-cover" />
                <span className="truncate">{home.title}</span>
              </Link>
              {home.days.map((day) => {
                const key = `${home.slug}:${day.date}`;
                return (
                  <button
                    key={day.date}
                    type="button"
                    data-day={day.date}
                    data-slug={home.slug}
                    data-status={day.status}
                    aria-label={`${home.title}, ${day.date}, ${day.status}`}
                    onPointerOver={() => { if (hovered !== key) { setHovered(key); describe(home, day); } }}
                    onFocus={() => describe(home, day)}
                    onClick={() => choose(home, day)}
                    className={cn('flex flex-col items-center justify-center gap-1 border-r border-border/50 px-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring', hovered === key && 'bg-secondary ring-1 ring-primary/50 ring-inset')}
                  >
                    <span className="text-[8px] text-muted-foreground">{Number(day.date.slice(-2))}</span>
                    <span className={cn('block h-3 w-full rounded-sm', BAR[day.status])} />
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <p className="text-sm text-muted-foreground" aria-live="polite">{note}</p>
    </div>
  );
}
