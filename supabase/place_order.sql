-- ==========================================================
-- HAMS ARABIAN — place_order RPC (fixes "Order failed" on checkout)
-- Paste into Supabase Dashboard → SQL Editor → Run.
--
-- Why this exists:
--   The storefront calls supabase.rpc('place_order', { ... }) from
--   skincare-shop/app.js → submitOrder(). That RPC was listed as
--   "Future work" in SECURITY-UPGRADE.md and never created, so every
--   checkout returns "Order failed: function public.place_order(...)
--   does not exist" (PostgREST PGRST202 / 404).
--
-- What this does (server-side, atomic, in one transaction):
--   1. Validates payload (non-empty cart, positive quantities).
--   2. Upserts customer by email (so repeat buyers are merged).
--   3. Recalculates unit_price from products.price (frontend price
--      is IGNORED — prevents tampering).
--   4. Locks each product row (FOR UPDATE) and decrements stock,
--      raising 'insufficient stock' if short.
--   5. Inserts orders + order_items.
--   6. Returns the new order id.
--
-- The function is SECURITY DEFINER, so it bypasses RLS for the
-- anon/authenticated caller while still running its own validation.
-- ==========================================================

CREATE OR REPLACE FUNCTION public.place_order(
  p_customer JSONB,   -- { name, email, phone }
  p_shipping JSONB,   -- { city, address }
  p_notes    TEXT,
  p_total    NUMERIC, -- ignored / recomputed; kept for signature compat
  p_items    JSONB    -- [ { product_id, quantity, unit_price } ]
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_customer_id UUID;
  v_order_id    UUID;
  v_item        JSONB;
  v_product_id  UUID;
  v_qty         INTEGER;
  v_price       NUMERIC;
  v_stock       INTEGER;
  v_subtotal    NUMERIC := 0;
  v_email       TEXT;
  v_name        TEXT;
  v_phone       TEXT;
BEGIN
  ---------- 1. Basic payload validation ----------
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'place_order: cart is empty';
  END IF;

  v_name  := NULLIF(trim(p_customer->>'name'),  '');
  v_email := NULLIF(lower(trim(p_customer->>'email')), '');
  v_phone := NULLIF(trim(p_customer->>'phone'), '');

  IF v_name IS NULL OR v_email IS NULL OR v_phone IS NULL THEN
    RAISE EXCEPTION 'place_order: name, email and phone are required';
  END IF;

  IF NULLIF(trim(p_shipping->>'city'),    '') IS NULL
     OR NULLIF(trim(p_shipping->>'address'), '') IS NULL THEN
    RAISE EXCEPTION 'place_order: shipping city and address are required';
  END IF;

  ---------- 2. Upsert customer by email ----------
  -- If a customer row with this email already exists, reuse it and
  -- refresh name/phone. Otherwise insert a new one.
  INSERT INTO customers (name, email, phone)
  VALUES (v_name, v_email, v_phone)
  ON CONFLICT (email) DO UPDATE
    SET name  = EXCLUDED.name,
        phone = EXCLUDED.phone
  RETURNING id INTO v_customer_id;

  ---------- 3. Validate stock & recompute total ----------
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_product_id := (v_item->>'product_id')::uuid;
    v_qty        := COALESCE((v_item->>'quantity')::int, 0);

    IF v_qty <= 0 THEN
      RAISE EXCEPTION 'place_order: quantity must be positive for product %', v_product_id;
    END IF;

    -- Lock the product row and pull the AUTHORITATIVE price + stock.
    SELECT price, quantity
      INTO v_price, v_stock
      FROM products
     WHERE id = v_product_id
     FOR UPDATE;

    IF v_price IS NULL THEN
      RAISE EXCEPTION 'place_order: product % not found', v_product_id;
    END IF;

    IF v_stock < v_qty THEN
      RAISE EXCEPTION 'place_order: insufficient stock for product % (have %, need %)',
                      v_product_id, v_stock, v_qty;
    END IF;

    v_subtotal := v_subtotal + (v_price * v_qty);
  END LOOP;

  ---------- 4. Insert order header ----------
  INSERT INTO orders (
    customer_id,
    status,
    total_amount,
    shipping_address,
    notes
  )
  VALUES (
    v_customer_id,
    'pending',
    v_subtotal,
    jsonb_build_object(
      'city',    p_shipping->>'city',
      'address', p_shipping->>'address'
    ),
    NULLIF(trim(coalesce(p_notes, '')), '')
  )
  RETURNING id INTO v_order_id;

  ---------- 5. Insert items + decrement stock ----------
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_product_id := (v_item->>'product_id')::uuid;
    v_qty        := (v_item->>'quantity')::int;

    -- Re-pull the (now locked) authoritative price.
    SELECT price INTO v_price FROM products WHERE id = v_product_id;

    INSERT INTO order_items (order_id, product_id, quantity, unit_price)
    VALUES (v_order_id, v_product_id, v_qty, v_price);

    UPDATE products
       SET quantity = quantity - v_qty
     WHERE id = v_product_id;
  END LOOP;

  RETURN v_order_id;
END;
$$;

-- Storefront callers are anon (unauthenticated) — grant EXECUTE.
GRANT EXECUTE ON FUNCTION public.place_order(JSONB, JSONB, TEXT, NUMERIC, JSONB)
  TO anon, authenticated;

-- ----------------------------------------------------------
-- Prerequisites this function assumes already exist:
--   * customers(id uuid pk, name text, email text UNIQUE, phone text)
--       └ if customers.email is NOT UNIQUE yet, run:
--           ALTER TABLE customers ADD CONSTRAINT customers_email_key UNIQUE (email);
--         (Required for the ON CONFLICT (email) clause above.)
--   * orders(id uuid pk, customer_id uuid fk, status text,
--            total_amount numeric, shipping_address jsonb, notes text,
--            created_at timestamptz default now())
--   * order_items(id uuid pk, order_id uuid fk, product_id uuid fk,
--                 quantity int, unit_price numeric)
--   * products(id uuid pk, name text, price numeric, quantity int)
--
-- Verify after running:
--   select public.place_order(
--     '{"name":"Test","email":"t@example.com","phone":"00000"}'::jsonb,
--     '{"city":"Kuwait","address":"line"}'::jsonb,
--     null,
--     0,
--     '[]'::jsonb
--   );
--   -- expect:  ERROR: place_order: cart is empty
-- ==========================================================
