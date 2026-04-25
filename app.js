/* ============================================================
   HAMS SKINCARE — App (Vanilla JS + Supabase)
   ============================================================ */
'use strict';

const SUPABASE_URL    = 'https://jsjyuffnyuebeprsfdfb.supabase.co';
const SUPABASE_KEY    = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Impzanl1ZmZueXVlYmVwcnNmZGZiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcwMzU5MTYsImV4cCI6MjA5MjYxMTkxNn0.-E6vFCrgpFZMfmFxBi0kUVwOSUh7ZAvzd6cpDOpszIQ';
const STORAGE_BUCKET  = 'product-images';

let sb;
if (typeof supabase !== 'undefined') {
  sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
}

let allProducts      = [];
let allCollections   = [];
let cart             = JSON.parse(localStorage.getItem('hams_cart')     || '[]');
let wishlist         = JSON.parse(localStorage.getItem('hams_wishlist') || '[]');
let currentView      = 'home';
let activeCollection = null;
let heroIndex        = 0;
let heroTimer        = null;
const HERO_TOTAL     = 3;

/* ── INIT ──────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', async () => {
  if (typeof supabase === 'undefined') {
    let retries = 0;
    const check = setInterval(() => {
      if (typeof supabase !== 'undefined' || retries > 10) {
        clearInterval(check);
        if (typeof supabase !== 'undefined') {
          sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
          initializeApp();
        } else { showToast('Database failed to load. Please refresh.', 8000); }
      }
      retries++;
    }, 100);
  } else { initializeApp(); }
});

function initializeApp() {
  // Replace the initial history state so popstate can restore it
  const initHash = location.hash.replace('#', '');
  if (initHash.startsWith('product-')) {
    history.replaceState({ view: 'product', productId: initHash.replace('product-', '') }, '', location.hash);
  } else if (initHash && ['home','collections','shop','about','contact'].includes(initHash)) {
    history.replaceState({ view: initHash }, '', location.hash);
  } else {
    history.replaceState({ view: 'home' }, '', location.hash || '#');
  }
  initHero();
  initNav();
  initScrollEffects();
  updateBadges();
  loadInitialData();
  handleHash(false);
}

async function loadInitialData() {
  if (!sb) return;
  await Promise.all([loadCollections(), loadProducts()]);
}

async function loadProducts() {
  if (!sb) { allProducts = []; renderHomeProducts(); renderShop(); return; }
  try {
    const { data, error } = await sb.from('products').select('*').order('created_at', { ascending: false });
    if (error) { showToast('Error loading products: ' + error.message, 5000); allProducts = []; }
    else {
      const { data: cols } = await sb.from('collections').select('id,name,description');
      const cmap = {};
      (cols || []).forEach(c => { cmap[c.id] = c; });
      allProducts = (data || []).map(p => ({
        ...p,
        collection: p.collection_id ? (cmap[p.collection_id]?.name || null) : null,
      }));
    }
  } catch(e) { allProducts = []; }
  renderHomeProducts();
  renderShop();
}

async function loadCollections() {
  if (!sb) { allCollections = []; renderHomeCollections(); renderFullCollections(); renderFilterTags(); return; }
  try {
    const { data, error } = await sb.from('collections').select('*').order('name');
    allCollections = error ? [] : (data || []);
  } catch(e) { allCollections = []; }
  renderHomeCollections();
  renderFullCollections();
  renderFilterTags();
}

/* ── RENDERS: COLLECTIONS ──────────────────────────────────── */
const FALLBACK_IMGS = [
  'https://images.unsplash.com/photo-1612817288484-6f916006741a?w=600&q=80',
  'https://images.unsplash.com/photo-1570194065650-d99fb4bedf0a?w=600&q=80',
  'https://images.unsplash.com/photo-1556228453-efd6c1ff04f6?w=600&q=80',
  'https://images.unsplash.com/photo-1522338242992-e1a54906a8da?w=600&q=80',
  'https://images.unsplash.com/photo-1596755389378-c31d21fd1273?w=600&q=80',
  'https://images.unsplash.com/photo-1515377905703-c4788e51af15?w=600&q=80',
  'https://images.unsplash.com/photo-1643185539104-3622eb1f0cfa?w=600&q=80',
  'https://images.unsplash.com/photo-1633681122994-6e4b8a26b1b3?w=600&q=80',
];

function renderHomeCollections() {
  renderCollectionsGrid('homeCollectionsGrid', allCollections.slice(0, 4));
}
function renderFullCollections() {
  renderCollectionsGrid('fullCollectionsGrid', allCollections);
}

function renderCollectionsGrid(containerId, collections) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!collections.length) { el.innerHTML = '<p class="empty-state">No collections yet.</p>'; return; }
  el.innerHTML = collections.map((c, i) => {
    const img   = FALLBACK_IMGS[i % FALLBACK_IMGS.length];
    const count = allProducts.filter(p => p.collection_id === c.id && p.is_active).length;
    return `
      <div class="collection-card fade-up" onclick="filterByCollection('${c.id}','${escHtml(c.name)}')">
        <div class="card-bg" style="position:absolute;inset:0;background-image:url('${img}');background-size:cover;background-position:center;transition:transform .6s cubic-bezier(.4,0,.2,1)"></div>
        <div class="collection-info">
          <span class="eyebrow">Collection</span>
          <h3>${escHtml(c.name)}</h3>
          <span class="collection-link">Shop ${count} product${count !== 1 ? 's' : ''}</span>
        </div>
      </div>`;
  }).join('');
  observeFadeUps();
}

/* ── RENDERS: PRODUCTS ─────────────────────────────────────── */
function getImgSrc(p) {
  if (!p.image_path) return 'https://images.unsplash.com/photo-1556228578-8c89e6adf883?w=500&q=80';
  if (p.image_path.startsWith('http')) return p.image_path;
  if (!sb) return 'https://images.unsplash.com/photo-1556228578-8c89e6adf883?w=500&q=80';
  return sb.storage.from(STORAGE_BUCKET).getPublicUrl(p.image_path).data.publicUrl;
}

function productCard(p) {
  const imgSrc     = getImgSrc(p);
  const isSoldOut  = p.badge === 'Sold Out' || p.quantity === 0;
  const inWishlist = wishlist.includes(p.id);
  const badgeClass = p.badge === 'NEW' ? 'new' : (p.badge === 'SALE' || p.badge === 'Sale') ? 'sale' : '';

  return `
    <div class="product-card fade-up" data-id="${p.id}">
      <div class="product-img" onclick="navigateToProduct('${p.id}')">
        <img src="${imgSrc}" alt="${escHtml(p.name)}" loading="lazy"
             onerror="this.src='https://images.unsplash.com/photo-1556228578-8c89e6adf883?w=500&q=80'" />
        ${p.badge ? `<span class="product-badge ${badgeClass}">${escHtml(p.badge)}</span>` : ''}
        <div class="product-actions-overlay">
          <button class="quick-action-btn ${inWishlist ? 'wishlisted' : ''}" onclick="toggleWishlist('${p.id}',event)" title="Wishlist">
            <svg viewBox="0 0 24 24" fill="${inWishlist ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.5"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
          </button>
        </div>
      </div>
      <div class="product-info" onclick="navigateToProduct('${p.id}')">
        <div class="product-collection">${escHtml(p.collection || 'Skincare')}</div>
        <div class="product-name">${escHtml(p.name)}</div>
        ${p.description ? `<div class="product-desc">${escHtml(p.description).substring(0, 70)}…</div>` : ''}
        <div class="product-price-row">
          <span class="product-price">KWD ${Number(p.price).toFixed(3)}</span>
          <div style="display:flex;align-items:center;gap:8px">
            <span class="product-stars">★★★★★</span>
            ${isSoldOut
              ? `<button class="add-to-cart-btn" disabled style="opacity:.4;cursor:not-allowed" title="Sold Out">
                   <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                 </button>`
              : `<button class="add-to-cart-btn" onclick="addToCart('${p.id}',event)" title="Add to Cart">
                   <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                 </button>`
            }
          </div>
        </div>
      </div>
    </div>`;
}

function renderProductsGrid(containerId, products) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!products.length) { el.innerHTML = '<p class="empty-state" style="grid-column:1/-1">No products found.</p>'; return; }
  el.innerHTML = products.map(productCard).join('');
  observeFadeUps();
}

function renderProductsSlider(containerId, products) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!products.length) { el.innerHTML = '<p class="empty-state">No products yet.</p>'; return; }
  el.innerHTML = products.map(productCard).join('');
  observeFadeUps();
}

function renderHomeProducts() {
  renderProductsGrid('monthlyOffersGrid',   allProducts.filter(p => p.is_active).slice(0, 8));
  renderProductsSlider('bestSellersSlider', allProducts.filter(p => p.is_active).slice(0, 8));
  renderProductsGrid('topRatedGrid',        allProducts.filter(p => p.is_active).slice(0, 4));
}

/* ── SHOP ──────────────────────────────────────────────────── */
function renderFilterTags() {
  const el = document.getElementById('filterTags');
  if (!el) return;
  const all = `<button class="filter-tag active" onclick="setFilter(null,this)">All</button>`;
  const tags = allCollections.map(c =>
    `<button class="filter-tag" onclick="setFilter('${c.id}',this)">${escHtml(c.name)}</button>`
  ).join('');
  el.innerHTML = all + tags;
}

function setFilter(collectionId, btn) {
  document.querySelectorAll('.filter-tag').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  activeCollection = collectionId;
  renderShop();
}

function renderShop() {
  let products = allProducts.filter(p => p.is_active);
  if (activeCollection) products = products.filter(p => p.collection_id === activeCollection);
  const sort = document.getElementById('sortSelect')?.value || 'default';
  if (sort === 'price-asc')  products.sort((a,b) => Number(a.price) - Number(b.price));
  if (sort === 'price-desc') products.sort((a,b) => Number(b.price) - Number(a.price));
  if (sort === 'name-asc')   products.sort((a,b) => a.name.localeCompare(b.name));
  renderProductsGrid('shopGrid', products);
}

function filterByCollection(collectionId, name) {
  document.getElementById('shopTitle').textContent    = name;
  document.getElementById('shopSubtitle').textContent = 'Explore the ' + name + ' collection';
  activeCollection = collectionId;
  navigateTo('shop');
  renderShop();
  // Update filter tags UI
  document.querySelectorAll('.filter-tag').forEach(t => {
    t.classList.toggle('active', t.textContent.trim() === name);
  });
}

/* ── PRODUCT DETAIL ────────────────────────────────────────── */
function renderProductDetail(p) {
  const container = document.getElementById('productDetailContent');
  if (!container) return;
  const imgSrc     = getImgSrc(p);
  const isSoldOut  = p.badge === 'Sold Out' || p.quantity === 0;
  const inWishlist = wishlist.includes(p.id);
  container.innerHTML = `
    <div class="product-detail-back">
      <button class="product-back-btn" onclick="navigateTo('${prevView}')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M19 12H5"/><path d="m12 5-7 7 7 7"/></svg>
        Back
      </button>
    </div>
    <div class="product-detail-grid">
      <div class="product-detail-image">
        <img src="${imgSrc}" alt="${escHtml(p.name)}" />
        ${p.badge ? `<span class="product-badge" style="position:absolute;top:16px;left:16px">${escHtml(p.badge)}</span>` : ''}
      </div>
      <div class="product-detail-info">
        <div class="product-detail-collection">${escHtml(p.collection || 'Professional Skincare')}</div>
        <h1 class="product-detail-name">${escHtml(p.name)}</h1>
        <div class="product-detail-price">KWD ${Number(p.price).toFixed(3)}</div>
        <div class="product-detail-stars">★★★★★</div>
        ${p.description ? `<div class="product-detail-description">${escHtml(p.description)}</div>` : ''}
        <div class="product-detail-actions">
          ${isSoldOut
            ? '<button class="btn-primary" disabled style="opacity:.5;cursor:not-allowed">Sold Out</button>'
            : `<button class="btn-primary" onclick="addToCart('${p.id}',event)">Add to Cart</button>`
          }
          <button class="product-detail-actions wishlist-add-btn" onclick="toggleWishlist('${p.id}',event)" title="Wishlist" style="width:48px;height:48px;border-radius:2px;background:var(--off-white);border:1.5px solid var(--border);display:flex;align-items:center;justify-content:center;transition:var(--transition);cursor:pointer">
            <svg viewBox="0 0 24 24" fill="${inWishlist ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.5" style="width:19px;height:19px;color:var(--text-muted)"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
          </button>
        </div>
        ${p.collection_id ? `
        <div class="product-detail-collection-link">
          <a href="#" onclick="filterByCollection('${p.collection_id}','${escHtml(p.collection)}'); return false;">
            ← View all ${escHtml(p.collection)} products
          </a>
        </div>` : ''}
      </div>
    </div>`;
}

/* ── NAVIGATION ────────────────────────────────────────────── */
function navigateTo(view, pushState = true) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + view)?.classList.add('active');
  document.querySelectorAll('.nav-link').forEach(l => {
    l.classList.toggle('active', l.dataset.view === view);
  });
  currentView = view;
  closeMenu();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (pushState) {
    const hash = view === 'home' ? '#' : '#' + view;
    history.pushState({ view }, '', hash);
  }
  if (view === 'shop' && !activeCollection) {
    document.getElementById('shopTitle').textContent    = 'All Products';
    document.getElementById('shopSubtitle').textContent = 'Discover our full range of skincare';
  }
  observeFadeUps();
}

/* ── PRODUCT NAVIGATION ─────────────────────────────────────── */
let prevView = 'home';

function navigateToProduct(productId, pushState = true) {
  const product = allProducts.find(p => p.id === productId);
  if (!product) return;
  prevView = currentView === 'product' ? prevView : currentView;
  currentView = 'product';
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-product')?.classList.add('active');
  document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
  renderProductDetail(product);
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (pushState) {
    history.pushState({ view: 'product', productId }, '', '#product-' + productId);
  }
}

/* ── POPSTATE — browser back/forward ───────────────────────── */
window.addEventListener('popstate', (e) => {
  const state = e.state;
  if (state) {
    if (state.view === 'product' && state.productId) {
      navigateToProduct(state.productId, false);
    } else if (state.view) {
      navigateTo(state.view, false);
    } else {
      navigateTo('home', false);
    }
  } else {
    // No state: parse the hash
    handleHash(false);
  }
});

function handleHash(pushState = true) {
  const hash = location.hash.replace('#', '');
  if (hash.startsWith('product-')) {
    const productId = hash.replace('product-', '');
    if (allProducts.length > 0) {
      navigateToProduct(productId, pushState);
    } else {
      const wait = setInterval(() => {
        if (allProducts.length > 0) {
          clearInterval(wait);
          navigateToProduct(productId, pushState);
        }
      }, 100);
      setTimeout(() => clearInterval(wait), 5000);
    }
  } else if (hash && ['home','collections','shop','about','contact'].includes(hash)) {
    navigateTo(hash, pushState);
  } else {
    navigateTo('home', pushState);
  }
}

document.querySelectorAll('.nav-link, .logo').forEach(el => {
  el.addEventListener('click', e => {
    e.preventDefault();
    navigateTo(el.dataset.view || 'home');
  });
});

/* ── NAVBAR ────────────────────────────────────────────────── */
function initNav() {
  const hamburger = document.getElementById('hamburger');
  const navLinks = document.getElementById('navLinks');
  hamburger.addEventListener('click', () => {
    navLinks.classList.toggle('open');
    document.getElementById('mobileOverlay').classList.toggle('active');
    const open = navLinks.classList.contains('open');
    hamburger.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  document.getElementById('mobileOverlay').addEventListener('click', closeMenu);
  document.getElementById('searchToggle').addEventListener('click', toggleSearch);
}
function closeMenu() {
  document.getElementById('navLinks').classList.remove('open');
  document.getElementById('mobileOverlay').classList.remove('active');
  const hb = document.getElementById('hamburger');
  if (hb) hb.setAttribute('aria-expanded', 'false');
}
function toggleSearch() {
  document.getElementById('searchBar').classList.toggle('open');
  if (document.getElementById('searchBar').classList.contains('open')) {
    setTimeout(() => document.getElementById('searchInput').focus(), 100);
  }
}
function closeSearch() {
  document.getElementById('searchBar').classList.remove('open');
}

document.getElementById('searchInput').addEventListener('input', e => {
  const q = e.target.value.toLowerCase().trim();
  if (!q) return;
  const results = allProducts.filter(p =>
    p.name.toLowerCase().includes(q) ||
    (p.collection || '').toLowerCase().includes(q) ||
    (p.description || '').toLowerCase().includes(q)
  );
  activeCollection = null;
  navigateTo('shop');
  document.getElementById('shopTitle').textContent    = `Results for "${q}"`;
  document.getElementById('shopSubtitle').textContent = `${results.length} product${results.length !== 1 ? 's' : ''} found`;
  renderProductsGrid('shopGrid', results);
});

/* ── HERO ──────────────────────────────────────────────────── */
function initHero() {
  const dotsEl = document.getElementById('heroDots');
  for (let i = 0; i < HERO_TOTAL; i++) {
    const dot = document.createElement('button');
    dot.className = 'hero-dot' + (i === 0 ? ' active' : '');
    dot.setAttribute('aria-label', 'Slide ' + (i+1));
    dot.addEventListener('click', () => goToSlide(i));
    dotsEl.appendChild(dot);
  }
  startHeroTimer();
}
function goToSlide(idx) {
  heroIndex = (idx + HERO_TOTAL) % HERO_TOTAL;
  document.getElementById('heroSlides').style.transform = 'translateX(-' + (heroIndex * 100) + '%)';
  document.querySelectorAll('.hero-dot').forEach((d, i) => d.classList.toggle('active', i === heroIndex));
  resetHeroTimer();
}
function slideHero(dir) { goToSlide(heroIndex + dir); }
function startHeroTimer() { heroTimer = setInterval(() => goToSlide(heroIndex + 1), 5500); }
function resetHeroTimer() { clearInterval(heroTimer); startHeroTimer(); }

/* ── CART ──────────────────────────────────────────────────── */
document.getElementById('cartToggle').addEventListener('click', openCart);
document.getElementById('cartOverlay').addEventListener('click', closeCart);

function openCart() {
  document.getElementById('cartDrawer').classList.add('open');
  document.getElementById('cartOverlay').classList.add('active');
  renderCartDrawer();
}
function closeCart() {
  document.getElementById('cartDrawer').classList.remove('open');
  document.getElementById('cartOverlay').classList.remove('active');
}
function addToCart(productId, e) {
  if (e) e.stopPropagation();
  const product = allProducts.find(p => p.id === productId);
  if (!product || product.quantity === 0) return;
  const existing = cart.find(i => i.id === productId);
  if (existing) existing.qty += 1;
  else cart.push({ id: productId, qty: 1 });
  saveCart(); updateBadges();
  showToast(product.name + ' added to cart');
}
function removeFromCart(productId) {
  cart = cart.filter(i => i.id !== productId);
  saveCart(); updateBadges(); renderCartDrawer();
}
function changeQty(productId, delta) {
  const item = cart.find(i => i.id === productId);
  if (!item) return;
  item.qty = Math.max(1, item.qty + delta);
  saveCart(); updateBadges(); renderCartDrawer();
}
function saveCart() { localStorage.setItem('hams_cart', JSON.stringify(cart)); }
function cartTotal() {
  return cart.reduce((sum, item) => {
    const p = allProducts.find(pr => pr.id === item.id);
    return sum + (p ? Number(p.price) * item.qty : 0);
  }, 0);
}
function renderCartDrawer() {
  const body   = document.getElementById('cartBody');
  const footer = document.getElementById('cartFooter');
  if (!cart.length) {
    body.innerHTML = `<div class="cart-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>
      <p>Your cart is empty</p>
      <button class="btn-primary" onclick="closeCart()">Continue Shopping</button>
    </div>`;
    footer.style.display = 'none'; return;
  }
  body.innerHTML = cart.map(item => {
    const p = allProducts.find(pr => pr.id === item.id);
    if (!p) return '';
    const img = getImgSrc(p);
    return `<div class="cart-item">
      <div class="cart-item-img"><img src="${img}" alt="${escHtml(p.name)}" /></div>
      <div class="cart-item-info">
        <div class="cart-item-name">${escHtml(p.name)}</div>
        <div class="cart-item-price">KWD ${Number(p.price).toFixed(3)}</div>
        <div class="cart-item-qty">
          <button class="qty-btn" onclick="changeQty('${p.id}',-1)">−</button>
          <span>${item.qty}</span>
          <button class="qty-btn" onclick="changeQty('${p.id}',1)">+</button>
        </div>
      </div>
      <button class="cart-item-remove" onclick="removeFromCart('${p.id}')" title="Remove">✕</button>
    </div>`;
  }).join('');
  document.getElementById('cartTotal').textContent = 'KWD ' + cartTotal().toFixed(3);
  footer.style.display = 'block';
}
function updateBadges() {
  const totalQty = cart.reduce((s, i) => s + i.qty, 0);
  document.getElementById('cartBadge').textContent     = totalQty;
  document.getElementById('wishlistBadge').textContent = wishlist.length;
}

/* ── WISHLIST ──────────────────────────────────────────────── */
function toggleWishlist(productId, e) {
  if (e) e.stopPropagation();
  const idx = wishlist.indexOf(productId);
  if (idx === -1) { wishlist.push(productId); showToast('Added to wishlist'); }
  else            { wishlist.splice(idx, 1);  showToast('Removed from wishlist'); }
  localStorage.setItem('hams_wishlist', JSON.stringify(wishlist));
  updateBadges();
}

/* ── CHECKOUT ──────────────────────────────────────────────── */
function showCheckout() {
  closeCart();
  document.getElementById('checkoutOverlay').style.display = 'flex';
  const summary = document.getElementById('orderSummaryMini');
  const items = cart.map(item => {
    const p = allProducts.find(pr => pr.id === item.id);
    return p ? `<div class="mini-item"><span>${escHtml(p.name)} × ${item.qty}</span><span>KWD ${(Number(p.price) * item.qty).toFixed(3)}</span></div>` : '';
  }).join('');
  summary.innerHTML = items + `<div class="mini-total"><span>Total</span><span>KWD ${cartTotal().toFixed(3)}</span></div>`;
}
function closeCheckout() { document.getElementById('checkoutOverlay').style.display = 'none'; }

async function submitOrder(e) {
  e.preventDefault();
  const form = e.target;
  if (!sb) { showToast('Database not available.'); return; }
  const { data: customer, error: custErr } = await sb.from('customers')
    .insert({ name: form.name.value, email: form.email.value, phone: form.phone.value })
    .select().single();
  if (custErr) { showToast('Order failed: ' + custErr.message); return; }
  const { data: order, error: orderErr } = await sb.from('orders')
    .insert({ customer_id: customer.id, status: 'pending',
      shipping_address: { city: form.city.value, address: form.address.value },
      total_amount: cartTotal(), notes: form.notes?.value || null })
    .select().single();
  if (orderErr) { showToast('Order failed: ' + orderErr.message); return; }
  await sb.from('order_items').insert(cart.map(item => {
    const p = allProducts.find(pr => pr.id === item.id);
    return { order_id: order.id, product_id: item.id, quantity: item.qty, unit_price: Number(p?.price || 0) };
  }));
  cart = []; saveCart(); updateBadges(); closeCheckout();
  document.getElementById('successOverlay').style.display = 'flex';
}
function closeSuccess() {
  document.getElementById('successOverlay').style.display = 'none';
  navigateTo('home');
}

/* ── CONTACT / NEWSLETTER ──────────────────────────────────── */
function submitContact(e) { e.preventDefault(); showToast("Message sent! We'll get back to you soon."); e.target.reset(); }
function subscribeNewsletter(e) { e.preventDefault(); showToast("You're subscribed! Welcome to Hams."); e.target.reset(); }

/* ── SCROLL / ANIMATIONS ───────────────────────────────────── */
function initScrollEffects() {
  const navbar    = document.getElementById('navbar');
  const backToTop = document.getElementById('backToTop');
  window.addEventListener('scroll', () => {
    navbar.classList.toggle('scrolled', window.scrollY > 40);
    backToTop.classList.toggle('visible', window.scrollY > 400);
  }, { passive: true });
  observeFadeUps();
}
function observeFadeUps() {
  const io = new IntersectionObserver(entries => {
    entries.forEach(en => { if (en.isIntersecting) { en.target.classList.add('visible'); io.unobserve(en.target); } });
  }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });
  document.querySelectorAll('.fade-up:not(.visible)').forEach(el => io.observe(el));
}
function scrollProductSlider(id, dir) {
  document.getElementById(id)?.scrollBy({ left: dir * 290, behavior: 'smooth' });
}

/* ── TOAST ─────────────────────────────────────────────────── */
let toastTimer;
function showToast(message, duration = 3000) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), duration);
}

/* ── UTILS ─────────────────────────────────────────────────── */
function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}