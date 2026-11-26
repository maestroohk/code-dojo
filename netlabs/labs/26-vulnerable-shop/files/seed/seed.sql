-- The shop's database. init/shop.sh fills in the @NAME@ values for this run.
PRAGMA journal_mode = WAL;

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,          -- unsalted SHA-256 of the password (see the lesson on password storage)
  is_admin INTEGER NOT NULL DEFAULT 0,
  support_pin TEXT
);

CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at TEXT NOT NULL);

CREATE TABLE products (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
  price_cents INTEGER NOT NULL, hidden INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE orders (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, placed_at TEXT NOT NULL, total_cents INTEGER NOT NULL,
  status TEXT NOT NULL, ship_to TEXT NOT NULL, delivery_note TEXT NOT NULL
);

CREATE TABLE reviews (id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL, user_id INTEGER NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);

CREATE TABLE tickets (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, message TEXT NOT NULL, url TEXT, done INTEGER NOT NULL, created_at TEXT NOT NULL);

INSERT INTO users VALUES
  (1, 'admin', 'Shop staff', 'staff@shop.example', '@ADMINHASH@', 1, '@PIN@'),
  (2, 'alice', 'Alice', 'alice@customer.example', '@ALICEHASH@', 0, ''),
  (3, 'bob', 'Bob', 'bob@customer.example', '@BOBHASH@', 0, ''),
  (4, 'carol', 'Carol', 'carol@customer.example', '@CAROLHASH@', 0, '');

INSERT INTO products VALUES
  (1, 'Desk lamp', 'A sturdy desk lamp with a weighted base and a warm 2700 K bulb.', 4900, 0),
  (2, 'Night Owl O''Clock Lamp', 'A bedside lamp with a clock in the base.', 3900, 0),
  (3, 'Floor lamp', 'A tall reading lamp with a dimmer.', 8900, 0),
  (4, 'Bulb pack (4)', 'Four E27 LED bulbs, 806 lumen.', 1200, 0),
  (5, 'Prototype lamp (staff only)', 'Not for sale yet: internal sample stock.', 100, 1);

INSERT INTO orders VALUES
  (1001, 2, '2026-10-02', 4900, 'delivered', 'Alice, 1 Example Street, Exampletown', 'Ring the bell'),
  (1002, 2, '2026-11-03', 1200, 'shipped', 'Alice, 1 Example Street, Exampletown', ''),
  (1003, 3, '2026-11-04', 8900, 'paid', 'Bob, 22 Sample Road, Sampleton', 'Leave it by the side gate, the code is @GATECODE@'),
  (1004, 4, '2026-11-05', 3900, 'paid', 'Carol, 3 Test Lane, Testville', '');

INSERT INTO reviews VALUES
  (1, 1, 3, 'Bright and <b>very</b> steady. Five stars.', '2026-10-20'),
  (2, 1, 4, 'Nice lamp, <i>slightly</i> loud switch.', '2026-10-28'),
  (3, 2, 2, 'The clock is easy to read at night.', '2026-11-01');
