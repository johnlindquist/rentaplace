import test from 'node:test';
import assert from 'node:assert/strict';
import { createBooking, quote, respondToReservation } from '../src/domain/bookings.ts';
import { fixture, guest, host, input } from './helpers.ts';
// Proves the Booking glossary's definition of "hold" against the code: an active hold locks the quoted price.
test('an active hold locks the quoted price when the host raises prices before accepting',()=>{
 const {db}=fixture();const request={...input,slug:'courtyard-loft'};
 const quoted=quote(db,request.slug,request.from,request.to,2);
 const {booking}=createBooking(db,request,guest);assert.equal(booking.status,'pending');assert.equal(booking.total_cents,quoted.totalCents);
 db.prepare('UPDATE listings SET nightly_cents=nightly_cents*2,weekend_cents=weekend_cents*2 WHERE slug=?').run(request.slug);
 const accepted=respondToReservation(db,booking.id,'accept',host);
 assert.equal(accepted.status,'confirmed');assert.equal(accepted.total_cents,quoted.totalCents);
 const saved:any=db.prepare('SELECT total_cents,accommodation_cents FROM bookings WHERE id=?').get(booking.id);
 assert.equal(saved.total_cents,quoted.totalCents);assert.equal(saved.accommodation_cents,quoted.accommodationCents);
 const later=quote(db,request.slug,'2026-12-01','2026-12-04',2);assert.ok(later.accommodationCents>quoted.accommodationCents);db.close();
});
