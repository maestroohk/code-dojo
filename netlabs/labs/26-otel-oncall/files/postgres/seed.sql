-- The shop's database: 40 products, their stock, and 300,000 reviews. reviews has no index on product_id
-- yet, so "the newest reviews of one product" reads the whole table every time.
CREATE TABLE products (id int PRIMARY KEY, name text NOT NULL, price_cents int NOT NULL);
CREATE TABLE stock (product_id int PRIMARY KEY REFERENCES products(id), qty int NOT NULL);
CREATE TABLE reviews (
  id bigserial PRIMARY KEY,
  product_id int NOT NULL REFERENCES products(id),
  rating smallint NOT NULL,
  body text NOT NULL,
  created timestamptz NOT NULL
);

INSERT INTO products SELECT g, 'Product ' || g, 500 + (g * 137) % 9000 FROM generate_series(1, 40) g;
INSERT INTO stock SELECT id, 1000000000 FROM products;
INSERT INTO reviews (product_id, rating, body, created)
SELECT 1 + ((g::bigint * 7919) % 40)::int, 1 + g % 5, 'Review ' || g || ': ' || repeat('solid product, fast delivery, would buy again. ', 8),
       timestamptz '2026-01-01' + (g || ' minutes')::interval
FROM generate_series(1, 300000) g;
ANALYZE;
