# Hams Arabian — Security Upgrade Runbook

This patch addresses the six findings in the security review.

## What changed

| # | Finding | Fix |
|---|---|---|
| 1 | Dashboard had no login enforcement | `hams-admin/index.html` + `app.js` now hide the sidebar and main content by default and only reveal them after Supabase auth + an `is_admin()` RPC check both succeed. |
| 2 | RLS used `authenticated`, so any signed-up user was effectively admin | `security-hardening.sql` rewrites `public.is_admin()` to compare `auth.uid()` against a **hardcoded UUID list** and re-grants every admin RLS policy through it. |
| 3 | Public order insertion can be abused | `supabase/place_order.sql` adds a `place_order` SECURITY DEFINER RPC that validates payload, recomputes `unit_price` server-side, locks product rows, decrements stock, and inserts customer + order + items in one transaction. Storefront calls only this RPC. |
| 4 | Stock not protected against concurrent orders | New RPC `decrement_product_stock(p_product_id, p_quantity)` does `SELECT … FOR UPDATE` then atomic `UPDATE`. Storefront should call this instead of plain UPDATE during checkout. |
| 5 | No payment protection | `protect_order_payment_fields` trigger blocks any non-admin session from changing `status` or `total_amount`. |
| 6 | Storage uploads were "any authenticated user" | Bucket policies now require `public.is_admin()` for INSERT/UPDATE/DELETE. Public read stays for the storefront. |

## Apply order

1. **Find your admin UUID(s).** In Supabase SQL Editor:
   ```sql
   select id, email from auth.users;
   ```
   Copy the `id` of every email that should be admin.

2. **Edit `supabase/security-hardening.sql`.** Replace the placeholder
   ```sql
   '00000000-0000-0000-0000-000000000000'::uuid
   ```
   with your real admin UUIDs (one per line, comma-separated).

3. **Run the migration** — paste the file into Supabase SQL Editor → Run.

4. **Verify in SQL Editor** while logged in as your admin:
   ```sql
   select public.is_admin();   -- expect: true
   ```

5. **Reload `hams-admin/index.html`.** You should see only the login
   screen — no flash of dashboard content. Sign in with your admin
   email; the dashboard should load. Sign in with any **non-admin**
   account — you should get *"This account is not authorized to access
   the admin dashboard"* and stay on the login screen.

## Storefront checkout — adopt the stock RPC

When the storefront places an order, replace any plain `update products set quantity = quantity - n` with:

```js
const { data, error } = await supabase.rpc('decrement_product_stock', {
  p_product_id: item.product_id,
  p_quantity:   item.quantity,
});
if (error) {
  // out of stock or product missing — abort the whole order
}
```

## Fix the failing checkout — apply `place_order.sql`

Symptom: storefront checkout shows *"Order failed: …"* / nothing
lands in `orders` in the admin dashboard.

Cause: `skincare-shop/app.js → submitOrder()` calls
`supabase.rpc('place_order', { … })`, but that function was never
created in the database (it was the skipped item 3 in the original
patch). PostgREST therefore returns
`function public.place_order(...) does not exist` (PGRST202).

Apply:

1. Confirm `customers.email` has a UNIQUE constraint (the new RPC
   upserts customers by email):
   ```sql
   -- only run if it's missing
   ALTER TABLE customers
     ADD CONSTRAINT customers_email_key UNIQUE (email);
   ```
2. Open Supabase Dashboard → SQL Editor.
3. Paste the contents of `supabase/place_order.sql` and click **Run**.
4. From the storefront, place a test order. It should succeed and
   appear in the admin dashboard's *Orders* tab.

What the function does (server-side, in one transaction):

1. Validates the payload (non-empty cart, name/email/phone/city/address).
2. Upserts the customer by email so repeat buyers are merged.
3. Locks each product row (`SELECT … FOR UPDATE`), pulls the
   authoritative `price` and `quantity`, and rejects the order if
   any line is short of stock.
4. Recomputes `unit_price` and `total_amount` server-side — the
   frontend's `unit_price` / `p_total` are ignored to prevent
   tampering.
5. Inserts `orders`, `order_items`, and decrements `products.quantity`.
6. Returns the new `order_id` UUID to the storefront.

Because it's `SECURITY DEFINER`, it bypasses the admin-only RLS
policies on `customers` / `orders` / `order_items` for anonymous
checkout — but only through this one validated entrypoint.
