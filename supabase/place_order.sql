-- ==========================================================
-- HAMS ARABIAN — place_order RPC (with BUNDLE support)
-- Paste into Supabase Dashboard → SQL Editor → Run as 'postgres'.
--
-- Run bundles.sql FIRST (it adds order_items.bundle_id).
--
-- p_items entries are polymorphic:
--   { "product_id": "uuid", "quantity": 1, "unit_price": 5.000 }
--   { "bundle_id":  "uuid", "quantity": 1, "unit_price": 12.500 }
-- unit_price from the client is IGNORED — recomputed server-side.
-- ==========================================================

CREATE OR REPLACE FUNCTION public.place_order(
  p_customer JSONB,
  p_shipping JSONB,
  p_notes    TEXT,
  p_total    NUMERIC,
  p_items    JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_customer_id  UUID;
  v_order_id     UUID;
  v_item         JSONB;
  v_product_id   UUID;
  v_bundle_id    UUID;
  v_qty          INTEGER;
  v_price        NUMERIC;
  v_stock        INTEGER;
  v_subtotal     NUMERIC := 0;
  v_email        TEXT;
  v_name         TEXT;
  v_phone        TEXT;
  v_bi           RECORD;
  v_bundle_active BOOLEAN;
BEGIN
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'place_order: cart is empty';
  END IF;

  v_name  := NULLIF(trim(p_customer->>'name'),  '');
  v_email := NULLIF(lower(trim(p_customer->>'email')), '');
  v_phone := NULLIF(trim(p_customer->>'phone'), '');

  IF v_name IS NULL OR v_email IS NULL OR v_phone IS NULL THEN
    RAISE EXCEPTION 'place_order: name, email and phone are required';
  END IF;

  IF NULLIF(trim(p_shipping->>'city'), '') IS NULL
     OR NULLIF(trim(p_shipping->>'address'), '') IS NULL THEN
    RAISE EXCEPTION 'place_order: shipping city and address are required';
  END IF;

  INSERT INTO customers (name, email, phone)
  VALUES (v_name, v_email, v_phone)
  ON CONFLICT (email) DO UPDATE
    SET name = EXCLUDED.name, phone = EXCLUDED.phone
  RETURNING id INTO v_customer_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_product_id := NULLIF(v_item->>'product_id', '')::uuid;
    v_bundle_id  := NULLIF(v_item->>'bundle_id',  '')::uuid;
    v_qty        := COALESCE((v_item->>'quantity')::int, 0);

    IF v_qty <= 0 THEN
      RAISE EXCEPTION 'place_order: quantity must be positive';
    END IF;

    IF (v_product_id IS NOT NULL AND v_bundle_id IS NOT NULL)
       OR (v_product_id IS NULL AND v_bundle_id IS NULL) THEN
      RAISE EXCEPTION 'place_order: each line must have exactly one of product_id or bundle_id';
    END IF;

    IF v_product_id IS NOT NULL THEN
      SELECT price, quantity INTO v_price, v_stock
        FROM products WHERE id = v_product_id FOR UPDATE;
      IF v_price IS NULL THEN
        RAISE EXCEPTION 'place_order: product % not found', v_product_id;
      END IF;
      IF v_stock < v_qty THEN
        RAISE EXCEPTION 'place_order: insufficient stock for product % (have %, need %)',
                        v_product_id, v_stock, v_qty;
      END IF;
      v_subtotal := v_subtotal + (v_price * v_qty);
    ELSE
      SELECT bundle_price, is_active INTO v_price, v_bundle_active
        FROM bundles WHERE id = v_bundle_id FOR UPDATE;
      IF v_price IS NULL THEN
        RAISE EXCEPTION 'place_order: bundle % not found', v_bundle_id;
      END IF;
      IF v_bundle_active IS NOT TRUE THEN
        RAISE EXCEPTION 'place_order: bundle % is no longer available', v_bundle_id;
      END IF;

      FOR v_bi IN SELECT product_id, quantity FROM bundle_items WHERE bundle_id = v_bundle_id
      LOOP
        SELECT quantity INTO v_stock
          FROM products WHERE id = v_bi.product_id FOR UPDATE;
        IF v_stock IS NULL THEN
          RAISE EXCEPTION 'place_order: bundle % references missing product %',
                          v_bundle_id, v_bi.product_id;
        END IF;
        IF v_stock < v_bi.quantity * v_qty THEN
          RAISE EXCEPTION 'place_order: bundle % is out of stock (product % has %, needs %)',
                          v_bundle_id, v_bi.product_id, v_stock, v_bi.quantity * v_qty;
        END IF;
      END LOOP;

      v_subtotal := v_subtotal + (v_price * v_qty);
    END IF;
  END LOOP;

  INSERT INTO orders (customer_id, status, total_amount, shipping_address, notes)
  VALUES (
    v_customer_id, 'pending', v_subtotal,
    jsonb_build_object('city', p_shipping->>'city', 'address', p_shipping->>'address'),
    NULLIF(trim(coalesce(p_notes, '')), '')
  )
  RETURNING id INTO v_order_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_product_id := NULLIF(v_item->>'product_id', '')::uuid;
    v_bundle_id  := NULLIF(v_item->>'bundle_id',  '')::uuid;
    v_qty        := (v_item->>'quantity')::int;

    IF v_product_id IS NOT NULL THEN
      SELECT price INTO v_price FROM products WHERE id = v_product_id;
      INSERT INTO order_items (order_id, product_id, quantity, unit_price)
      VALUES (v_order_id, v_product_id, v_qty, v_price);
      UPDATE products SET quantity = quantity - v_qty WHERE id = v_product_id;
    ELSE
      SELECT bundle_price INTO v_price FROM bundles WHERE id = v_bundle_id;
      INSERT INTO order_items (order_id, bundle_id, quantity, unit_price)
      VALUES (v_order_id, v_bundle_id, v_qty, v_price);
      FOR v_bi IN SELECT product_id, quantity FROM bundle_items WHERE bundle_id = v_bundle_id
      LOOP
        UPDATE products SET quantity = quantity - (v_bi.quantity * v_qty)
         WHERE id = v_bi.product_id;
      END LOOP;
    END IF;
  END LOOP;

  RETURN v_order_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.place_order(JSONB, JSONB, TEXT, NUMERIC, JSONB)
  TO anon, authenticated;
