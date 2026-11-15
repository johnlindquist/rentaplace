import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { MonthField, SimpleSelect, DateRangeFields } from '@/components/forms';
import { PortfolioCalendar, type PortfolioData } from '@/components/portfolio-calendar';
import { Page, PageHeading, Problem } from '@/components/site';
import { Legend, MonthGrid } from '@/components/stay';
import { attempt, db, param, requireRole, type SearchParams } from '@/lib/server';
import { dateLabel } from '@/lib/format';
import { hostCalendar } from '../../../src/domain/calendar.ts';
import { hostListings } from '../../../src/domain/listings.ts';
import { addDays, today } from '../../../src/config.ts';

export const metadata = { title: 'Your calendar' };

export default async function HostCalendar({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const month = param(sp, 'month') || today().slice(0, 7);
  const chosen = param(sp, 'slug');
  const slug = chosen && chosen !== 'all' ? chosen : undefined;
  const user = await requireRole('host', `/host/calendar${slug ? `?slug=${slug}` : ''}`);
  const database = db();
  const result = attempt(() => hostCalendar(database, user, month, slug) as PortfolioData);
  if (!result.ok) return <Problem error={result.error} />;
  const data = result.value;
  const homes = hostListings(database, user);
  const blocks = database.prepare('SELECT b.*,l.title,l.slug FROM blocks b JOIN listings l ON b.listing_id=l.id WHERE l.host_id=? ORDER BY b.from_date').all(user.id) as { id: string; title: string; from_date: string; to_date: string; reason: string }[];
  const prev = addDays(`${month}-01`, -1).slice(0, 7);
  const next = addDays(data.days.at(-1)!, 1).slice(0, 7);
  const href = (m: string) => `/host/calendar?month=${m}${slug ? `&slug=${encodeURIComponent(slug)}` : ''}`;
  return (
    <Page>
      <PageHeading eyebrow="Make room, keep time" title="Your calendar." description={`${homes.length} homes. One view of what’s booked and what’s still possible.`} />
      <div className="mb-5 flex flex-col gap-4 rounded-2xl border bg-card p-4 lg:flex-row lg:items-end lg:justify-between">
        <form method="get" action="/host/calendar" className="grid flex-1 gap-3 sm:grid-cols-[180px_minmax(0,320px)_auto] sm:items-end">
          <MonthField value={month} />
          <div className="grid gap-1.5"><Label htmlFor="cal-home">Home</Label><SimpleSelect id="cal-home" name="slug" value={slug ?? ''} options={[['', 'All homes'], ...homes.map((h) => [h.slug, h.title] as [string, string])]} /></div>
          <Button type="submit" variant="outline">Show calendar</Button>
        </form>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="icon"><Link href={href(prev)} aria-label="Previous month"><ChevronLeft /></Link></Button>
          <span className="w-32 text-center text-sm font-medium">{dateLabel(`${month}-01`, { month: 'long', year: 'numeric' })}</span>
          <Button asChild variant="outline" size="icon"><Link href={href(next)} aria-label="Next month"><ChevronRight /></Link></Button>
        </div>
      </div>
      <Legend items={[['available', 'Available'], ['booked', 'Reserved'], ['pending', 'Pending'], ['held', 'Held for 24 hours'], ['blocked', 'Blocked']]} />
      <div className="mt-4"><PortfolioCalendar data={data} formId="block-form" /></div>

      <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card className="rounded-2xl">
          <CardHeader><CardTitle className="font-serif text-2xl font-normal">Keep some dates for yourself.</CardTitle></CardHeader>
          <CardContent>
            <form id="block-form" method="post" action="/host/calendar/block" className="grid gap-4">
              <div className="grid gap-1.5"><Label htmlFor="block-home">Home</Label>
                <NativeSelect id="block-home" name="slug" defaultValue={slug ?? homes[0]?.slug}>
                  {homes.map((h) => <option key={h.slug} value={h.slug}>{h.title}</option>)}
                </NativeSelect>
              </div>
              <DateRangeFields from={addDays(today(), 5)} to={addDays(today(), 7)} min={today()} labels={['From', 'Until (exclusive)']} />
              <div className="grid gap-1.5"><Label htmlFor="reason">A note for you</Label><Input id="reason" name="reason" placeholder="Personal use, maintenance, or a little breathing room" maxLength={200} /></div>
              <Button type="submit" className="w-fit">Block dates</Button>
            </form>
          </CardContent>
        </Card>
        <Card className="rounded-2xl">
          <CardHeader><CardTitle className="font-serif text-2xl font-normal">Dates you’ve set aside</CardTitle></CardHeader>
          <CardContent className="grid gap-2">
            {blocks.length ? blocks.map((b) => (
              <div key={b.id} className="flex items-center justify-between gap-3 rounded-xl border p-3">
                <div><p className="text-sm font-medium">{b.title}</p><p className="text-xs text-muted-foreground">{dateLabel(b.from_date)} – {dateLabel(b.to_date)} · {b.reason}</p></div>
                <form method="post" action={`/host/calendar/unblock/${b.id}`}><Button type="submit" variant="outline" size="sm">Unblock</Button></form>
              </div>
            )) : <p className="text-sm text-muted-foreground">No dates are blocked. Your available nights are open to guests.</p>}
            {slug && data.listings[0] ? (
              <div className="mt-4 space-y-3 border-t pt-4">
                <p className="font-medium">{dateLabel(`${month}-01`, { month: 'long', year: 'numeric' })}</p>
                <MonthGrid calendar={{ month, days: data.listings[0].days }} />
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </Page>
  );
}
