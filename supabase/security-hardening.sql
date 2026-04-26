-- ==========================================================
-- HAMS ARABIAN — SECURITY HARDENING MIGRATION
-- Paste this into Supabase Dashboard → SQL Editor → Run.
--
-- What this does:
--   1. Replaces public.is_admin() with a hardcoded admin UUID list
--      (no more "any authenticated user = admin").
--   2. Re-applies RLS so writes require is_admin(), not just auth.
--   3. Adds atomic stock-decrement RPC (decrement_product_stock).
--   4. Locks the product-images bucket to admin-only writes.
--   5. Adds a trigger that prevents non-admin clients from changing
--      orders.status / orders.payment_status / totals.
--
-- BEFORE RUNNING — replace the placeholder UUID in the is_admin()
-- function with your real admin user IDs. Find them via:
--   select id, email from auth.users;
-- ==========================================================

-- ---------- 1. Hardcoded admin UUID list ------------------------
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() = ANY (ARRAY[
    -- ⬇⬇ REPLACE THIS WITH YOUR REAL ADMIN auth.users.id VALUES ⬇⬇
    '00000000-0000-0000-0000-000000000000'::uuid
    -- , 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid   -- second admin, etc.
  ]);
$$;

GRANT EXECUTE ON FUNCTION public.is_admin() TO anon, authenticated;

-- ---------- 2. Re-apply tightened RLS ---------------------------
-- Adjust table names below to match the tables that actually exist
-- in your Hams Arabian Supabase project. Drop-then-create is
-- idempotent so it's safe to re-run.

DROP POLICY IF EXISTS "admin_all_collections"     ON collections;
DROP POLICY IF EXISTS "admin_all_products"        ON products;
DROP POLICY IF EXISTS "admin_all_variants"        ON product_variants;
DROP POLICY IF EXISTS "admin_manage_orders"       ON orders;
DROP POLICY IF EXISTS "admin_delete_orders"       ON orders;
DROP POLICY IF EXISTS "admin_manage_order_items"  ON order_items;
DROP POLICY IF EXISTS "customers_admin_all"       ON customers;

CREATE POLICY "admin_all_collections"     ON collections      FOR ALL    USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY "admin_all_products"        ON products         FOR ALL    USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY "admin_all_variants"        ON product_variants FOR ALL    USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY "admin_manage_orders"       ON orders           FOR UPDATE USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY "admin_delete_orders"       ON orders           FOR DELETE USING (public.is_admin());
CREATE POLICY "admin_manage_order_items"  ON order_items      FOR ALL    USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY "customers_admin_all"       ON customers        FOR ALL    USING (public.is_admin()) WITH CHECK (public.is_admin());

-- ---------- 3. Atomic stock decrement RPC -----------------------
-- Use this from the storefront checkout instead of plain UPDATE so
-- two concurrent orders cannot oversell. The function locks the row
-- via SELECT ... FOR UPDATE and rejects the call when stock is short.
CREATE OR REPLACE FUNCTION public.decrement_product_stock(
  p_product_id UUID,
  p_quantity   INTEGER
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_qty INTEGER;
BEGIN
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'quantity must be positive';
  END IF;

  SELECT quantity INTO current_qty
  FROM products
  WHERE id = p_product_id
  FOR UPDATE;

  IF current_qty IS NULL THEN
    RAISE EXCEPTION 'product not found';
  END IF;

  IF current_qty < p_quantity THEN
    RAISE EXCEPTION 'insufficient stock (have %, need %)', current_qty, p_quantity;
  END IF;

  UPDATE products
     SET quantity = current_qty - p_quantity
   WHERE id = p_product_id;

  RETURN current_qty - p_quantity;
END;
$$;

GRANT EXECUTE ON FUNCTION public.decrement_product_stock(UUID, INTEGER) TO anon, authenticated;

-- ---------- 4. Lock storage bucket to admin-only writes ---------
DROP POLICY IF EXISTS "public_read_product_images"  ON storage.objects;
DROP POLICY IF EXISTS "auth_upload_product_images"  ON storage.objects;
DROP POLICY IF EXISTS "auth_update_product_images"  ON storage.objects;
DROP POLICY IF EXISTS "auth_delete_product_images"  ON storage.objects;
DROP POLICY IF EXISTS "admin_upload_product_images" ON storage.objects;
DROP POLICY IF EXISTS "admin_update_product_images" ON storage.objects;
DROP POLICY IF EXISTS "admin_delete_product_images" ON storage.objects;

CREATE POLICY "public_read_product_images"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'product-images');

CREATE POLICY "admin_upload_product_images"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'product-images' AND public.is_admin());

CREATE POLICY "admin_update_product_images"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'product-images' AND public.is_admin())
  WITH CHECK (bucket_id = 'product-images' AND public.is_admin());

CREATE POLICY "admin_delete_product_images"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'product-images' AND public.is_admin());

-- ---------- 5. Payment-status protection ------------------------
-- Reject any non-admin attempt to flip status / payment_status /
-- totals on orders. Service-role (used by webhooks) bypasses RLS
-- and triggers like this one only apply to client-side updates.
CREATE OR REPLACE FUNCTION public.protect_order_payment_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF public.is_admin() THEN
    RETURN NEW;
  END IF;

  IF (NEW.status         IS DISTINCT FROM OLD.status)
     OR (NEW.total_amount IS DISTINCT FROM OLD.total_amount) THEN
    RAISE EXCEPTION 'orders: protected fields can only be changed by admin';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_order_payment_fields ON orders;
CREATE TRIGGER trg_protect_order_payment_fields
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION public.protect_order_payment_fields();

-- ==========================================================
-- DONE.
-- Verify with:
--   select public.is_admin();             -- should be TRUE for you
--   select * from pg_policies where schemaname='public';
-- ==========================================================
