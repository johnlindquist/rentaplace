# Pricing memories

Why prices work the way they do. One line each, every line names where it came from.

## Internal engineering

- All money is whole US cents; each night is priced on its own and each percentage is rounded once, so totals never drift. (commit f440195; decision `docs/decisions/0002-reservation-money.md`)
- Three weeknights at Lakeside A-Frame, November 9 to 12, cost 33,000 cents plus 6,000 cleaning: a 39,000-cent subtotal. A test protects this number; change the code, not the test. (decision 0002; `test/pricing.test.ts`; `AGENTS.md`)
- After a partial refund the host keeps the share of the accommodation that was retained; a full refund cancels the payout. (commit e61b46a; test in ccdfb16)
- A branch exists that takes weekend day labels from the calendar module; it is not merged. Check which days it treats as weekend before relying on it. (branch `weekend-rates-v2`, commits 4d8011b and e256c85)

## Customer-facing

- The first price a guest sees is the price they pay. (`GLOSSARY.md`, Quote; decision 0002)
- A 24-hour hold saves the whole quote when it is placed, and reserving the held stay uses those saved amounts, not the listing's current prices. Pricing code is not called again. (commit eba6d8c; `createBooking` in `src/domain/bookings.ts`; `test/holds.test.ts`)
- The service fee is never refunded on a partial refund. (`GLOSSARY.md`, Service fee; `policyText` in `src/domain/cancellation.ts`)
- A guest disputed a moderate-policy refund five days before check-in; the amount at exactly five days is under review. (tracker card `refund-window`, Checking)
- The 12%, 8% and 3% rates are fixed demo rules, not tax advice. (`docs/architecture.md`, Money and time)
