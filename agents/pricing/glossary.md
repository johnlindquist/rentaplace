# Pricing glossary

What a word means inside pricing. Short on purpose. Site-wide words are in `GLOSSARY.md`.

- **Quote**: the full price of a stay, worked out from the listing's prices at that moment and shown before the guest reserves. A quote is not saved. A hold and a reservation each save their own copy of every amount when they are made; a guest who reserves a stay they are holding pays the hold's copy. (Code: `priceStay` in `src/domain/pricing.ts`.)
- **Weekend night**: a Friday or Saturday night, charged at the listing's weekend price. Sunday is a weeknight. (Code: `isWeekend`.)
- **Subtotal**: the nightly prices added up, plus the cleaning fee. Fees and tax are worked out from the subtotal.
- **Service fee**: 12% of the subtotal, paid by the guest, rounded once. Never refunded on a partial refund.
- **Tax**: 8% of the subtotal, rounded once.
- **Host share**: the subtotal less a 3% platform fee. It is what the payout pays.
- **Surcharge**: has no meaning yet. No rule adds one. Define it here before building it.
