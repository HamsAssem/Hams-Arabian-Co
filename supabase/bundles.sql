-- ==========================================================
-- HAMS ARABIAN — BUNDLES FEATURE MIGRATION
-- Paste into Supabase Dashboard → SQL Editor → Run.
-- IMPORTANT: change the role at the bottom of the editor to
-- 'postgres' before running (the default 'authenticated' role
-- cannot create tables).
--
-- After this file succeeds, also re-run supabase/place_order.sql
-- (it was updated to handle bundle line items).
-- ==========================================================

-- ---------- 1. Tables -----------------------------------------
CREATE TABLE IF NOT EXISTS public.bundles (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT        NOT NULL,
  description   TEXT,
  bundle_price  NUMERIC     NOT NULL CHECK (bundle_price >= 0),
  image_path    TEXT,
  is_active     BOOLEAN     NOT NULL DEFAULT true,
  badge         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.bundle_items (
  id          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  bundle_id   UUID    NOT NULL REFERENCES public.bundles(id) ON DELETE CASCADE,
  product_id  UUID    NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  quantity    INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  UNIQUE (bundle_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_bundle_items_bundle  ON public.bundle_items(bundle_id);
CREATE INDEX IF NOT EXISTS idx_bundle_items_product ON public.bundle_items(product_id);

-- ---------- 2. RLS ---------------------------------------------
ALTER TABLE public.bundles      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bundle_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "public_read_active_bundles" ON public.bundles;
CREATE POLICY "public_read_active_bundles"
  ON public.bundles FOR SELECT
  USING (is_active = true);

DROP POLICY IF EXISTS "admin_all_bundles" ON public.bundles;
CREATE POLICY "admin_all_bundles"
  ON public.bundles FOR ALL
  USING (public.is_admin()) WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "public_read_active_bundle_items" ON public.bundle_items;
CREATE POLICY "public_read_active_bundle_items"
  ON public.bundle_items FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.bundles b
       WHERE b.id = bundle_items.bundle_id
         AND b.is_active = true
    )
  );

DROP POLICY IF EXISTS "admin_all_bundle_items" ON public.bundle_items;
CREATE POLICY "admin_all_bundle_items"
  ON public.bundle_items FOR ALL
  USING (public.is_admin()) WITH CHECK (public.is_admin());

-- ---------- 3. Extend order_items for bundle line items --------
ALTER TABLE public.order_items
  ADD COLUMN IF NOT EXISTS bundle_id UUID REFERENCES public.bundles(id) ON DELETE SET NULL;

ALTER TABLE public.order_items
  ALTER COLUMN product_id DROP NOT NULL;

ALTER TABLE public.order_items
  DROP CONSTRAINT IF EXISTS order_items_product_or_bundle_chk;
ALTER TABLE public.order_items
  ADD  CONSTRAINT order_items_product_or_bundle_chk
       CHECK ((product_id IS NOT NULL)::int + (bundle_id IS NOT NULL)::int = 1);

CREATE INDEX IF NOT EXISTS idx_order_items_bundle ON public.order_items(bundle_id);

-- ==========================================================
-- DONE.
-- Now run supabase/place_order.sql to update the checkout RPC.
-- ==========================================================
