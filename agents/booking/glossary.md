# Booking glossary

What a word means inside reservations. Short on purpose. The site-wide words are in `GLOSSARY.md`; when the two disagree, fix one in the same change.

- **Hold**: a hold saves the dates for a guest for 24 hours, so no other reservation or host block can take them.
- **Active hold**: a hold that has not run out, been released, or become a reservation. A hold has a timer: it runs out by itself 24 hours after it was placed, with nothing to run and no one to ask. After that the hold keeps nothing. A guest can have at most three active holds at a time: a fourth is refused, and nothing is saved, until one of the three is reserved, released or runs out. Holds that have ended do not count. (Code: `assertAvailable` in `src/domain/bookings.ts`; `MAX_ACTIVE_HOLDS` in `src/domain/holds.ts`.)
- **Pending**: requested, waiting for the host. The payment is authorized, not paid. The host accepts (it becomes confirmed, at the saved price) or declines (full refund, nights free). A pending reservation holds its nights and locks the quoted price, as a confirmed one does: every amount is saved on the reservation when it is made. A reservation has no timer; only a hold does. (`test/hold-price.test.ts`.)
- **Reservation**: a guest's claim on a listing for a stay. Code and tables say `booking`; everything a guest or host reads says "reservation".
- **Checkout** (the date): the day the guest leaves. It is exclusive, so another stay may check in that day.
- **Checkout** (the action): reserving with the demo payment. The reservation, the payout schedule and the confirmation message are saved together or not at all.
