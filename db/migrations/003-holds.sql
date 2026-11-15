-- A hold is a 24-hour claim on a stay by a signed-in guest. It keeps the nights and the quoted price. It holds no money:
-- no payment, payout or confirmation row refers to it. One hold per guest and stay; a request key places one hold.
CREATE TABLE holds (
  id TEXT PRIMARY KEY, reference TEXT NOT NULL UNIQUE, listing_id TEXT NOT NULL REFERENCES listings(id),
  guest_id TEXT NOT NULL REFERENCES users(id), from_date TEXT NOT NULL, to_date TEXT NOT NULL, guests INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','released','expired','converted')),
  quote TEXT NOT NULL, total_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL, released_at TEXT, booking_id TEXT REFERENCES bookings(id),
  request_key TEXT UNIQUE, CHECK(from_date < to_date), UNIQUE(guest_id, listing_id, from_date, to_date)
);
CREATE INDEX holds_listing_dates ON holds(listing_id, from_date, to_date);
