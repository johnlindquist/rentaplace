import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { listingBySlug, transaction } from '../db.ts';
import { AppError, textInput, integer } from '../errors.ts';
import { priceStay, validateDates } from './pricing.ts';
import { assertAvailable } from './bookings.ts';
import { log } from '../log.ts';
import { now } from '../config.ts';
import { requireUser } from '../auth.ts';
import type { Account } from '../types.ts';
/** How long a hold keeps its nights and its price. */
export const HOLD_HOURS=24;
/** How many holds one guest can have active at once. A getaway is one stay; three lets a guest keep a short list while deciding. Released, expired and reserved holds do not count. */
export const MAX_ACTIVE_HOLDS=3;
/** A hold as its guest reads it. Expiry is decided here from the clock passed in, never from a background job. */
function view(row:any,clock:string) {
  return {...row,quote:JSON.parse(row.quote),status:row.status==='active' && row.expires_at<=clock?'expired':row.status};
}
/** Marks holds whose 24 hours have passed. Availability never depends on this having run. */
export function expireHolds(db: DatabaseSync,clock=now()): number {
  return Number(db.prepare("UPDATE holds SET status='expired' WHERE status='active' AND expires_at<=?").run(clock).changes);
}
/** A guest's holds that still keep nights at this clock. Released, expired and reserved holds are not counted. */
export function activeHoldCount(db: DatabaseSync,guestId: string,clock=now()): number {
  return Number((db.prepare("SELECT COUNT(*) n FROM holds WHERE guest_id=? AND status='active' AND expires_at>?").get(guestId,clock) as any).n);
}
/** Place a 24-hour hold on a stay for the signed-in guest: it keeps the nights and the price quoted now. No money moves. At most MAX_ACTIVE_HOLDS active per guest. */
export function placeHold(db: DatabaseSync,input: any,account: Account | undefined,clock=now()) {
  const user=requireUser(account,'guest');
  const slug=textInput(input.slug,'Home',180),from=textInput(input.from,'Check-in',10),to=textInput(input.to,'Check-out',10);
  validateDates(from,to,true);
  const home=listingBySlug(db,slug);
  if(!home)throw new AppError(404,'NOT_FOUND','We could not find that home.');
  const guests=integer(input.guests ?? 2,'Guests',1,home.sleeps);
  const key=input.requestKey?textInput(input.requestKey,'Request key',100):null;
  const result=transaction(db,()=>{
    // The replay lookup comes first, as in checkout: a retry's own hold already keeps its nights.
    if(key) {
      const prior:any=db.prepare('SELECT * FROM holds WHERE request_key=?').get(key);
      if(prior) {
        if(prior.guest_id!==user.id || prior.listing_id!==home.id || prior.from_date!==from || prior.to_date!==to || prior.guests!==guests)throw new AppError(409,'REQUEST_CONFLICT','That request key belongs to a different hold.');
        return {hold:prior,replayed:true};
      }
    }
    expireHolds(db,clock);
    if(home.status!=='active')throw new AppError(409,'HOME_NOT_OPEN','This home is not taking new stays.');
    if(db.prepare('SELECT id FROM holds WHERE guest_id=? AND listing_id=? AND from_date=? AND to_date=?').get(user.id,home.id,from,to))throw new AppError(409,'HOLD_EXISTS','You have already held this stay once. A stay can be held one time.');
    if(activeHoldCount(db,user.id,clock)>=MAX_ACTIVE_HOLDS)throw new AppError(409,'HOLD_LIMIT',`You can hold up to ${MAX_ACTIVE_HOLDS} stays at a time. Reserve or release one, or wait for one to run out, before holding another.`);
    assertAvailable(db,home.id,from,to,{clock});
    const q=priceStay(home,from,to,guests),id=randomUUID(),reference=`HOLD-${id.slice(0,8).toUpperCase()}`;
    const expires=new Date(Date.parse(clock)+HOLD_HOURS*3600000).toISOString();
    db.prepare('INSERT INTO holds (id,reference,listing_id,guest_id,from_date,to_date,guests,status,quote,total_cents,created_at,expires_at,request_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,reference,home.id,user.id,from,to,guests,'active',JSON.stringify(q),q.totalCents,clock,expires,key);
    return {hold:db.prepare('SELECT * FROM holds WHERE id=?').get(id),replayed:false};
  });
  if(!result.replayed)log('hold.placed',{holdId:result.hold.id,listingId:home.id,totalCents:result.hold.total_cents,expiresAt:result.hold.expires_at});
  return {hold:view(result.hold,clock),replayed:result.replayed};
}
export function guestHolds(db: DatabaseSync,user: Account | undefined,clock=now()) {
  const account=requireUser(user,'guest');
  return db.prepare('SELECT h.*,l.title,l.slug FROM holds h JOIN listings l ON h.listing_id=l.id WHERE h.guest_id=? ORDER BY h.created_at DESC,h.rowid DESC').all(account.id).map(row=>view(row,clock));
}
export function readHold(db: DatabaseSync,id: string,user: Account | undefined,clock=now()) {
  const account=requireUser(user,'guest');
  const row=db.prepare('SELECT h.*,l.title,l.slug FROM holds h JOIN listings l ON h.listing_id=l.id WHERE h.id=? AND h.guest_id=?').get(id,account.id);
  if(!row)throw new AppError(404,'NOT_FOUND','Hold not found.');
  return view(row,clock);
}
/** Give the nights back early. Releasing twice, or after the hold ran out or became a reservation, changes nothing. */
export function releaseHold(db: DatabaseSync,id: string,user: Account | undefined,clock=now()) {
  const hold=readHold(db,id,user,clock);
  if(hold.status!=='active')return hold;
  db.prepare("UPDATE holds SET status='released',released_at=? WHERE id=? AND status='active'").run(clock,id);
  log('hold.released',{holdId:id});
  return readHold(db,id,user,clock);
}
