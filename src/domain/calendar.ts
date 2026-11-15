import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { addDays, now } from '../config.ts';
import { AppError, requireValue } from '../errors.ts';
import { validateDates, validDate } from './pricing.ts';
import { hostListings, ownedListing } from './listings.ts';
import { transaction } from '../db.ts';
import type { Account, Listing } from '../types.ts';
export function monthDates(month: string): string[] {
  requireValue(/^\d{4}-\d{2}$/.test(month) && validDate(month+'-01'),'Use a valid month in YYYY-MM format.');
  const days:string[]=[];
  for(let date=month+'-01';date.startsWith(month);date=addDays(date,1))days.push(date);
  return days;
}
export function listingCalendar(db: DatabaseSync,home: Listing,month: string,details=false,clock=now()) {
  const booking=db.prepare("SELECT id,reference,status FROM bookings WHERE listing_id=? AND from_date<=? AND to_date>? AND status IN ('confirmed','pending','completed') LIMIT 1");
  const blocked=db.prepare('SELECT id,reason FROM blocks WHERE listing_id=? AND from_date<=? AND to_date>? LIMIT 1');
  const held=db.prepare("SELECT id FROM holds WHERE listing_id=? AND from_date<=? AND to_date>? AND status='active' AND expires_at>? LIMIT 1");
  const days=monthDates(month).map(date=>{
    const stay:any=booking.get(home.id,date,date), block:any=blocked.get(home.id,date,date);
    const status=stay?(stay.status==='pending'?'pending':'booked'):block?'blocked':held.get(home.id,date,date,clock)?'held':'available';
    return {date,status,...(details?{bookingId:stay?.id,reference:stay?.reference,blockId:block?.id,reason:block?.reason}: {})};
  });
  return {slug:home.slug,title:home.title,month,days};
}
export function hostCalendar(db: DatabaseSync,user: Account | undefined,month: string,slug?: string) {
  const homes=slug?[ownedListing(db,slug,user)]:hostListings(db,user);
  return {month,days:monthDates(month),listings:homes.map(h=>({...listingCalendar(db,h,month,true),image:h.photos[0]}))};
}
export function blockDates(db: DatabaseSync,user: Account | undefined,input: any,clock=now()) {
  const home=ownedListing(db,String(input.slug),user),from=String(input.from),to=String(input.to);
  validateDates(from,to,true);
  const reason=String(input.reason || 'Personal use').trim();
  requireValue(reason.length<=200,'Keep the block note to 200 characters.');
  return transaction(db,()=>{
    const conflict=db.prepare("SELECT id FROM bookings WHERE listing_id=? AND from_date<? AND to_date>? AND status IN ('confirmed','pending','completed') LIMIT 1").get(home.id,to,from);
    if(conflict)throw new AppError(409,'RESERVATION_CONFLICT','These dates already have a reservation.');
    if(db.prepare("SELECT id FROM holds WHERE listing_id=? AND from_date<? AND to_date>? AND status='active' AND expires_at>? LIMIT 1").get(home.id,to,from,clock))throw new AppError(409,'HOLD_CONFLICT','A guest is holding these dates. The hold runs out within 24 hours.');
    const id=randomUUID();db.prepare('INSERT INTO blocks VALUES (?,?,?,?,?,?)').run(id,home.id,from,to,reason,now());
    return {id,slug:home.slug,from,to,reason};
  });
}
export function unblockDates(db: DatabaseSync,user: Account | undefined,id: string) {
  const block:any=db.prepare('SELECT b.*,l.slug FROM blocks b JOIN listings l ON b.listing_id=l.id WHERE b.id=?').get(id);
  if(!block)throw new AppError(404,'NOT_FOUND','Blocked dates not found.');
  ownedListing(db,block.slug,user);db.prepare('DELETE FROM blocks WHERE id=?').run(id);return {id,removed:true};
}
