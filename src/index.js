import { isReturnPayload, planReturn } from './returns.js';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import QRCode from 'qrcode';
import bwipjs from 'bwip-js';
import { initDb, closeDb, db, nowIso, normalizePhone, randomToken, getOrCreateClientFromTelegram, createSession, getClientBySession, getSetting, awardStars, hashPassword, verifyPassword, getClientAvailableStars, getReservedStars, logAudit, generateCardNumber } from './db.js';
import { verifyTelegramInitData } from './telegram.js';
import { startStarClubBot } from './bot.js';

dotenv.config();
await initDb();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = Number(process.env.PORT || 3000);

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(cors());
app.use(express.json({ limit: '16mb' }));
app.use(morgan('dev'));
app.use(express.static(path.join(__dirname, '..', 'public')));

function parseCsvEnv(name) {
  return String(process.env[name] || '').split(',').map((v) => v.trim()).filter(Boolean);
}

function getAdminBySession(token) {
  if (!token) return null;
  return db.prepare(`SELECT a.* FROM admin_sessions s JOIN admin_users a ON a.id = s.admin_user_id
    WHERE s.token = ? AND s.expires_at > ? AND a.is_active = 1`).get(token, nowIso()) || null;
}

function isOpenDesktopAdminRequest(req) {
  const enabled = String(process.env.ADMIN_DESKTOP_OPEN || '').trim().toLowerCase() === 'true';
  if (!enabled) return false;
  if (req.header('x-starclub-admin-desktop') !== '1') return false;

  const requestHost = String(req.get('host') || '').toLowerCase();
  const origin = req.get('origin');
  const referer = req.get('referer');

  try {
    if (origin && new URL(origin).host.toLowerCase() !== requestHost) return false;
    if (referer && new URL(referer).host.toLowerCase() !== requestHost) return false;
  } catch {
    return false;
  }

  return true;
}

function adminAuth(req, res, next) {
  // Desktop admin is always protected. Password/API-key/Telegram session is required.

  const expected = process.env.ADMIN_API_KEY || 'change-this-admin-key';
  const key = req.header('x-admin-key') || req.query.admin_key;
  if (key && key === expected) {
    req.admin = { id: 0, telegram_id: 'api-key', name: 'Owner API key', role: 'owner', permissions_json: null };
    return next();
  }
  const header = req.header('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.query.admin_session;
  const admin = getAdminBySession(token);
  if (!admin) return res.status(401).json({ ok: false, error: 'ADMIN_UNAUTHORIZED' });
  req.admin = admin;
  if (admin.role !== 'owner') {
    let permissions = [];
    try { permissions = admin.permissions_json ? JSON.parse(admin.permissions_json) : []; } catch {}
    const path = req.path;
    const permission = path.includes('/personal-coupons') || path.includes('/coupons') ? 'coupons'
      : path.includes('/clients') ? 'clients'
      : path.includes('/stores') ? 'stores'
      : path.includes('/catalog/rewards') || path.includes('/catalog/star-exclusions') ? 'rewards'
      : path.includes('/catalog/offers') || path.includes('/catalog/promo-offers') || path.includes('/catalog/pricing') || path.includes('/catalog/products') || path.includes('/catalog/product-groups') ? 'offers'
      : path.includes('/catalog/challenges') ? 'challenges'
      : path.includes('/catalog/stamps') ? 'stamps'
      : path.includes('/catalog/banners') ? 'news'
      : path.includes('/catalog/news') ? 'news'
      : path.includes('/reward-qrs') ? 'qrs'
      : path.includes('/support') ? 'support'
      : path.includes('/settings') ? 'settings'
      : path.includes('/audit') ? 'audit'
      : path.includes('/summary') ? 'dashboard'
      : null;
    if (permission && !permissions.includes(permission)) {
      return res.status(403).json({ ok: false, error: 'ADMIN_PERMISSION_DENIED', permission });
    }
  }
  next();
}

function ownerAuth(req, res, next) {
  return adminAuth(req, res, () => {
    if (req.admin?.role !== 'owner') return res.status(403).json({ ok: false, error: 'OWNER_REQUIRED' });
    next();
  });
}

function oneCAuth(req, res, next) {
  const expected = process.env.ONE_C_API_TOKEN || 'change-this-1c-token';
  const got = req.header('x-starclub-token') || req.query.token;
  if (!got || got !== expected) return res.status(401).json({ ok: false, error: 'ONE_C_UNAUTHORIZED' });
  next();
}

function clientAuth(req, res, next) {
  const header = req.header('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.query.session;
  const client = getClientBySession(token);
  if (!client) return res.status(401).json({ ok: false, error: 'CLIENT_UNAUTHORIZED' });
  if (client.is_blocked) return res.status(403).json({ ok: false, error: 'CLIENT_BLOCKED' });
  req.client = client;
  next();
}

function optionalClientAuth(req, res, next) {
  const header = req.header('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.query.session;
  const client = getClientBySession(token);
  if (client && !client.is_blocked) req.client = client;
  next();
}


function formatAdmin(admin) {
  let permissions = [];
  try { permissions = admin?.permissions_json ? JSON.parse(admin.permissions_json) : []; } catch {}
  return admin ? {
    id: admin.id,
    telegram_id: admin.telegram_id,
    name: admin.name,
    username: admin.username,
    login: admin.login || null,
    role: admin.role,
    permissions,
    is_active: Boolean(admin.is_active)
  } : null;
}

function createAdminSession(adminId) {
  const token = randomToken('adm_');
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();
  db.prepare('INSERT INTO admin_sessions(token, admin_user_id, created_at, expires_at) VALUES(?, ?, ?, ?)')
    .run(token, adminId, nowIso(), expiresAt);
  return { token, expires_at: expiresAt };
}

function ensureDesktopOwnerCredentials() {
  const login = String(process.env.ADMIN_OWNER_LOGIN || 'owner').trim();
  const password = String(process.env.ADMIN_OWNER_PASSWORD || 'StarClub2026!');
  if (!login || password.length < 6) {
    throw new Error('ADMIN_OWNER_LOGIN/ADMIN_OWNER_PASSWORD are invalid');
  }

  const now = nowIso();
  const passwordHash = hashPassword(password);
  let owner = db.prepare('SELECT * FROM admin_users WHERE login = ?').get(login);

  if (!owner) {
    owner = db.prepare("SELECT * FROM admin_users WHERE role = 'owner' ORDER BY id LIMIT 1").get();
  }

  if (owner) {
    db.prepare(`UPDATE admin_users
      SET role = 'owner', permissions_json = '[]', login = ?, password_hash = ?,
          password_set_at = ?, is_active = 1, updated_at = ?
      WHERE id = ?`)
      .run(login, passwordHash, now, now, owner.id);
  } else {
    db.prepare(`INSERT INTO admin_users(
      telegram_id, name, username, role, permissions_json, login,
      password_hash, password_set_at, is_active, created_at, updated_at
    ) VALUES(?, ?, NULL, 'owner', '[]', ?, ?, ?, 1, ?, ?)`)
      .run(`webadmin:${login}`, 'Owner', login, passwordHash, now, now, now);
  }
}

ensureDesktopOwnerCredentials();


function money(cents) {
  return Math.round(Number(cents || 0)) / 100;
}

function formatClient(client) {
  if (!client) return null;
  const bonus = getProfileBonusConfig();
  const required = bonus.requiredFields;
  const completed = required.filter((key) => Boolean(client[key])).length;
  const reserved = getReservedStars(client.id);
  return {
    id: client.id,
    telegram_id: client.telegram_id,
    phone: client.phone,
    name: client.name,
    birth_date: client.birth_date,
    favorite_store: client.favorite_store,
    email: client.email,
    marketing_allowed: Boolean(client.marketing_allowed),
    consents: {
      rules: Boolean(client.consent_rules_at),
      personal_data: Boolean(client.consent_personal_data_at),
      phone: Boolean(client.consent_phone_at),
      version: client.consent_version || null
    },
    preferences: client.preferences ? JSON.parse(client.preferences) : [],
    card_number: client.card_number,
    card_token: client.card_token,
    stars_balance: Number(client.stars_balance || 0),
    reserved_stars: reserved,
    available_stars: Math.max(0, Number(client.stars_balance || 0) - reserved),
    profile_bonus_awarded: Boolean(client.profile_bonus_awarded),
    password_set: Boolean(client.password_hash),
    registered: Boolean(client.phone && client.name && client.birth_date && client.favorite_store && client.password_hash),
    profile_progress: {
      completed,
      total: required.length,
      percent: required.length ? Math.round((completed / required.length) * 100) : 100,
      required_fields: required,
      bonus
    },
    registered_at: client.registered_at,
    last_purchase_at: client.last_purchase_at
  };
}

function getPeriodKey(periodType, date = new Date()) {
  const d = new Date(date);
  if (periodType === 'month') return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const firstJan = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - firstJan) / 86400000) + firstJan.getUTCDay() + 1) / 7);
  return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

function getAdminStarAccrualExclusionSet() {
  const rows = db.prepare('SELECT product_external_id FROM star_accrual_exclusions').all();
  return new Set(rows.map((row) => normalizeOneCCode(row.product_external_id)).filter(Boolean));
}

function getStarAccrualGroupExclusionSet() {
  const rows = db.prepare('SELECT group_external_id FROM star_accrual_group_exclusions').all();
  return new Set(rows.map((row) => normalizeOneCCode(row.group_external_id)).filter(Boolean));
}

function itemMatchesExcludedGroup(item = {}, excludedGroups = null) {
  const groups = excludedGroups || getStarAccrualGroupExclusionSet();
  if (!groups.size) return false;

  const candidates = [
    item.group_external_id,
    item.group_id,
    item.category_external_id
  ];

  if (Array.isArray(item.group_path)) candidates.push(...item.group_path);
  if (Array.isArray(item.group_path_ids)) candidates.push(...item.group_path_ids);

  return candidates
    .map((value) => normalizeOneCCode(value))
    .filter(Boolean)
    .some((code) => groups.has(code));
}

function getItemExternalProductCode(item = {}) {
  return normalizeOneCCode(
    item.external_product_id ?? item.product_external_id ?? item.external_id ?? item.product_id ?? item.id ?? ''
  );
}

function isItemExcludedFromStarAccrual(item = {}, adminExcludedCodes = null, adminExcludedGroups = null) {
  const flags = item.flags || item;
  if (flags.is_alcohol || flags.is_tobacco || flags.is_min_margin || flags.no_star_accrual) return true;
  const code = getItemExternalProductCode(item);
  const excludedCodes = adminExcludedCodes || getAdminStarAccrualExclusionSet();
  const excludedGroups = adminExcludedGroups || getStarAccrualGroupExclusionSet();
  return Boolean((code && excludedCodes.has(code)) || itemMatchesExcludedGroup(item, excludedGroups));
}

function receiptHasEligibleItems(items = []) {
  const adminExcludedCodes = getAdminStarAccrualExclusionSet();
  const adminExcludedGroups = getStarAccrualGroupExclusionSet();
  return items.some((item) => !isItemExcludedFromStarAccrual(item, adminExcludedCodes, adminExcludedGroups));
}

function calculateEligibleCents(items = [], explicitEligible) {
  const adminExcludedCodes = getAdminStarAccrualExclusionSet();
  const adminExcludedGroups = getStarAccrualGroupExclusionSet();
  const explicit = Number.isFinite(Number(explicitEligible)) ? Math.max(0, Math.round(Number(explicitEligible))) : null;

  if (explicit !== null) {
    let adjusted = explicit;
    for (const item of items) {
      const flags = item.flags || item;
      const excludedByReceiptFlags = Boolean(flags.is_alcohol || flags.is_tobacco || flags.is_min_margin || flags.no_star_accrual);
      const code = getItemExternalProductCode(item);
      if (!excludedByReceiptFlags && ((code && adminExcludedCodes.has(code)) || itemMatchesExcludedGroup(item, adminExcludedGroups))) {
        adjusted -= Math.round(Number(item.line_total_cents ?? item.total_cents ?? item.sum_cents ?? 0));
      }
    }
    return Math.max(0, adjusted);
  }

  return items.reduce((sum, item) => {
    const excluded = isItemExcludedFromStarAccrual(item, adminExcludedCodes, adminExcludedGroups);
    return excluded ? sum : sum + Math.round(Number(item.line_total_cents ?? item.total_cents ?? item.sum_cents ?? 0));
  }, 0);
}

function normalizeMatchValue(value) {
  return String(value || '').trim().toLowerCase();
}

// Коди товарів і груп 1С у цій конфігурації мають однаковий формат,
// наприклад ЦБ000004323. Тип цілі (product/group) передається окремо,
// а сам код зберігаємо як непрозорий ідентифікатор без припущень про префікс.
function normalizeOneCCode(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
}

// 1С може передати магазин у трьох формах: код, зовнішній код або текстове
// представлення посилання (назву). Синхронізація зберігає код, тому старі
// касові модулі, які надсилали назву, треба безпечно звести до того самого id.
function findStoreByIdentity(value) {
  const raw = String(value || '').normalize('NFKC').trim();
  if (!raw) return null;
  const normalized = normalizeOneCCode(raw);

  const exact = db.prepare(`SELECT * FROM stores
    WHERE is_active = 1
      AND (id = ? OR external_id = ? OR id = ? OR external_id = ?)
    LIMIT 1`).get(raw, raw, normalized, normalized);
  if (exact) return exact;

  // Назву використовуємо тільки коли вона однозначно вказує на один магазин.
  const matches = db.prepare('SELECT * FROM stores WHERE is_active = 1').all()
    .filter((store) => normalizeOneCCode(store.name) === normalized);
  return matches.length === 1 ? matches[0] : null;
}

function findStoreFromPayload(payload = {}) {
  for (const value of [payload.store_external_id, payload.store_id, payload.store_name]) {
    const store = findStoreByIdentity(value);
    if (store) return store;
  }
  return null;
}

function canonicalStoreId(value) {
  const store = findStoreByIdentity(value);
  return String(store?.id || value || '').trim();
}

function storeMatchesOffer(offerStoreId, requestedStoreId) {
  const ruleId = String(offerStoreId || 'all').trim();
  if (!ruleId || ruleId === 'all') return true;

  const ruleStore = findStoreByIdentity(ruleId);
  const requestedStore = findStoreByIdentity(requestedStoreId);
  if (ruleStore && requestedStore) return String(ruleStore.id) === String(requestedStore.id);

  return Boolean(requestedStoreId)
    && normalizeOneCCode(ruleId) === normalizeOneCCode(requestedStoreId);
}

function normalizeImageUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '/assets/star.svg';
  if (raw.startsWith('/')) return raw;
  if (/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(raw) && raw.length <= 1_500_000) return raw;

  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return '/assets/star.svg';

    if (url.hostname === 'drive.google.com') {
      const fileMatch = url.pathname.match(/\/file\/d\/([^/]+)/);
      const id = fileMatch?.[1] || url.searchParams.get('id');
      if (id) return `https://drive.google.com/thumbnail?id=${encodeURIComponent(id)}&sz=w1600`;
    }

    if (url.hostname.endsWith('dropbox.com')) {
      url.searchParams.delete('dl');
      url.searchParams.set('raw', '1');
      return url.toString();
    }

    return url.toString();
  } catch {
    return '/assets/star.svg';
  }
}

function parseItemGroupPath(item) {
  if (Array.isArray(item.group_path)) {
    return item.group_path.map(normalizeMatchValue).filter(Boolean);
  }
  if (item.group_path_json) {
    try {
      const parsed = JSON.parse(item.group_path_json);
      return Array.isArray(parsed) ? parsed.map(normalizeMatchValue).filter(Boolean) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function getOfferTargetType(offer) {
  if (offer?.target_type) return String(offer.target_type);
  if (offer?.product_external_id) return 'product';
  if (offer?.category) return 'group';
  return 'all';
}

function getOfferTargetValue(offer) {
  return String(offer?.target_value || offer?.product_external_id || offer?.category || '');
}

function parseCodeArray(value) {
  if (Array.isArray(value)) return value.map(normalizeOneCCode).filter(Boolean);
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.map(normalizeOneCCode).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function catalogProductByAnyCode(value) {
  const code = normalizeOneCCode(value);
  if (!code) return null;
  return db.prepare(`SELECT external_id, id, group_external_id, group_path_json
    FROM products
    WHERE external_id = ? OR id = ?
    LIMIT 1`).get(code, code) || null;
}

function itemProductCodes(item) {
  const values = [
    item?.external_product_id,
    item?.product_id,
    item?.external_id,
    item?.code,
    item?.product_code,
    item?.one_c_code
  ];
  const result = new Set(values.map(normalizeOneCCode).filter(Boolean));

  for (const value of [...result]) {
    const product = catalogProductByAnyCode(value);
    if (product?.external_id) result.add(normalizeOneCCode(product.external_id));
    if (product?.id) result.add(normalizeOneCCode(product.id));
  }

  return result;
}

function itemGroupCodes(item) {
  const result = new Set([
    normalizeOneCCode(item?.group_external_id),
    normalizeOneCCode(item?.group_id),
    ...parseCodeArray(item?.group_path),
    ...parseCodeArray(item?.group_path_json)
  ].filter(Boolean));

  for (const productCode of itemProductCodes(item)) {
    const product = catalogProductByAnyCode(productCode);
    if (!product) continue;
    if (product.group_external_id) result.add(normalizeOneCCode(product.group_external_id));
    for (const groupCode of parseCodeArray(product.group_path_json)) result.add(groupCode);
  }

  return result;
}

function offerMatchesItem(offer, item) {
  const targetType = getOfferTargetType(offer);
  const rawTarget = getOfferTargetValue(offer);

  if (targetType === 'all') return true;
  if (!rawTarget) return false;

  let targetCode = normalizeOneCCode(rawTarget);

  if (targetType === 'product') {
    const storedProduct = catalogProductByAnyCode(targetCode);
    if (storedProduct?.external_id) targetCode = normalizeOneCCode(storedProduct.external_id);
    return itemProductCodes(item).has(targetCode);
  }

  if (targetType === 'group') {
    return itemGroupCodes(item).has(targetCode);
  }

  // Старі текстові категорії залишаємо сумісними.
  if (targetType === 'category') {
    return normalizeMatchValue(item?.category) === normalizeMatchValue(rawTarget)
      || normalizeMatchValue(item?.group_name) === normalizeMatchValue(rawTarget);
  }

  return false;
}

function getActiveOffers(storeId, purchasedAt) {
  const at = new Date(purchasedAt || Date.now()).getTime();
  return db.prepare('SELECT * FROM offers WHERE is_active = 1').all().filter((offer) => {
    if (!storeMatchesOffer(offer.store_id, storeId)) return false;
    if (offer.active_from && new Date(offer.active_from).getTime() > at) return false;
    if (offer.active_to && new Date(offer.active_to).getTime() < at) return false;
    return true;
  });
}


function buildPricingDebug({ items = [], storeId, purchasedAt, calculation }) {
  const at = new Date(purchasedAt || Date.now()).getTime();
  const allPricingOffers = db.prepare(`SELECT * FROM offers
    WHERE type IN ('club', 'wholesale')
    ORDER BY id DESC
    LIMIT 50`).all();

  const lines = [];
  lines.push('STARCLUB PRICING DEBUG');
  const resolvedStore = findStoreByIdentity(storeId);
  lines.push(`store_id="${String(storeId || '')}" resolved_store_id="${String(resolvedStore?.id || '')}" resolved_store_name="${String(resolvedStore?.name || '')}" purchased_at="${String(purchasedAt || '')}"`);
  lines.push(`items=${items.length}; pricing_rules_found=${allPricingOffers.length}`);

  items.forEach((item, index) => {
    const productCodes = [...itemProductCodes(item)];
    const groupCodes = [...itemGroupCodes(item)];
    const resultItem = calculation?.items?.[index] || {};
    const catalogProduct = productCodes.map((code) => catalogProductByAnyCode(code)).find(Boolean) || null;

    lines.push('');
    lines.push(`#${Number(item.line_no ?? index + 1)} ${String(item.name || 'Товар')}`);
    lines.push(`product_codes=[${productCodes.join(', ') || 'EMPTY'}]`);
    lines.push(`group_codes=[${groupCodes.join(', ') || 'EMPTY'}]`);
    lines.push(`catalog_external_id=${catalogProduct?.external_id || 'NOT_FOUND'}; catalog_group=${catalogProduct?.group_external_id || 'EMPTY'}`);
    lines.push(`price=${Number(item.regular_price_cents ?? item.price_cents ?? 0)} -> final=${Number(resultItem.final_price_cents ?? 0)}`);

    let anyMatched = false;
    for (const offer of allPricingOffers) {
      let reason = 'ACTIVE';
      if (!offer.is_active) reason = 'DISABLED';
      else if (!storeMatchesOffer(offer.store_id, storeId)) {
        reason = `STORE_MISMATCH(rule=${offer.store_id})`;
      } else if (offer.active_from && new Date(offer.active_from).getTime() > at) {
        reason = `NOT_STARTED(${offer.active_from})`;
      } else if (offer.active_to && new Date(offer.active_to).getTime() < at) {
        reason = `EXPIRED(${offer.active_to})`;
      }

      const targetType = getOfferTargetType(offer);
      const targetValue = getOfferTargetValue(offer) || 'EMPTY';
      const active = reason === 'ACTIVE';
      const matches = active && offerMatchesItem(offer, item);
      if (matches) anyMatched = true;

      lines.push(`${matches ? 'MATCH' : 'NO'} rule#${offer.id} "${offer.name}" type=${offer.type} target=${targetType}:${targetValue} mode=${offer.price_mode || 'EMPTY'} value=${offer.price_value ?? 'EMPTY'} status=${active ? 'ACTIVE_TARGET_' + (matches ? 'OK' : 'MISMATCH') : reason}`);
    }

    if (!anyMatched) lines.push('RESULT: NO ACTIVE PRICING RULE MATCHED THIS ITEM');
    else {
      const applied = Array.isArray(resultItem.applied) ? resultItem.applied : [];
      lines.push(`RESULT: applied=${applied.map((a) => `#${a.offer_id}:${a.type}`).join(', ') || 'NONE'}`);
    }
  });

  return lines.join('\n').slice(0, 30000);
}

function calculateAccrualWithOffers(items = [], storeId, purchasedAt) {
  const offers = getActiveOffers(storeId, purchasedAt);
  const adminExcludedCodes = getAdminStarAccrualExclusionSet();
  const adminExcludedGroups = getStarAccrualGroupExclusionSet();
  let stars = 0;
  const applied = [];
  for (const item of items) {
    const excluded = isItemExcludedFromStarAccrual(item, adminExcludedCodes, adminExcludedGroups);
    if (excluded) continue;
    const lineCents = Math.round(Number(item.line_total_cents ?? item.total_cents ?? item.sum_cents ?? 0));
    let multiplier = 1;
    let matchedOffer = null;
    for (const offer of offers) {
      if (offer.type !== 'stars_multiplier' || !offer.stars_multiplier || !offerMatchesItem(offer, item)) continue;
      if (Number(offer.stars_multiplier) > multiplier) {
        multiplier = Number(offer.stars_multiplier);
        matchedOffer = offer;
      }
    }
    stars += Math.floor((lineCents / 100) * multiplier);
    if (matchedOffer) applied.push({ offer_id: matchedOffer.id, name: matchedOffer.name, multiplier, product: item.external_product_id || item.product_id || null, category: item.category || null });
  }
  return { stars, applied };
}

function roundPriceCents(value, mode = 'kopeck') {
  const cents = Math.max(0, Number(value || 0));
  if (mode === '10kop') return Math.round(cents / 10) * 10;
  if (mode === '50kop') return Math.round(cents / 50) * 50;
  if (mode === '1uah') return Math.round(cents / 100) * 100;
  if (mode === 'down_1uah') return Math.floor(cents / 100) * 100;
  return Math.round(cents);
}

function calculatePriceByMode(regularPriceCents, mode, rawValue, roundingMode = 'kopeck') {
  const regular = Math.max(0, Math.round(Number(regularPriceCents || 0)));
  const value = Number(rawValue || 0);
  let result = regular;
  if (mode === 'percent') result = regular * (1 - value / 100);
  else if (mode === 'amount') result = regular - value;
  else if (mode === 'fixed') result = value;
  else return regular;
  result = Math.min(regular, result);
  return roundPriceCents(Math.max(0, result), roundingMode);
}

function effectiveStorePriceCents(row) {
  if (!row) return null;
  const useManual = Number(row.use_manual_price || 0) === 1;
  const manual = row.manual_price_cents === null || row.manual_price_cents === undefined
    ? null
    : Math.max(0, Math.round(Number(row.manual_price_cents || 0)));
  const synced = Math.max(0, Math.round(Number(row.synced_price_cents || 0)));
  return useManual && manual !== null ? manual : synced;
}

function getProductStorePrice(productId, storeId) {
  if (!productId || !storeId || storeId === 'all') return null;
  const resolvedStoreId = canonicalStoreId(storeId);
  const row = db.prepare(`SELECT psp.*, s.name AS store_name, s.external_id AS store_external_id
    FROM product_store_prices psp
    JOIN stores s ON s.id = psp.store_id
    WHERE psp.product_id = ? AND psp.store_id = ?
    LIMIT 1`).get(String(productId), resolvedStoreId);
  if (!row) return null;
  return { ...row, effective_price_cents: effectiveStorePriceCents(row) };
}

function refreshLegacyProductPrice(productId) {
  if (!productId) return;
  const rows = db.prepare(`SELECT synced_price_cents, manual_price_cents, use_manual_price
    FROM product_store_prices WHERE product_id = ?`).all(String(productId));
  const prices = rows.map(effectiveStorePriceCents).filter((price) => Number(price) > 0);
  if (!prices.length) return;
  db.prepare('UPDATE products SET price_cents = ? WHERE id = ?').run(Math.min(...prices), String(productId));
}

function productCatalogRowByCode(value) {
  const code = normalizeOneCCode(value);
  if (!code) return null;
  return db.prepare(`SELECT * FROM products WHERE external_id = ? OR id = ? LIMIT 1`).get(code, code) || null;
}

function normalizeProductBarcode(value) {
  return String(value ?? '').trim().replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}

function detectProductImageMime(buffer) {
  if (!buffer || buffer.length < 4) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer.slice(0, 6).toString('ascii') === 'GIF87a' || buffer.slice(0, 6).toString('ascii') === 'GIF89a') return 'image/gif';
  if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

function productImageRoute(productId) {
  return `/api/catalog/products/${encodeURIComponent(String(productId))}/image`;
}

function productBarcodeLookupVariants(value) {
  const barcode = normalizeProductBarcode(value);
  if (!barcode) return [];
  const variants = [barcode];
  if (/^\d+$/.test(barcode)) {
    if (barcode.length === 12) variants.push(`0${barcode}`);
    if (barcode.length === 13) variants.push(`0${barcode}`);
    if (barcode.length === 13 && barcode.startsWith('0')) variants.push(barcode.slice(1));
    if (barcode.length === 14 && barcode.startsWith('0')) variants.push(barcode.slice(1));
    const withoutLeadingZeros = barcode.replace(/^0+(?=\d)/, '');
    if (withoutLeadingZeros && barcode.length - withoutLeadingZeros.length <= 2) variants.push(withoutLeadingZeros);
  }
  return [...new Set(variants.filter(Boolean))];
}

function productBarcodesFromPayload(product = {}) {
  const raw = [];
  if (Array.isArray(product.barcodes)) raw.push(...product.barcodes);
  for (const key of ['barcode', 'ean', 'ean13', 'gtin']) {
    if (product[key] !== undefined && product[key] !== null) raw.push(product[key]);
  }
  return [...new Set(raw.map(normalizeProductBarcode).filter(Boolean))];
}

function payloadHasProductBarcodes(product = {}) {
  return Object.prototype.hasOwnProperty.call(product, 'barcodes')
    || ['barcode', 'ean', 'ean13', 'gtin'].some((key) => Object.prototype.hasOwnProperty.call(product, key));
}

function priceCheckDebugInfo(barcode, variants = []) {
  const debug = {
    code: 'UNKNOWN',
    reason: 'Штрих-код не знайдено у локальній базі Star Club.',
    scanned_barcode: barcode,
    lookup_variants: variants
  };
  try {
    const productsCount = Number(db.prepare('SELECT COUNT(*) AS count FROM products').get()?.count || 0);
    const barcodesCount = Number(db.prepare('SELECT COUNT(*) AS count FROM product_barcodes').get()?.count || 0);
    const lastProductUpdate = db.prepare('SELECT MAX(updated_at) AS value FROM products').get()?.value || null;
    const lastBarcodeUpdate = db.prepare('SELECT MAX(updated_at) AS value FROM product_barcodes').get()?.value || null;
    debug.products_in_catalog = productsCount;
    debug.barcodes_in_catalog = barcodesCount;
    debug.last_product_update = lastProductUpdate;
    debug.last_barcode_update = lastBarcodeUpdate;

    if (productsCount === 0) {
      debug.code = 'CATALOG_NOT_SYNCED';
      debug.reason = 'Каталог товарів із 1С у Star Club порожній. Спочатку потрібно виконати синхронізацію номенклатури з 1С.';
      return debug;
    }
    if (barcodesCount === 0) {
      debug.code = 'BARCODES_NOT_SYNCED';
      debug.reason = `Товари з 1С у Star Club є (${productsCount}), але жодного штрих-коду не передано/не збережено. Причина не в сканері: під час синхронізації 1С поле barcode/barcodes не потрапило в backend.`;
      return debug;
    }

    const placeholders = variants.map(() => '?').join(',');
    const barcodeMatches = variants.length
      ? Number(db.prepare(`SELECT COUNT(*) AS count FROM product_barcodes WHERE barcode IN (${placeholders})`).get(...variants)?.count || 0)
      : 0;
    debug.barcode_variant_matches = barcodeMatches;

    const externalMatch = variants.find((variant) => productCatalogRowByCode(variant));
    if (externalMatch) {
      debug.code = 'BARCODE_SAVED_AS_PRODUCT_CODE';
      debug.reason = `Товар із кодом ${externalMatch} є в каталозі, але цей номер не записаний як штрих-код товару. Перевірте передачу штрих-кодів із 1С.`;
      return debug;
    }

    debug.code = 'BARCODE_NOT_IN_SYNC';
    debug.reason = `Каталог із 1С синхронізований (${productsCount} товарів, ${barcodesCount} штрих-кодів), але саме штрих-коду ${barcode} серед синхронізованих немає. Перевірте, чи цей штрих-код передається з номенклатури 1С під час /api/1c/products/sync.`;
    return debug;
  } catch (error) {
    debug.code = 'PRICE_CHECK_DEBUG_ERROR';
    debug.reason = `Не вдалося перевірити стан синхронізації: ${String(error?.message || error)}`;
    return debug;
  }
}

function priceForProductAndStore(product, storeId) {
  if (!product) return null;
  const row = getProductStorePrice(product.id, storeId);
  if (row) return row.effective_price_cents;
  const fallback = Math.max(0, Math.round(Number(product.price_cents || 0)));
  return fallback || null;
}

function productsForPricingTarget(targetType, targetValue) {
  const normalizedTarget = normalizeOneCCode(targetValue);
  if (targetType === 'product') {
    const product = productCatalogRowByCode(normalizedTarget);
    return product ? [product] : [];
  }
  if (targetType === 'group') {
    return db.prepare(`SELECT * FROM products
      WHERE group_external_id = ? OR group_path_json LIKE ?
      ORDER BY name LIMIT 10000`).all(normalizedTarget, `%"${normalizedTarget.replaceAll('"', '')}"%`);
  }
  if (targetType === 'all') return db.prepare('SELECT * FROM products ORDER BY name LIMIT 10000').all();
  return db.prepare(`SELECT * FROM products WHERE category = ? OR group_name = ? ORDER BY name LIMIT 10000`).all(String(targetValue || ''), String(targetValue || ''));
}

function pricingTargetSnapshot(targetType, targetValue, storeId) {
  const products = productsForPricingTarget(targetType, targetValue);
  const priced = products.map((product) => ({
    product,
    price_cents: priceForProductAndStore(product, storeId)
  })).filter((item) => Number(item.price_cents) > 0);
  const representative = priced[0]?.product || products[0] || null;
  return {
    products,
    representative,
    base_price_cents: priced.length ? Math.min(...priced.map((item) => Number(item.price_cents))) : null
  };
}

function nullableCents(value, fallback = null) {
  if (value === undefined) return fallback;
  if (value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : fallback;
}

function buildOfferSnapshotFields({ body = {}, existing = null, targetType, targetValue, storeId, type, price, tiersJson }) {
  const snapshot = pricingTargetSnapshot(targetType, targetValue, storeId);
  const calculatedOld = snapshot.base_price_cents;
  const useManualOld = body.use_manual_old_price === undefined
    ? Number(existing?.use_manual_old_price || 0) === 1
    : Boolean(body.use_manual_old_price);
  const manualOld = nullableCents(body.manual_old_price_cents, existing?.manual_old_price_cents ?? null);
  const effectiveOld = useManualOld && manualOld !== null ? manualOld : calculatedOld;

  let calculatedNew = calculatedOld;
  if (calculatedOld !== null && calculatedOld !== undefined) {
    if (type === 'club' && price?.price_mode && Number.isFinite(Number(price.price_value))) {
      calculatedNew = calculatePriceByMode(calculatedOld, price.price_mode, price.price_value, body.rounding_mode || existing?.rounding_mode || 'kopeck');
    } else if (type === 'wholesale') {
      const tiers = parseWholesaleTiers({ tiers_json: tiersJson });
      if (tiers.length) {
        const tier = tiers[0];
        calculatedNew = calculatePriceByMode(calculatedOld, tier.mode, tier.value, body.rounding_mode || existing?.rounding_mode || 'kopeck');
      }
    }
  }

  const useManualNew = body.use_manual_new_price === undefined
    ? Number(existing?.use_manual_new_price || 0) === 1
    : Boolean(body.use_manual_new_price);
  const manualNew = nullableCents(body.manual_new_price_cents, existing?.manual_new_price_cents ?? null);

  return {
    calculated_old_price_cents: calculatedOld,
    calculated_new_price_cents: calculatedNew,
    manual_old_price_cents: manualOld,
    use_manual_old_price: useManualOld ? 1 : 0,
    manual_new_price_cents: manualNew,
    use_manual_new_price: useManualNew ? 1 : 0,
    old_price_cents: effectiveOld,
    target_name: snapshot.representative?.name || String(targetValue || '')
  };
}

function offerEffectiveOldPrice(offer, fallback) {
  if (Number(offer?.use_manual_old_price || 0) === 1 && offer?.manual_old_price_cents !== null && offer?.manual_old_price_cents !== undefined) {
    return Math.max(0, Math.round(Number(offer.manual_old_price_cents || 0)));
  }
  if (fallback !== null && fallback !== undefined) return fallback;
  if (offer?.calculated_old_price_cents !== null && offer?.calculated_old_price_cents !== undefined) return Number(offer.calculated_old_price_cents);
  return offer?.old_price_cents !== null && offer?.old_price_cents !== undefined ? Number(offer.old_price_cents) : null;
}

function offerManualNewPrice(offer) {
  if (Number(offer?.use_manual_new_price || 0) !== 1) return null;
  if (offer?.manual_new_price_cents === null || offer?.manual_new_price_cents === undefined) return null;
  return Math.max(0, Math.round(Number(offer.manual_new_price_cents || 0)));
}

function parseWholesaleTiers(offer) {
  if (!offer?.tiers_json) return [];
  try {
    const tiers = JSON.parse(offer.tiers_json);
    if (!Array.isArray(tiers)) return [];
    return tiers.map((tier) => {
      const qty = Number(tier.qty || 0);
      if (tier.price !== undefined && tier.price !== null && tier.mode === undefined) {
        return { qty, mode: 'fixed', value: Math.round(Number(tier.price || 0) * 100) };
      }
      const mode = String(tier.mode || 'fixed');
      let value = Number(tier.value ?? tier.price ?? 0);
      if (mode === 'amount' || mode === 'fixed') value = Math.round(value * 100);
      return { qty, mode, value };
    }).filter((tier) => tier.qty > 0 && Number.isFinite(tier.value) && tier.value >= 0)
      .sort((a, b) => a.qty - b.qty);
  } catch {
    return [];
  }
}

function productsForOfferShowcase(offer = {}) {
  const targetType = getOfferTargetType(offer);
  const targetValue = normalizeOneCCode(getOfferTargetValue(offer));

  if (targetType === 'product') {
    const product = db.prepare(`SELECT * FROM products
      WHERE external_id = ? OR id = ?
      LIMIT 1`).get(targetValue, targetValue);
    return product ? [product] : [];
  }

  if (targetType === 'group') {
    return db.prepare(`SELECT * FROM products
      WHERE group_external_id = ? OR group_path_json LIKE ?
      ORDER BY price_cents ASC, name ASC
      LIMIT 5000`).all(targetValue, `%"${targetValue.replaceAll('"', '')}"%`);
  }

  if (targetType === 'all') {
    return db.prepare(`SELECT * FROM products ORDER BY price_cents ASC, name ASC LIMIT 5000`).all();
  }

  return db.prepare(`SELECT * FROM products
    WHERE category = ? OR group_name = ?
    ORDER BY price_cents ASC, name ASC
    LIMIT 5000`).all(getOfferTargetValue(offer), getOfferTargetValue(offer));
}

function offerShowcaseView(offer = {}, preferredStoreId = null, context = null) {
  // Request-local only: never retain prices across requests or 1C updates.
  const targetKey = JSON.stringify([getOfferTargetType(offer), getOfferTargetValue(offer)]);
  let products = context?.products.get(targetKey);
  if (!products) {
    products = productsForOfferShowcase(offer);
    context?.products.set(targetKey, products);
  }
  const ruleStoreId = offer.store_id && offer.store_id !== 'all' ? canonicalStoreId(offer.store_id) : null;
  const storeId = ruleStoreId || (preferredStoreId && preferredStoreId !== 'all' ? canonicalStoreId(preferredStoreId) : null);
  const priceMap = context?.prices.get(storeId) || new Map();
  if (storeId) {
    const missing = [...new Set(products.map((p) => String(p.id)))].filter((id) => !priceMap.has(id));
    for (let offset = 0; offset < missing.length; offset += 400) {
      const ids = missing.slice(offset, offset + 400);
      const rows = db.prepare(`SELECT psp.product_id, psp.synced_price_cents,
          psp.manual_price_cents, psp.use_manual_price
        FROM product_store_prices psp JOIN stores s ON s.id = psp.store_id
        WHERE psp.store_id = ? AND psp.product_id IN (${ids.map(() => '?').join(',')})`).all(storeId, ...ids);
      ids.forEach((id) => priceMap.set(id, null));
      rows.forEach((row) => priceMap.set(String(row.product_id), effectiveStorePriceCents(row)));
    }
    context?.prices.set(storeId, priceMap);
  }
  const pricedProducts = products.map((product) => ({
    ...product,
    effective_price_cents: storeId && priceMap.get(String(product.id)) !== null
      ? priceMap.get(String(product.id))
      : Math.max(0, Math.round(Number(product.price_cents || 0)))
  })).filter((product) => Number(product.effective_price_cents || 0) > 0);
  const representative = pricedProducts[0] || products[0] || null;
  const targetType = getOfferTargetType(offer);
  const isFromPrice = targetType === 'group' || targetType === 'all';
  const catalogPrice = pricedProducts.length
    ? Math.min(...pricedProducts.map((product) => Math.max(0, Math.round(Number(product.effective_price_cents || 0)))))
    : null;
  const regularPriceCents = offerEffectiveOldPrice(offer, catalogPrice);

  let currentPriceCents = offerManualNewPrice(offer);
  let discountLabel = '';

  if (offer.type === 'club') {
    const mode = offer.price_mode || (offer.club_price_cents !== null && offer.club_price_cents !== undefined ? 'fixed' : null);
    const value = offer.price_mode ? offer.price_value : offer.club_price_cents;
    if (mode === 'percent') discountLabel = `−${Number(value || 0)}%`;
    else if (mode === 'amount') discountLabel = `−${money(value)} грн`;
    else if (mode === 'fixed') discountLabel = `${money(value)} грн`;

    if (currentPriceCents === null && regularPriceCents !== null && mode && Number.isFinite(Number(value))) {
      currentPriceCents = calculatePriceByMode(regularPriceCents, mode, value, offer.rounding_mode || 'kopeck');
    }
  }

  if (offer.type === 'wholesale') {
    const tier = parseWholesaleTiers(offer)[0] || null;
    if (tier) {
      discountLabel = tier.mode === 'percent'
        ? `від ${tier.qty} шт — −${Number(tier.value || 0)}%`
        : tier.mode === 'amount'
          ? `від ${tier.qty} шт — −${money(tier.value)} грн`
          : `від ${tier.qty} шт — ${money(tier.value)} грн/шт`;
      if (currentPriceCents === null && regularPriceCents !== null) {
        currentPriceCents = calculatePriceByMode(regularPriceCents, tier.mode, tier.value, offer.rounding_mode || 'kopeck');
      }
    }
  }

  const store = ruleStoreId ? db.prepare('SELECT id, name FROM stores WHERE id = ? LIMIT 1').get(ruleStoreId) : null;
  const priceStore = storeId ? db.prepare('SELECT id, name FROM stores WHERE id = ? LIMIT 1').get(storeId) : null;
  const savingCents = regularPriceCents !== null && currentPriceCents !== null
    ? Math.max(0, regularPriceCents - currentPriceCents)
    : null;

  return {
    ...offer,
    image_url: normalizeImageUrl(offer.image_url || representative?.image_url),
    current_price_cents: currentPriceCents,
    old_price_cents: regularPriceCents,
    price_from: isFromPrice,
    discount_label: discountLabel || null,
    badge: offer.type === 'wholesale' ? 'ОПТОВА ЦІНА' : 'КЛУБНА ЦІНА',
    target_name: representative?.name || offer.target_value || offer.category || null,
    products_count: products.length,
    store_name: store?.name || (ruleStoreId ? ruleStoreId : 'Усі магазини'),
    price_store_id: priceStore?.id || storeId || null,
    price_store_name: priceStore?.name || null,
    saving_cents: savingCents
  };
}

function getOfferPriority(offer) {
  if (offer?.priority !== null && offer?.priority !== undefined && Number.isFinite(Number(offer.priority))) {
    return Number(offer.priority);
  }
  const targetType = getOfferTargetType(offer);
  if (offer?.type === 'wholesale') return targetType === 'product' ? 450 : 400;
  if (offer?.type === 'club') return targetType === 'product' ? 300 : 200;
  return 100;
}

function calculateDraftWithOffers({ items = [], storeId, purchasedAt }) {
  // Вітринні demo-пропозиції не є реальними ціновими правилами 1С.
  // Реальні правила з нової адмінки мають target_type або visible_in_app = 0.
  const offers = getActiveOffers(storeId, purchasedAt).filter((offer) => {
    if (offer.type !== 'club' && offer.type !== 'wholesale') return true;
    return Boolean(offer.target_type) || Number(offer.visible_in_app) === 0;
  });
  const calculatedItems = [];
  const appliedConditions = [];
  let regularTotalCents = 0;
  let finalTotalCents = 0;
  let expectedStars = 0;
  const adminExcludedCodes = getAdminStarAccrualExclusionSet();
  const adminExcludedGroups = getStarAccrualGroupExclusionSet();

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index] || {};
    const qty = Math.max(0, Number(item.qty || 0));
    const regularUnitPriceCents = Math.max(0, Math.round(Number(item.regular_price_cents ?? item.price_cents ?? 0)));
    const regularLineTotalCents = Math.max(0, Math.round(Number(item.regular_line_total_cents ?? regularUnitPriceCents * qty)));
    const priceCandidates = [{ priceCents: regularUnitPriceCents, offer: null, source: 'regular', priority: 0 }];

    for (const offer of offers) {
      if (!offerMatchesItem(offer, item)) continue;

      const manualNewPriceCents = offerManualNewPrice(offer);
      if ((offer.type === 'club' || offer.type === 'wholesale') && manualNewPriceCents !== null) {
        priceCandidates.push({
          priceCents: Math.min(regularUnitPriceCents, manualNewPriceCents),
          offer,
          source: 'manual',
          priority: getOfferPriority(offer)
        });
        continue;
      }

      if (offer.type === 'club') {
        let priceMode = offer.price_mode;
        let priceValue = offer.price_value;
        if (!priceMode && offer.club_price_cents !== null && offer.club_price_cents !== undefined) {
          priceMode = 'fixed';
          priceValue = Number(offer.club_price_cents);
        }
        if (priceMode && Number.isFinite(Number(priceValue))) {
          priceCandidates.push({
            priceCents: calculatePriceByMode(regularUnitPriceCents, priceMode, priceValue, offer.rounding_mode || 'kopeck'),
            offer,
            source: 'club',
            priority: getOfferPriority(offer)
          });
        }
      }

      if (offer.type === 'wholesale') {
        const eligibleTiers = parseWholesaleTiers(offer).filter((tier) => qty >= tier.qty);
        if (eligibleTiers.length) {
          const tier = eligibleTiers[eligibleTiers.length - 1];
          priceCandidates.push({
            priceCents: calculatePriceByMode(regularUnitPriceCents, tier.mode, tier.value, offer.rounding_mode || 'kopeck'),
            offer,
            source: 'wholesale',
            priority: getOfferPriority(offer),
            tierQty: tier.qty
          });
        }
      }
    }

    // Правило, яке не зменшує ціну, не повинно блокувати інше реальне правило знижки.
    const effectiveDiscounts = priceCandidates.filter((candidate) =>
      candidate.offer && candidate.priceCents < regularUnitPriceCents
    );
    const candidatePool = effectiveDiscounts.length
      ? effectiveDiscounts
      : priceCandidates.filter((candidate) => !candidate.offer);

    const bestPrice = [...candidatePool].sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.priceCents - b.priceCents;
    })[0];
    const finalUnitPriceCents = bestPrice.priceCents;
    const finalLineTotalCents = Math.max(0, Math.round(finalUnitPriceCents * qty));

    let multiplier = 1;
    let multiplierOffer = null;
    const excluded = isItemExcludedFromStarAccrual(item, adminExcludedCodes, adminExcludedGroups);
    if (!excluded) {
      for (const offer of offers) {
        if (offer.type !== 'stars_multiplier' || !offer.stars_multiplier || !offerMatchesItem(offer, item)) continue;
        if (Number(offer.stars_multiplier) > multiplier) {
          multiplier = Number(offer.stars_multiplier);
          multiplierOffer = offer;
        }
      }
    }

    const itemExpectedStars = excluded ? 0 : Math.floor((finalLineTotalCents / 100) * multiplier);
    regularTotalCents += regularLineTotalCents;
    finalTotalCents += finalLineTotalCents;
    expectedStars += itemExpectedStars;

    const applied = [];
    if (bestPrice.offer) {
      applied.push({
        type: bestPrice.source,
        offer_id: bestPrice.offer.id,
        name: bestPrice.offer.name,
        regular_price_cents: regularUnitPriceCents,
        final_price_cents: finalUnitPriceCents,
        tier_qty: bestPrice.tierQty || null
      });
      appliedConditions.push({ offer_id: bestPrice.offer.id, name: bestPrice.offer.name, type: bestPrice.source, line_no: item.line_no ?? index + 1 });
    }
    if (multiplierOffer) {
      applied.push({ type: 'stars_multiplier', offer_id: multiplierOffer.id, name: multiplierOffer.name, multiplier });
      appliedConditions.push({ offer_id: multiplierOffer.id, name: multiplierOffer.name, type: 'stars_multiplier', multiplier, line_no: item.line_no ?? index + 1 });
    }

    calculatedItems.push({
      line_no: Number(item.line_no ?? index + 1),
      external_product_id: item.external_product_id || item.product_id || null,
      group_external_id: item.group_external_id || null,
      name: item.name || 'Товар',
      category: item.category || null,
      qty,
      regular_price_cents: regularUnitPriceCents,
      final_price_cents: finalUnitPriceCents,
      regular_line_total_cents: regularLineTotalCents,
      final_line_total_cents: finalLineTotalCents,
      discount_cents: Math.max(0, regularLineTotalCents - finalLineTotalCents),
      stars_multiplier: multiplier,
      expected_stars: itemExpectedStars,
      applied
    });
  }

  return {
    items: calculatedItems,
    regular_total_cents: regularTotalCents,
    final_total_cents: finalTotalCents,
    discount_total_cents: Math.max(0, regularTotalCents - finalTotalCents),
    expected_stars: expectedStars,
    applied_conditions: appliedConditions
  };
}

function getProfileBonusConfig() {
  const raw = getSetting('profile_bonus', {
    enabled: true,
    stars: 500,
    grantWhen: 'immediately',
    requiredFields: ['phone', 'name', 'birth_date', 'favorite_store']
  });
  const allowedFields = ['phone', 'name', 'birth_date', 'favorite_store', 'email', 'preferences'];
  const requiredFields = Array.isArray(raw.requiredFields) && raw.requiredFields.length
    ? raw.requiredFields.filter((field) => allowedFields.includes(field))
    : ['phone', 'name', 'birth_date', 'favorite_store'];
  return {
    enabled: raw.enabled !== false,
    stars: Math.max(0, Math.floor(Number(raw.stars ?? 500))),
    grantWhen: raw.grantWhen === 'after_first_purchase' ? 'after_first_purchase' : 'immediately',
    requiredFields
  };
}

const CLIENT_CLEANUP_DAY_MS = 24 * 60 * 60 * 1000;

function normalizeClientCleanupConfig(raw = {}) {
  const positiveMinBalance = Math.max(1, Math.floor(Number(raw.positiveMinBalance ?? 1) || 1));
  const rawMaxBalance = Number(raw.positiveMaxBalance);
  const positiveMaxBalance = Number.isFinite(rawMaxBalance) && rawMaxBalance > 0
    ? Math.max(positiveMinBalance, Math.floor(rawMaxBalance))
    : null;
  return {
    enabled: raw.enabled !== false,
    deletePositiveBalance: raw.deletePositiveBalance !== false,
    positiveInactiveDays: Math.min(3650, Math.max(1, Math.floor(Number(raw.positiveInactiveDays ?? 183) || 183))),
    positiveMinBalance,
    positiveMaxBalance,
    deleteZeroBalance: raw.deleteZeroBalance !== false,
    zeroInactiveDays: Math.min(3650, Math.max(1, Math.floor(Number(raw.zeroInactiveDays ?? 183) || 183))),
    lastRunAt: raw.lastRunAt || null,
    lastDeletedCount: Math.max(0, Math.floor(Number(raw.lastDeletedCount || 0)))
  };
}

function getClientCleanupConfig() {
  return normalizeClientCleanupConfig(getSetting('client_cleanup', {}));
}

function saveClientCleanupConfig(input = {}, { preserveRunStatus = true } = {}) {
  const current = getClientCleanupConfig();
  const normalized = normalizeClientCleanupConfig({
    ...input,
    ...(preserveRunStatus ? {
      lastRunAt: current.lastRunAt,
      lastDeletedCount: current.lastDeletedCount
    } : {})
  });
  db.prepare(`INSERT INTO settings(key, value) VALUES('client_cleanup', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(normalized));
  return normalized;
}

function clientCleanupCandidates(config = getClientCleanupConfig(), at = new Date()) {
  const nowMs = at instanceof Date ? at.getTime() : new Date(at).getTime();
  const rows = db.prepare(`SELECT c.*,
      (SELECT MAX(r.purchased_at) FROM receipts r WHERE r.client_id = c.id AND COALESCE(r.is_return, 0) = 0) AS latest_receipt_at,
      (SELECT MAX(l.created_at) FROM star_ledger l WHERE l.client_id = c.id) AS last_balance_change_at
    FROM clients c
    ORDER BY c.id`).all();

  const candidates = [];
  for (const client of rows) {
    const balance = Number(client.stars_balance || 0);
    let reason = null;
    let inactiveDaysRequired = null;

    if (balance === 0 && config.deleteZeroBalance) {
      reason = 'zero_balance';
      inactiveDaysRequired = config.zeroInactiveDays;
    } else if (
      balance >= config.positiveMinBalance
      && config.deletePositiveBalance
      && (config.positiveMaxBalance === null || balance <= config.positiveMaxBalance)
    ) {
      reason = 'positive_balance';
      inactiveDaysRequired = config.positiveInactiveDays;
    }
    if (!reason) continue;

    const activityTimes = [
      client.created_at,
      client.registered_at,
      client.last_purchase_at,
      client.latest_receipt_at,
      client.last_balance_change_at
    ].map((value) => new Date(value || 0).getTime()).filter(Number.isFinite);
    const lastActivityMs = activityTimes.length ? Math.max(...activityTimes) : 0;
    if (!lastActivityMs || lastActivityMs > nowMs - inactiveDaysRequired * CLIENT_CLEANUP_DAY_MS) continue;

    candidates.push({
      id: Number(client.id),
      name: client.name || null,
      phone: client.phone || null,
      card_number: client.card_number || null,
      balance,
      reason,
      inactive_days: Math.floor((nowMs - lastActivityMs) / CLIENT_CLEANUP_DAY_MS),
      last_activity_at: new Date(lastActivityMs).toISOString()
    });
  }
  return candidates;
}

function deleteInactiveClient(candidate, { actorId = 'system', trigger = 'scheduled' } = {}) {
  const clientId = Number(candidate.id);
  const counts = {
    receipts_anonymized: Number(db.prepare('SELECT COUNT(*) AS c FROM receipts WHERE client_id = ?').get(clientId)?.c || 0),
    ledger_deleted: Number(db.prepare('SELECT COUNT(*) AS c FROM star_ledger WHERE client_id = ?').get(clientId)?.c || 0),
    reward_qrs_deleted: Number(db.prepare('SELECT COUNT(*) AS c FROM reward_qrs WHERE client_id = ?').get(clientId)?.c || 0)
  };

  const remove = db.transaction(() => {
    db.prepare('DELETE FROM support_messages WHERE ticket_id IN (SELECT id FROM support_tickets WHERE client_id = ?)').run(clientId);
    db.prepare('DELETE FROM support_tickets WHERE client_id = ?').run(clientId);
    db.prepare('DELETE FROM sessions WHERE client_id = ?').run(clientId);
    db.prepare('DELETE FROM star_ledger WHERE client_id = ?').run(clientId);
    db.prepare('DELETE FROM reward_qrs WHERE client_id = ?').run(clientId);
    db.prepare('DELETE FROM client_stamp_progress WHERE client_id = ?').run(clientId);
    db.prepare('DELETE FROM client_challenge_days WHERE client_id = ?').run(clientId);
    db.prepare('DELETE FROM client_challenge_rewards WHERE client_id = ?').run(clientId);
    db.prepare('DELETE FROM personal_coupons WHERE client_id = ?').run(clientId);
    db.prepare('UPDATE receipts SET client_id = NULL WHERE client_id = ?').run(clientId);
    db.prepare("DELETE FROM audit_logs WHERE entity_type = 'client' AND entity_id = ?").run(String(clientId));
    db.prepare('DELETE FROM clients WHERE id = ?').run(clientId);
    logAudit({
      actorType: actorId === 'system' ? 'system' : 'admin',
      actorId,
      action: 'inactive_client_auto_deleted',
      entityType: 'client_cleanup',
      entityId: String(clientId),
      payload: {
        trigger,
        reason: candidate.reason,
        balance: candidate.balance,
        inactive_days: candidate.inactive_days,
        last_activity_at: candidate.last_activity_at,
        ...counts
      }
    });
  });
  remove();
  return counts;
}

function runClientCleanup({ actorId = 'system', trigger = 'scheduled' } = {}) {
  const config = getClientCleanupConfig();
  if (!config.enabled) return { ok: true, skipped: true, reason: 'DISABLED', deleted: 0, config };

  const candidates = clientCleanupCandidates(config);
  const errors = [];
  let deleted = 0;
  for (const candidate of candidates) {
    try {
      deleteInactiveClient(candidate, { actorId, trigger });
      deleted += 1;
    } catch (error) {
      errors.push({ client_id: candidate.id, error: String(error?.message || error) });
    }
  }

  const updatedConfig = saveClientCleanupConfig({
    ...config,
    lastRunAt: nowIso(),
    lastDeletedCount: deleted
  }, { preserveRunStatus: false });
  logAudit({
    actorType: actorId === 'system' ? 'system' : 'admin',
    actorId,
    action: 'client_cleanup_completed',
    entityType: 'client_cleanup',
    entityId: 'client_cleanup',
    payload: { trigger, candidates: candidates.length, deleted, errors: errors.length }
  });
  return { ok: errors.length === 0, skipped: false, candidates: candidates.length, deleted, errors, config: updatedConfig };
}

function clientHasProfileFields(client, requiredFields = []) {
  return requiredFields.every((field) => {
    if (field === 'preferences') {
      try {
        const prefs = client.preferences ? JSON.parse(client.preferences) : [];
        return Array.isArray(prefs) && prefs.length > 0;
      } catch {
        return false;
      }
    }
    return Boolean(client[field]);
  });
}

function tryAwardProfileBonus(clientId, trigger = 'immediately') {
  let client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
  if (!client) return { awarded: false, reason: 'CLIENT_NOT_FOUND' };
  const bonus = getProfileBonusConfig();
  if (!bonus.enabled) return { awarded: false, reason: 'DISABLED' };
  if (Number(client.profile_bonus_awarded || 0)) return { awarded: false, reason: 'ALREADY_AWARDED' };
  if (bonus.grantWhen !== trigger) return { awarded: false, reason: 'WRONG_TRIGGER' };
  if (!clientHasProfileFields(client, bonus.requiredFields)) return { awarded: false, reason: 'PROFILE_INCOMPLETE' };

  const balance = awardStars(client.id, 'profile_bonus', bonus.stars, 'profile', `+${bonus.stars} ⭐ бонус за повний профіль`);
  db.prepare('UPDATE clients SET profile_bonus_awarded = 1, updated_at = ? WHERE id = ?').run(nowIso(), client.id);
  logAudit({ actorType: 'client', actorId: String(client.id), action: 'profile_bonus_awarded', entityType: 'client', entityId: String(client.id), payload: { stars: bonus.stars, balance, trigger, requiredFields: bonus.requiredFields } });
  return { awarded: true, stars: bonus.stars, balance };
}

function addChallengeVisit(clientId, receiptId, purchasedAt, totalCents, eligibleItems) {
  const day = new Date(purchasedAt).toISOString().slice(0, 10);
  const challenges = db.prepare('SELECT * FROM challenges WHERE is_active = 1').all();
  for (const ch of challenges) {
    if (totalCents < Number(ch.min_total_cents || 0)) continue;
    if (!receiptHasEligibleItems(eligibleItems)) continue;
    if (ch.category) {
      const wanted = normalizeMatchValue(ch.category);
      const hasCategory = eligibleItems.some((item) => {
        const category = normalizeMatchValue(item.category);
        const name = normalizeMatchValue(item.name);
        return category === wanted || category.includes(wanted) || name.includes(wanted);
      });
      if (!hasCategory) continue;
    }
    const periodKey = getPeriodKey(ch.period_type, new Date(purchasedAt));
    db.prepare('INSERT OR IGNORE INTO client_challenge_days(client_id, challenge_id, day, receipt_id, created_at) VALUES(?, ?, ?, ?, ?)')
      .run(clientId, ch.id, day, receiptId, nowIso());
    const progress = db.prepare('SELECT COUNT(*) AS c FROM client_challenge_days WHERE client_id = ? AND challenge_id = ?').get(clientId, ch.id).c;
    const alreadyAwarded = db.prepare('SELECT 1 FROM client_challenge_rewards WHERE client_id = ? AND challenge_id = ? AND period_key = ?').get(clientId, ch.id, periodKey);
    if (progress >= ch.required_visits && !alreadyAwarded) {
      db.prepare('INSERT INTO client_challenge_rewards(client_id, challenge_id, period_key, awarded_at) VALUES(?, ?, ?, ?)')
        .run(clientId, ch.id, periodKey, nowIso());
      const balance = awardStars(clientId, 'challenge_bonus', ch.reward_stars, 'challenge', `+${ch.reward_stars} ⭐ бонус за челендж «${ch.name}»`, receiptId, null);
      logAudit({ actorType: 'system', action: 'challenge_awarded', entityType: 'client', entityId: String(clientId), payload: { challenge: ch.code, reward: ch.reward_stars, balance } });
    }
  }
}

function getStampItemIdentity(item = {}) {
  const productExternalId = String(item.external_product_id || item.product_id || '').trim();
  const productName = String(item.name || 'Товар').trim() || 'Товар';
  const category = String(item.category || '').trim();

  const normalizedId = normalizeMatchValue(productExternalId);
  const normalizedName = normalizeMatchValue(productName);
  const itemKey = normalizedId
    ? `product:${normalizedId}`
    : `name:${normalizedName || 'unknown'}`;

  return {
    itemKey,
    productExternalId: productExternalId || null,
    productName,
    category: category || null
  };
}

function addStampItemUnits(itemCounts, item, units, timestamp = nowIso()) {
  const qty = Math.max(0, Math.floor(Number(units || 0)));
  if (!qty) return;

  const identity = getStampItemIdentity(item);
  const existing = itemCounts.get(identity.itemKey);

  if (existing) {
    existing.qty += qty;
    existing.updatedAt = timestamp;
    if (String(timestamp || '') < String(existing.firstSeenAt || timestamp)) {
      existing.firstSeenAt = timestamp;
    }
    if (!existing.productExternalId && identity.productExternalId) {
      existing.productExternalId = identity.productExternalId;
    }
    if ((!existing.productName || existing.productName === 'Товар') && identity.productName) {
      existing.productName = identity.productName;
    }
    if (!existing.category && identity.category) {
      existing.category = identity.category;
    }
    return;
  }

  itemCounts.set(identity.itemKey, {
    itemKey: identity.itemKey,
    productExternalId: identity.productExternalId,
    productName: identity.productName,
    category: identity.category,
    qty,
    firstSeenAt: timestamp,
    updatedAt: timestamp
  });
}

// Відновлює склад лише поточного незавершеного циклу з уже збережених чеків.
// Окрема таблиця не потрібна: progress точно показує, скільки останніх
// відповідних одиниць товару належить до поточного циклу.
function loadCurrentStampCycleItemCounts(clientId, program, currentProgress, excludedReceiptId) {
  let remaining = Math.max(0, Math.floor(Number(currentProgress || 0)));
  const itemCounts = new Map();
  if (!remaining) return itemCounts;

  const rows = db.prepare(`
    SELECT
      ri.product_id,
      ri.external_product_id,
      ri.name,
      ri.category,
      ri.qty,
      r.purchased_at,
      ri.id AS receipt_item_id
    FROM receipt_items ri
    JOIN receipts r ON r.id = ri.receipt_id
    WHERE r.client_id = ?
      AND r.id <> ?
      AND COALESCE(r.is_return, 0) = 0
      AND COALESCE(r.stars_spent, 0) = 0
    ORDER BY r.purchased_at DESC, ri.id DESC
    LIMIT 2000
  `).all(clientId, String(excludedReceiptId || ''));

  for (const row of rows) {
    if (remaining <= 0) break;
    if (!stampProgramMatchesItem(program, row)) continue;

    const availableUnits = Math.max(0, Math.ceil(Number(row.qty || 1)));
    if (!availableUnits) continue;

    const usedUnits = Math.min(availableUnits, remaining);
    addStampItemUnits(
      itemCounts,
      row,
      usedUnits,
      row.purchased_at || nowIso()
    );
    remaining -= usedUnits;
  }

  return itemCounts;
}

function getMostPurchasedStampItem(itemCounts) {
  const items = Array.from(itemCounts.values())
    .filter((item) => Number(item.qty || 0) > 0)
    .sort((a, b) => {
      const qtyDifference = Number(b.qty || 0) - Number(a.qty || 0);
      if (qtyDifference !== 0) return qtyDifference;

      const firstSeenDifference = String(a.firstSeenAt || '').localeCompare(String(b.firstSeenAt || ''));
      if (firstSeenDifference !== 0) return firstSeenDifference;

      return String(a.productName || '').localeCompare(String(b.productName || ''), 'uk');
    });

  const winner = items[0];
  if (!winner) return null;

  return {
    external_product_id: winner.productExternalId || null,
    product_id: winner.productExternalId || null,
    name: winner.productName || 'Безкоштовний товар',
    category: winner.category || null,
    accumulated_qty: Number(winner.qty || 0)
  };
}

function updateStampProgress(clientId, receiptId, items = []) {
  const programs = db.prepare('SELECT * FROM stamp_programs WHERE is_active = 1').all();

  for (const program of programs) {
    const matchedItems = items.filter((item) => stampProgramMatchesItem(program, item));
    const count = matchedItems.reduce(
      (sum, item) => sum + Math.max(0, Math.ceil(Number(item.qty || 1))),
      0
    );

    if (!count) continue;

    let existing = db.prepare(
      'SELECT * FROM client_stamp_progress WHERE client_id = ? AND program_id = ?'
    ).get(clientId, program.id);

    if (!existing) {
      db.prepare(
        'INSERT INTO client_stamp_progress(client_id, program_id, progress, completed_count, updated_at) VALUES(?, ?, 0, 0, ?)'
      ).run(clientId, program.id, nowIso());

      existing = {
        progress: 0,
        completed_count: 0
      };
    }

    const current = Math.max(0, Number(existing.progress || 0));
    const requiredQty = Math.max(1, Number(program.required_qty || 9));
    let next = current;
    let completed = Math.max(0, Number(existing.completed_count || 0));

    // Беремо товари попередніх покупок лише в межах поточного циклу.
    const itemCounts = loadCurrentStampCycleItemCounts(
      clientId,
      program,
      current,
      receiptId
    );

    const createdCodes = [];
    let stopProcessing = false;

    for (const item of matchedItems) {
      const units = Math.max(0, Math.ceil(Number(item.qty || 1)));

      for (let unit = 0; unit < units; unit += 1) {
        if (stopProcessing) break;

        addStampItemUnits(itemCounts, item, 1);
        next += 1;

        if (next < requiredQty) continue;

        completed += 1;

        // Нагорода прив'язується до товару, який купували найбільше
        // разів саме в межах завершеного циклу програми.
        const rewardItem = getMostPurchasedStampItem(itemCounts) || item;
        const qr = createStampRewardQr(
          clientId,
          program,
          receiptId,
          rewardItem
        );

        if (qr) createdCodes.push(qr.token);

        if (!program.is_repeatable) {
          next = requiredQty;
          stopProcessing = true;
          break;
        }

        // Після видачі коду починається новий окремий цикл.
        next = 0;
        itemCounts.clear();
      }

      if (stopProcessing) break;
    }

    db.prepare(
      'UPDATE client_stamp_progress SET progress = ?, completed_count = ?, updated_at = ? WHERE client_id = ? AND program_id = ?'
    ).run(next, completed, nowIso(), clientId, program.id);

    if (createdCodes.length) {
      logAudit({
        actorType: 'system',
        action: 'stamp_program_completed',
        entityType: 'client',
        entityId: String(clientId),
        payload: {
          program: program.code,
          receiptId,
          codes: createdCodes
        }
      });
    }
  }
}

function normalizeCard(value) {
  return String(value || '')
    .replace(/\s+/g, '')
    .replace(/-/g, '')
    .toUpperCase();
}

function makeRewardManualCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = 'SC-';
  for (let i = 0; i < 8; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out.slice(0, 6) + '-' + out.slice(6);
}

function makeCouponCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = 'SALE-';
  for (let i = 0; i < 8; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out.slice(0, 7) + '-' + out.slice(7);
}

function getUniqueRewardToken() {
  let token = makeRewardManualCode();
  for (let i = 0; i < 20; i += 1) {
    const exists = db.prepare('SELECT id FROM reward_qrs WHERE token = ?').get(token);
    if (!exists) return token;
    token = makeRewardManualCode();
  }
  return `${makeRewardManualCode()}-${Date.now().toString(36).toUpperCase()}`;
}

function getUniqueCouponCode() {
  let code = makeCouponCode();
  for (let i = 0; i < 20; i += 1) {
    const exists = db.prepare('SELECT id FROM personal_coupons WHERE code = ?').get(code);
    if (!exists) return code;
    code = makeCouponCode();
  }
  return `${makeCouponCode()}-${Date.now().toString(36).toUpperCase()}`;
}

function getStampProgramTarget(program = {}) {
  const targetType = String(program.target_type || '').trim().toLowerCase()
    || (program.category ? 'group' : 'category');
  const targetValue = String(program.target_value || program.category || '').trim();
  return { targetType, targetValue };
}

function getCatalogProductForStampItem(item = {}) {
  for (const code of itemProductCodes(item)) {
    const product = db.prepare(`SELECT external_id, id, name, category, group_external_id, group_name, group_path_json
      FROM products
      WHERE external_id = ? OR id = ?
      LIMIT 1`).get(code, code);
    if (product) return product;
  }
  return null;
}

function stampProgramMatchesItem(program, item = {}) {
  const { targetType, targetValue } = getStampProgramTarget(program);
  const wantedCode = normalizeOneCCode(targetValue);
  const wantedText = normalizeMatchValue(targetValue);
  if (!wantedCode && !wantedText) return false;

  const productCodes = itemProductCodes(item);
  const groupCodes = itemGroupCodes(item);
  const catalogProduct = getCatalogProductForStampItem(item);

  if (targetType === 'product') {
    return productCodes.has(wantedCode);
  }

  if (targetType === 'group') {
    if (groupCodes.has(wantedCode)) return true;

    // Старі програми зберігали один код у полі category без типу цілі.
    // Якщо там фактично код товару, не втрачаємо його прогрес після міграції.
    if (productCodes.has(wantedCode)) return true;

    // Backward compatibility for old text-based programs such as coffee/bakery.
    const textValues = [
      item.category,
      item.name,
      item.group_name,
      catalogProduct?.category,
      catalogProduct?.group_name
    ].map(normalizeMatchValue).filter(Boolean);

    if (wantedText === 'coffee' || wantedText.includes('кава')) {
      return textValues.some((v) => v.includes('coffee') || v.includes('кава') || v.includes('лате') || v.includes('капуч'));
    }
    if (wantedText === 'bakery' || wantedText.includes('випіч') || wantedText.includes('хліб') || wantedText.includes('багет')) {
      return textValues.some((v) => v.includes('bakery') || v.includes('випіч') || v.includes('хліб') || v.includes('багет') || v.includes('круасан'));
    }
    return textValues.some((v) => v === wantedText || v.includes(wantedText) || wantedText.includes(v));
  }

  const values = [
    ...productCodes,
    ...groupCodes,
    item.category,
    item.name,
    item.group_name,
    catalogProduct?.category,
    catalogProduct?.group_name
  ].map(normalizeMatchValue).filter(Boolean);

  if (wantedText === 'coffee' || wantedText.includes('кава')) {
    return values.some((v) => v.includes('coffee') || v.includes('кава') || v.includes('лате') || v.includes('капуч'));
  }
  if (wantedText === 'bakery' || wantedText.includes('випіч') || wantedText.includes('хліб') || wantedText.includes('багет')) {
    return values.some((v) => v.includes('bakery') || v.includes('випіч') || v.includes('хліб') || v.includes('багет') || v.includes('круасан'));
  }

  return values.some((v) => v === wantedText || v.includes(wantedText) || wantedText.includes(v));
}

function findRewardProductForStamp(program, rewardItem = null) {
  const wanted = normalizeMatchValue(program.category);
  const rewardItemExternalId = String(rewardItem?.external_product_id || rewardItem?.product_id || '').trim();
  let rows = db.prepare('SELECT * FROM reward_products WHERE is_active = 1 ORDER BY stars_price ASC, id ASC').all();

  if (rewardItemExternalId) {
    const directItem = rows.find((r) => normalizeMatchValue(r.product_external_id) === normalizeMatchValue(rewardItemExternalId));
    if (directItem) return directItem;

    const existingInactive = db.prepare('SELECT * FROM reward_products WHERE product_external_id = ? ORDER BY id ASC LIMIT 1').get(rewardItemExternalId);
    if (existingInactive) return existingInactive;

    const t = nowIso();
    const created = db.prepare(`INSERT INTO reward_products(product_external_id, name, image_url, stars_price, store_id, active_from, active_to, total_limit, per_client_limit, conditions, created_at, updated_at, is_program_reward)
      VALUES(?, ?, ?, 0, 'all', ?, NULL, NULL, NULL, ?, ?, ?, 1)`).run(
        rewardItemExternalId,
        String(rewardItem?.name || program.name || 'Безкоштовний товар'),
        '/assets/star.svg',
        t,
        `Безкоштовний код за накопичувальною програмою «${program.name}»`,
        t,
        t
      );
    return db.prepare('SELECT * FROM reward_products WHERE id = ?').get(created.lastInsertRowid);
  }

  if (!rows.length) return null;
  const direct = rows.find((r) => normalizeMatchValue(r.product_external_id) === wanted);
  if (direct) return direct;
  if (wanted === 'coffee' || wanted.includes('кава')) {
    const coffee = rows.find((r) => normalizeMatchValue(r.name).includes('кава') || normalizeMatchValue(r.name).includes('coffee'));
    if (coffee) return coffee;
  }
  if (wanted === 'bakery' || wanted.includes('багет') || wanted.includes('випіч')) {
    const bakery = rows.find((r) => {
      const n = normalizeMatchValue(r.name);
      return n.includes('багет') || n.includes('випіч') || n.includes('круасан') || n.includes('bakery');
    });
    if (bakery) return bakery;
  }
  return rows[0];
}

function createStampRewardQr(clientId, program, receiptId = null, rewardItem = null) {
  const active = db.prepare(`SELECT q.*, r.name, r.image_url, r.stars_price, r.product_external_id, r.conditions,
      sp.category AS program_category, sp.name AS program_name
    FROM reward_qrs q
    JOIN reward_products r ON r.id = q.reward_product_id
    LEFT JOIN stamp_programs sp ON sp.id = q.program_id
    WHERE q.client_id = ? AND q.program_id = ? AND q.source_type = 'stamp_program' AND q.status = 'reserved' AND q.expires_at > ?
    ORDER BY q.created_at DESC LIMIT 1`).get(clientId, program.id, nowIso());
  if (active) return active;
  const reward = findRewardProductForStamp(program, rewardItem);
  if (!reward) return null;
  const token = getUniqueRewardToken();
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString();
  const r = db.prepare(`INSERT INTO reward_qrs(client_id, reward_product_id, token, status, stars_reserved, source_type, program_id, receipt_id, created_at, expires_at)
    VALUES(?, ?, ?, 'reserved', 0, 'stamp_program', ?, ?, ?, ?)`)
    .run(clientId, reward.id, token, program.id, receiptId, createdAt, expiresAt);
  logAudit({ actorType: 'system', action: 'stamp_reward_qr_created', entityType: 'reward_qr', entityId: String(r.lastInsertRowid), payload: { clientId, program: program.code, reward: reward.name, token, expiresAt } });
  return db.prepare(`SELECT q.*, r.name, r.image_url, r.stars_price, r.product_external_id, r.conditions,
      sp.category AS program_category, sp.name AS program_name
    FROM reward_qrs q
    JOIN reward_products r ON r.id = q.reward_product_id
    LEFT JOIN stamp_programs sp ON sp.id = q.program_id
    WHERE q.id = ?`).get(r.lastInsertRowid);
}

function expireReservedRewardQrs(clientId = null) {
  const now = nowIso();
  if (clientId) {
    db.prepare(`UPDATE reward_qrs SET status = 'expired', canceled_at = ? WHERE client_id = ? AND status = 'reserved' AND expires_at <= ?`).run(now, clientId, now);
  } else {
    db.prepare(`UPDATE reward_qrs SET status = 'expired', canceled_at = ? WHERE status = 'reserved' AND expires_at <= ?`).run(now, now);
  }
}

function getActiveRewardQr(clientId, rewardProductId) {
  expireReservedRewardQrs(clientId);
  return db.prepare(`SELECT q.*, r.name, r.image_url, r.stars_price, r.product_external_id, r.conditions
    FROM reward_qrs q
    JOIN reward_products r ON r.id = q.reward_product_id
    WHERE q.client_id = ? AND q.reward_product_id = ? AND q.status = 'reserved' AND q.expires_at > ?
    ORDER BY q.created_at DESC LIMIT 1`).get(clientId, rewardProductId, nowIso());
}

function formatRewardQr(row) {
  if (!row) return null;
  const sourceType = row.source_type || 'stars';
  const stampProductExternalId = sourceType === 'stamp_program' ? String(row.product_external_id || row.program_category || '').trim() : String(row.product_external_id || '').trim();
  const stampRewardName = sourceType === 'stamp_program'
    ? (row.product_1c_name || row.program_name || row.name)
    : row.name;
  return {
    id: row.id,
    token: row.token,
    manual_code: row.token,
    status: row.status,
    created_at: row.created_at,
    expires_at: row.expires_at,
    used_at: row.used_at,
    canceled_at: row.canceled_at,
    stars_reserved: row.stars_reserved,
    source_type: sourceType,
    program_id: row.program_id || null,
    is_free_stamp_reward: (sourceType === 'stamp_program') || Number(row.stars_reserved || 0) === 0,
    reward: {
      id: row.reward_product_id,
      name: stampRewardName,
      image_url: row.image_url,
      stars_price: row.stars_price,
      product_external_id: stampProductExternalId || null,
      conditions: row.conditions
    }
  };
}

function finalizeRewardQrOnce({ token, receiptId, actorId = '1c', storeId = '1c' }) {
  const cleanToken = String(token || '').trim();
  const cleanReceiptId = String(receiptId || '').trim();
  if (!cleanToken) return { ok: false, error: 'TOKEN_REQUIRED' };
  if (!cleanReceiptId) return { ok: false, error: 'RECEIPT_ID_REQUIRED' };

  expireReservedRewardQrs();

  const row = db.prepare(`SELECT q.*, r.name
    FROM reward_qrs q
    JOIN reward_products r ON r.id = q.reward_product_id
    WHERE q.token = ?`).get(cleanToken);

  if (!row) return { ok: false, error: 'QR_NOT_FOUND' };

  if (row.status === 'used') {
    if (String(row.receipt_id || '') === cleanReceiptId) {
      const client = db.prepare('SELECT stars_balance FROM clients WHERE id = ?').get(row.client_id);
      return { ok: true, status: 'used', duplicate: true, already_finalized: true, balance: client?.stars_balance ?? null };
    }
    return { ok: false, error: 'QR_ALREADY_USED', status: 'used', receipt_id: row.receipt_id };
  }

  if (row.status !== 'reserved') {
    return { ok: false, error: 'QR_STATUS_' + String(row.status || '').toUpperCase(), status: row.status };
  }

  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare('UPDATE reward_qrs SET status = ?, canceled_at = ? WHERE id = ?').run('expired', nowIso(), row.id);
    return { ok: false, error: 'QR_EXPIRED', status: 'expired' };
  }

  const alreadyLedger = db.prepare(`SELECT id FROM star_ledger
    WHERE reward_qr_id = ? AND type = 'reward_spend' LIMIT 1`).get(row.id);

  let balance;
  if (alreadyLedger || Number(row.stars_reserved || 0) === 0) {
    const client = db.prepare('SELECT stars_balance FROM clients WHERE id = ?').get(row.client_id);
    balance = client?.stars_balance ?? null;
  } else {
    balance = awardStars(
      row.client_id,
      'reward_spend',
      -Math.abs(row.stars_reserved),
      'reward_qr',
      `-${row.stars_reserved} ⭐ ${row.name} за зірки`,
      cleanReceiptId,
      row.id
    );
  }

  db.prepare('UPDATE reward_qrs SET status = ?, receipt_id = ?, used_at = ? WHERE id = ?')
    .run('used', cleanReceiptId, nowIso(), row.id);
  db.prepare('UPDATE reward_products SET issued_count = issued_count + 1, updated_at = ? WHERE id = ?')
    .run(nowIso(), row.reward_product_id);

  logAudit({
    actorType: '1c',
    actorId,
    action: 'reward_qr_finalized',
    entityType: 'reward_qr',
    entityId: String(row.id),
    payload: { receiptId: cleanReceiptId, balance, token: cleanToken, storeId }
  });

  return { ok: true, status: 'used', token: cleanToken, receipt_id: cleanReceiptId, balance, stars_spent: Math.abs(row.stars_reserved), reward_name: row.name, reward_qr_id: row.id };
}

function findClientForOneC({ card_number, card_token, phone }) {
  const candidates = [
    card_number,
    card_token,
    phone
  ].filter(Boolean);

  if (!candidates.length) return null;

  const clients = db.prepare('SELECT * FROM clients WHERE is_blocked = 0').all();

  for (const client of clients) {
    for (const value of candidates) {
      const incoming = String(value || '').trim();

      if (phone && client.phone === incoming) {
        return client;
      }

      if (client.card_token && client.card_token === incoming) {
        return client;
      }

      if (normalizeCard(client.card_number) === normalizeCard(incoming)) {
        return client;
      }
    }
  }

  return null;
}

app.post('/api/admin/auth/telegram', (req, res) => {
  const initData = String(req.body?.initData || '');
  let user = null;
  if (initData) {
    const verified = verifyTelegramInitData(initData, process.env.BOT_TOKEN);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'TELEGRAM_AUTH_FAILED', reason: verified.reason });
    user = verified.user;
  } else if (process.env.NODE_ENV !== 'production' && process.env.ALLOW_DEV_LOGIN === 'true' && req.body?.devUser) {
    user = req.body.devUser;
  }
  if (!user?.id) return res.status(400).json({ ok: false, error: 'TELEGRAM_USER_REQUIRED' });
  const telegramId = String(user.id);
  const ownerIds = parseCsvEnv('OWNER_TELEGRAM_IDS');
  const isEnvironmentOwner = ownerIds.includes(telegramId);

  let admin = db.prepare('SELECT * FROM admin_users WHERE telegram_id = ?').get(telegramId);

  // Only Owner is bootstrapped from ENV. All Admin users and their permissions
  // are created and managed by Owner from the admin panel.
  if (!admin && isEnvironmentOwner) {
    const now = nowIso();
    const r = db.prepare(`INSERT INTO admin_users(telegram_id, name, username, role, permissions_json, is_active, created_at, updated_at)
      VALUES(?, ?, ?, 'owner', '[]', 1, ?, ?)`).run(
        telegramId,
        [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Owner',
        user.username || null,
        now,
        now
      );
    admin = db.prepare('SELECT * FROM admin_users WHERE id = ?').get(r.lastInsertRowid);
  }

  // OWNER_TELEGRAM_IDS is the recovery source of truth for Owner access.
  if (admin && isEnvironmentOwner && (admin.role !== 'owner' || !admin.is_active)) {
    db.prepare(`UPDATE admin_users
      SET role = 'owner', permissions_json = '[]', is_active = 1, updated_at = ?
      WHERE id = ?`).run(nowIso(), admin.id);
    admin = db.prepare('SELECT * FROM admin_users WHERE id = ?').get(admin.id);
  }
  if (!admin || !admin.is_active) return res.status(403).json({ ok: false, error: 'ADMIN_ACCESS_DENIED' });
  db.prepare('UPDATE admin_users SET name = ?, username = ?, updated_at = ? WHERE id = ?')
    .run([user.first_name, user.last_name].filter(Boolean).join(' ') || admin.name, user.username || admin.username, nowIso(), admin.id);
  admin = db.prepare('SELECT * FROM admin_users WHERE id = ?').get(admin.id);
  const session = createAdminSession(admin.id);
  logAudit({ actorType: 'admin', actorId: String(admin.id), action: 'admin_telegram_login', entityType: 'admin_user', entityId: String(admin.id), payload: { telegram_id: telegramId } });
  res.json({ ok: true, admin: formatAdmin(admin), session });
});


app.post('/api/admin/auth/password', (req, res) => {
  const login = String(req.body?.login || '').trim();
  const password = String(req.body?.password || '');
  if (!login || password.length < 6) return res.status(401).json({ ok: false, error: 'INVALID_CREDENTIALS' });
  let admin = db.prepare('SELECT * FROM admin_users WHERE login = ? AND is_active = 1').get(login);
  if (!admin || !admin.password_hash || !verifyPassword(password, admin.password_hash)) {
    return res.status(401).json({ ok: false, error: 'INVALID_CREDENTIALS' });
  }
  const session = createAdminSession(admin.id);
  logAudit({ actorType: 'admin', actorId: String(admin.id), action: 'admin_password_login', entityType: 'admin_user', entityId: String(admin.id), payload: { login } });
  res.json({ ok: true, admin: formatAdmin(admin), session });
});

app.get('/api/admin/me', adminAuth, (req, res) => res.json({
  ok: true,
  admin: formatAdmin(req.admin),
  auth_mode: 'protected'
}));

app.get('/api/admin/debug/pricing', adminAuth, (req, res) => {
  const productsCount = Number(db.prepare('SELECT COUNT(*) AS count FROM products').get()?.count || 0);
  const offersCount = Number(db.prepare('SELECT COUNT(*) AS count FROM offers').get()?.count || 0);
  const pricingRules = db.prepare(`SELECT id, type, name, target_type, target_value, price_mode, price_value,
      tiers_json, store_id, active_from, active_to, is_active, created_at, updated_at
    FROM offers
    WHERE type IN ('club', 'wholesale')
    ORDER BY id DESC
    LIMIT 50`).all();

  res.json({
    ok: true,
    auth_mode: req.admin?.telegram_id === 'desktop-open' ? 'desktop-open' : 'protected',
    database_file: process.env.DATABASE_FILE || process.env.DB_FILE || './data/star-club.sqlite',
    products_count: productsCount,
    offers_count: offersCount,
    pricing_rules_count: pricingRules.length,
    pricing_rules: pricingRules
  });
});

app.get('/health', (req, res) => res.json({ ok: true, service: 'star-club', time: nowIso() }));

function storesVisibleToClients() {
  const syncedCount = Number(db.prepare("SELECT COUNT(*) AS count FROM stores WHERE is_active = 1 AND source = '1c'").get()?.count || 0);
  if (syncedCount > 0) {
    return db.prepare("SELECT * FROM stores WHERE is_active = 1 AND source = '1c' ORDER BY name").all();
  }
  return db.prepare("SELECT * FROM stores WHERE is_active = 1 AND COALESCE(source, 'manual') != 'seed' ORDER BY name").all();
}

app.get('/api/public/stores', (req, res) => {
  res.json({ ok: true, stores: storesVisibleToClients() });
});


app.post('/api/auth/telegram', (req, res) => {
  const { initData, devUser } = req.body || {};
  let telegramUser = null;
  const token = process.env.BOT_TOKEN;
  const allowDev = String(process.env.ALLOW_DEV_LOGIN || (process.env.NODE_ENV === 'production' ? 'false' : 'true')) === 'true';

  if (initData && token && !token.startsWith('123456:')) {
    const check = verifyTelegramInitData(initData, token);
    if (!check.ok) return res.status(401).json({ ok: false, error: 'TELEGRAM_AUTH_FAILED', detail: check.reason });
    telegramUser = check.user;
  } else if (allowDev) {
    telegramUser = devUser || { id: '111111111', first_name: 'Андрій' };
  } else {
    return res.status(401).json({ ok: false, error: 'NO_TELEGRAM_AUTH' });
  }

  const client = getOrCreateClientFromTelegram(telegramUser);
  const session = createSession(client.id);
  res.json({ ok: true, session, client: formatClient(client) });
});


app.post('/api/auth/login', (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const password = String(req.body?.password || '');
  if (!phone || password.length < 6) {
    return res.status(401).json({ ok: false, error: 'INVALID_CREDENTIALS' });
  }
  const client = db.prepare('SELECT * FROM clients WHERE phone = ?').get(phone);
  if (!client || !client.password_hash || !verifyPassword(password, client.password_hash)) {
    return res.status(401).json({ ok: false, error: 'INVALID_CREDENTIALS' });
  }
  if (client.is_blocked) return res.status(403).json({ ok: false, error: 'CLIENT_BLOCKED' });
  const session = createSession(client.id);
  res.json({ ok: true, session, client: formatClient(client) });
});

app.get('/api/client/me', clientAuth, (req, res) => {
  const fresh = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.client.id);
  res.json({ ok: true, client: formatClient(fresh) });
});

app.post('/api/client/set-password', clientAuth, (req, res) => {
  const password = String(req.body?.password || '');
  const passwordConfirm = String(req.body?.password_confirm || '');
  if (password.length < 6) return res.status(400).json({ ok: false, error: 'PASSWORD_TOO_SHORT', message: 'Пароль має містити мінімум 6 символів' });
  if (password !== passwordConfirm) return res.status(400).json({ ok: false, error: 'PASSWORDS_DO_NOT_MATCH', message: 'Паролі не співпадають' });
  const t = nowIso();
  db.prepare('UPDATE clients SET password_hash = ?, password_set_at = ?, updated_at = ? WHERE id = ?')
    .run(hashPassword(password), t, t, req.client.id);
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.client.id);
  res.json({ ok: true, client: formatClient(client) });
});

app.post('/api/client/register', optionalClientAuth, (req, res) => {
  const body = req.body || {};
  if (!body.agree_rules || !body.agree_personal_data || !body.agree_phone_processing) {
    return res.status(400).json({
      ok: false,
      error: 'CONSENTS_REQUIRED',
      message: 'Потрібно погодитися з правилами, політикою конфіденційності та обробкою мобільного номера'
    });
  }
  if (!req.client?.id) {
    const t = nowIso();
    const webId = `web-${randomToken()}`;
    const cardNumber = generateCardNumber();
    const cardToken = randomToken('card_');
    const created = db.prepare(`INSERT INTO clients(telegram_id, name, card_number, card_token, registered_at, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?)`).run(webId, String(body.name || 'Клієнт'), cardNumber, cardToken, t, t, t);
    req.client = db.prepare('SELECT * FROM clients WHERE id = ?').get(created.lastInsertRowid) || db.prepare('SELECT * FROM clients WHERE telegram_id = ?').get(webId);
  }
  if (!req.client?.id) return res.status(500).json({ ok: false, error: 'CLIENT_CREATE_FAILED', message: 'Не вдалося створити клієнта. Перезапустіть сервер і спробуйте ще раз.' });
  const phone = normalizePhone(body.phone);
  if (!phone) return res.status(400).json({ ok: false, error: 'INVALID_PHONE', message: 'Введіть номер у форматі +380XXXXXXXXX або 0XXXXXXXXX' });

  const name = String(body.name || '').trim();
  if (name.length < 2) return res.status(400).json({ ok: false, error: 'NAME_REQUIRED', message: 'Вкажіть імʼя мінімум з 2 символів' });

  const birthDate = String(body.birth_date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) {
    return res.status(400).json({ ok: false, error: 'BIRTH_DATE_REQUIRED', message: 'Вкажіть дату народження' });
  }

  const favoriteStore = String(body.favorite_store || '').trim();
  const storeExists = db.prepare('SELECT id FROM stores WHERE id = ? AND is_active = 1').get(favoriteStore);
  if (!storeExists) return res.status(400).json({ ok: false, error: 'STORE_REQUIRED', message: 'Оберіть улюблений магазин зі списку' });

  const password = String(body.password || '');
  const passwordConfirm = String(body.password_confirm || '');
  const currentBeforeUpdate = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.client.id);
  const shouldSetPassword = password.length > 0 || !currentBeforeUpdate?.password_hash;
  if (shouldSetPassword) {
    if (password.length < 6) return res.status(400).json({ ok: false, error: 'PASSWORD_TOO_SHORT', message: 'Пароль має містити мінімум 6 символів' });
    if (password !== passwordConfirm) return res.status(400).json({ ok: false, error: 'PASSWORDS_DO_NOT_MATCH', message: 'Паролі не співпадають' });
  }

  const existingByPhone = db.prepare('SELECT id FROM clients WHERE phone = ? AND id != ?').get(phone, req.client.id);
  if (existingByPhone) return res.status(409).json({ ok: false, error: 'PHONE_ALREADY_REGISTERED', message: 'Клієнт з таким номером вже зареєстрований. Скористайтесь входом.' });

  const t = nowIso();
  const nextPasswordHash = shouldSetPassword ? hashPassword(password) : currentBeforeUpdate.password_hash;
  const nextPasswordSetAt = shouldSetPassword ? t : currentBeforeUpdate.password_set_at;
  const preferences = Array.isArray(body.preferences)
    ? body.preferences.map((v) => String(v).trim()).filter(Boolean)
    : String(body.preferences || '').split(',').map((v) => v.trim()).filter(Boolean);
  const consentVersion = String(body.consent_version || '2026-07-12');
  db.prepare(`UPDATE clients SET
      phone = ?, name = ?, birth_date = ?, favorite_store = ?, email = ?, marketing_allowed = ?,
      consent_rules_at = COALESCE(consent_rules_at, ?),
      consent_personal_data_at = COALESCE(consent_personal_data_at, ?),
      consent_phone_at = COALESCE(consent_phone_at, ?),
      consent_version = ?,
      preferences = ?, password_hash = ?, password_set_at = ?, updated_at = ?
    WHERE id = ?`)
    .run(
      phone, name, birthDate, favoriteStore, body.email || null, body.marketing_allowed ? 1 : 0,
      t, t, t, consentVersion,
      JSON.stringify(preferences), nextPasswordHash, nextPasswordSetAt, t, req.client.id
    );

  let client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.client.id);
  tryAwardProfileBonus(client.id, 'immediately');
  client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.client.id);
  const session = createSession(client.id);
  res.json({ ok: true, session, client: formatClient(client) });
});

app.get('/api/client/stores', clientAuth, (req, res) => {
  res.json({ ok: true, stores: storesVisibleToClients() });
});

app.get('/api/client/card', clientAuth, (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.client.id);
  res.json({ ok: true, card: {
    name: client.name || 'Клієнт Star Club',
    card_number: client.card_number,
    card_token: client.card_token,
    stars_balance: client.stars_balance,
    available_stars: getClientAvailableStars(client.id)
  } });
});

app.get('/api/client/price-check', clientAuth, (req, res) => {
  const barcode = normalizeProductBarcode(req.query.barcode);
  if (!barcode) {
    return res.status(400).json({ ok: false, error: 'BARCODE_REQUIRED', message: 'Введіть або відскануйте штрих-код' });
  }

  const variants = productBarcodeLookupVariants(barcode);
  const placeholders = variants.map(() => '?').join(',');
  let product = variants.length ? db.prepare(`SELECT p.*, pb.barcode AS matched_barcode
    FROM product_barcodes pb
    JOIN products p ON p.id = pb.product_id
    WHERE pb.barcode IN (${placeholders})
    ORDER BY CASE WHEN pb.barcode = ? THEN 0 ELSE 1 END
    LIMIT 1`).get(...variants, barcode) : null;

  // Залишаємо сумісність з базами, де штрих-код раніше зберігали як код товару 1С.
  if (!product) {
    for (const variant of variants) {
      product = productCatalogRowByCode(variant);
      if (product) break;
    }
  }
  if (!product) {
    const debug = priceCheckDebugInfo(barcode, variants);
    console.warn('[price-check] product not found', debug);
    return res.status(404).json({
      ok: false,
      error: 'PRODUCT_NOT_FOUND',
      message: 'Товар не знайдено',
      barcode,
      debug
    });
  }

  const requestedStoreId = String(req.query.store_id || req.client.favorite_store || '').trim();
  const storeId = requestedStoreId ? canonicalStoreId(requestedStoreId) : '';
  const store = storeId
    ? db.prepare('SELECT id, external_id, name FROM stores WHERE (id = ? OR external_id = ?) AND is_active = 1 LIMIT 1').get(storeId, storeId)
    : null;
  const priceCents = priceForProductAndStore(product, store?.id || storeId || null);
  const barcodes = db.prepare('SELECT barcode FROM product_barcodes WHERE product_id = ? ORDER BY is_primary DESC, barcode').all(product.id).map((row) => row.barcode);

  res.json({
    ok: true,
    barcode,
    matched_barcode: product.matched_barcode || barcode,
    product: {
      id: product.id,
      external_id: product.external_id,
      name: product.name,
      category: product.category || product.group_name || '',
      image_url: product.image_url || null,
      price_cents: priceCents,
      barcodes
    },
    store: store ? { id: store.id, external_id: store.external_id, name: store.name } : null
  });
});

app.get('/api/client/star-history', clientAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM star_ledger WHERE client_id = ? ORDER BY created_at DESC LIMIT 100').all(req.client.id);
  res.json({ ok: true, items: rows });
});

// Group return documents under their original purchase in client receipt history.
const clientReceiptReturnColumns = `
  (SELECT COUNT(*) FROM receipts rr WHERE rr.original_receipt_id = r.id
    AND rr.client_id = r.client_id AND rr.is_return = 1) AS return_count,
  (SELECT COALESCE(SUM(ABS(rr.total_cents)), 0) FROM receipts rr
    WHERE rr.original_receipt_id = r.id AND rr.client_id = r.client_id
    AND rr.is_return = 1) AS returned_total_cents`;
function clientReceiptReturnStatus(receipt) {
  if (!Number(receipt.return_count)) return '';
  return Number(receipt.returned_total_cents) >= Math.abs(Number(receipt.total_cents))
    ? 'Скасовано' : 'Часткове повернення';
}

app.get('/api/client/receipts', clientAuth, (req, res) => {
  const receipts = db.prepare(`SELECT r.*, ${clientReceiptReturnColumns}, COALESCE(s.name, r.store_id, 'Магазин Star') AS store_name
    FROM receipts r LEFT JOIN stores s ON s.id = r.store_id OR s.external_id = r.store_id
    WHERE r.client_id = ? AND COALESCE(r.is_return, 0) = 0 ORDER BY r.purchased_at DESC LIMIT 50`).all(req.client.id);
  const itemsByReceipt = new Map();
  if (receipts.length) {
    const rows = db.prepare(`SELECT * FROM receipt_items WHERE receipt_id IN (${receipts.map(() => '?').join(',')}) ORDER BY rowid`).all(...receipts.map((r) => r.id));
    for (const item of rows) {
      const key = String(item.receipt_id);
      if (!itemsByReceipt.has(key)) itemsByReceipt.set(key, []);
      itemsByReceipt.get(key).push(item);
    }
  }
  res.json({ ok: true, receipts: receipts.map((r) => {
    const items = itemsByReceipt.get(String(r.id)) || [];
    const isRewardPurchase = Number(r.stars_spent || 0) > 0;
    return {
      ...r,
      return_status_label: clientReceiptReturnStatus(r),
      total_uah: money(r.total_cents),
      eligible_uah: money(r.eligible_cents),
      is_reward_purchase: isRewardPurchase,
      display_title: isRewardPurchase ? 'Покупка за зірки' : (r.store_name || r.store_id || 'Магазин Star'),
      display_amount: isRewardPurchase ? `-${r.stars_spent} ⭐` : `${money(r.total_cents)} грн`,
      items
    };
  }) });
});

app.get('/api/client/receipts/:id', clientAuth, (req, res) => {
  const r = db.prepare(`SELECT r.*, ${clientReceiptReturnColumns}, COALESCE(s.name, r.store_id, 'Магазин Star') AS store_name FROM receipts r LEFT JOIN stores s ON s.id = r.store_id OR s.external_id = r.store_id WHERE r.id = ? AND r.client_id = ?`).get(req.params.id, req.client.id);
  if (!r) return res.status(404).json({ ok: false, error: 'RECEIPT_NOT_FOUND' });
  const items = db.prepare('SELECT * FROM receipt_items WHERE receipt_id = ? ORDER BY id').all(r.id);
  const isRewardPurchase = Number(r.stars_spent || 0) > 0;
  res.json({ ok: true, receipt: {
    ...r,
      return_status_label: clientReceiptReturnStatus(r),
    total_uah: money(r.total_cents),
    eligible_uah: money(r.eligible_cents),
    is_reward_purchase: isRewardPurchase,
    display_title: isRewardPurchase ? 'Покупка за зірки' : (r.store_name || r.store_id || 'Магазин Star'),
    display_amount: isRewardPurchase ? `-${r.stars_spent} ⭐` : `${money(r.total_cents)} грн`,
    items
  } });
});

app.get('/api/client/rewards', clientAuth, (req, res) => {
  expireReservedRewardQrs(req.client.id);
  const items = db.prepare('SELECT * FROM reward_products WHERE is_active = 1 AND COALESCE(is_program_reward, 0) = 0 ORDER BY stars_price ASC').all();
  const available = getClientAvailableStars(req.client.id);
  res.json({ ok: true, available_stars: available, items: items.map((item) => ({ ...item, can_get: available >= item.stars_price })) });
});

app.post('/api/client/rewards/:id/create-qr', clientAuth, (req, res) => {
  const reward = db.prepare('SELECT * FROM reward_products WHERE id = ? AND is_active = 1 AND COALESCE(is_program_reward, 0) = 0').get(req.params.id);
  if (!reward) return res.status(404).json({ ok: false, error: 'REWARD_NOT_FOUND' });

  const active = getActiveRewardQr(req.client.id, reward.id);
  if (active) return res.json({ ok: true, reused: true, qr: formatRewardQr(active) });

  const issuedByClient = db.prepare(`SELECT COUNT(*) AS c FROM reward_qrs WHERE client_id = ? AND reward_product_id = ? AND status = 'used'`).get(req.client.id, reward.id).c;
  if (reward.per_client_limit && issuedByClient >= reward.per_client_limit) {
    return res.status(400).json({ ok: false, error: 'CLIENT_LIMIT_REACHED' });
  }

  if (reward.total_limit && Number(reward.issued_count || 0) >= Number(reward.total_limit)) {
    return res.status(400).json({ ok: false, error: 'TOTAL_LIMIT_REACHED' });
  }

  const available = getClientAvailableStars(req.client.id);
  if (available < reward.stars_price) return res.status(400).json({ ok: false, error: 'NOT_ENOUGH_STARS', available_stars: available });

  const token = getUniqueRewardToken();
  const expires = new Date(Date.now() + 1000 * 60 * 15).toISOString();
  const result = db.prepare(`INSERT INTO reward_qrs(client_id, reward_product_id, token, status, stars_reserved, source_type, created_at, expires_at)
    VALUES(?, ?, ?, 'reserved', ?, 'stars', ?, ?)`).run(req.client.id, reward.id, token, reward.stars_price, nowIso(), expires);
  logAudit({ actorType: 'client', actorId: String(req.client.id), action: 'reward_qr_created', entityType: 'reward_qr', entityId: String(result.lastInsertRowid), payload: { reward: reward.name, stars: reward.stars_price, token } });
  const row = getActiveRewardQr(req.client.id, reward.id);
  res.json({ ok: true, reused: false, qr: formatRewardQr(row) });
});

app.post('/api/client/reward-qr/cancel', clientAuth, (req, res) => {
  const token = String(req.body?.token || req.body?.manual_code || req.body?.code || '').trim();
  if (!token) return res.status(400).json({ ok: false, error: 'TOKEN_REQUIRED' });

  expireReservedRewardQrs(req.client.id);

  const row = db.prepare('SELECT * FROM reward_qrs WHERE token = ? AND client_id = ?').get(token, req.client.id);
  if (!row) return res.status(404).json({ ok: false, error: 'QR_NOT_FOUND' });
  if (row.status !== 'reserved') return res.status(400).json({ ok: false, error: 'QR_STATUS_' + row.status.toUpperCase(), status: row.status });

  db.prepare('UPDATE reward_qrs SET status = ?, canceled_at = ? WHERE id = ?').run('canceled', nowIso(), row.id);
  logAudit({ actorType: 'client', actorId: String(req.client.id), action: 'reward_qr_canceled_by_client', entityType: 'reward_qr', entityId: String(row.id), payload: { token } });
  const fresh = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.client.id);
  res.json({ ok: true, status: 'canceled', balance: fresh.stars_balance, available_stars: getClientAvailableStars(req.client.id) });
});

app.get('/api/client/reward-qrs', clientAuth, (req, res) => {
  expireReservedRewardQrs(req.client.id);
  const rows = db.prepare(`SELECT q.*, r.name, r.image_url, r.stars_price, r.product_external_id, r.conditions,
      sp.category AS program_category, sp.name AS program_name,
      prod.name AS product_1c_name
    FROM reward_qrs q
    JOIN reward_products r ON r.id = q.reward_product_id
    LEFT JOIN stamp_programs sp ON sp.id = q.program_id
    LEFT JOIN products prod ON prod.external_id = COALESCE(NULLIF(r.product_external_id, ''), NULLIF(sp.category, '')) OR prod.id = COALESCE(NULLIF(r.product_external_id, ''), NULLIF(sp.category, ''))
    WHERE q.client_id = ?
    ORDER BY q.created_at DESC
    LIMIT 100`).all(req.client.id);
  const currentTime = nowIso();

const coupons = db.prepare(`
  SELECT
    id,
    code,
    product_external_id,
    product_name,
    discount_percent,
    status,
    expires_at,
    created_at,
    used_at
  FROM personal_coupons
  WHERE client_id = ?
    AND status = 'active'
    AND datetime(expires_at) > datetime(?)
  ORDER BY created_at DESC
  LIMIT 50
`).all(
  req.client.id,
  currentTime
);
  res.json({ ok: true, coupons, qrs: rows.map(formatRewardQr) });
});

app.get('/api/client/offers', clientAuth, (req, res) => {
  const showcaseContext = { products: new Map(), prices: new Map() };
  const now = Date.now();
  const requestedFavoriteStore = String(req.client?.favorite_store || '').trim();
  const favoriteStoreRow = requestedFavoriteStore ? findStoreByIdentity(requestedFavoriteStore) : null;
  const favoriteStore = String(favoriteStoreRow?.id || requestedFavoriteStore || '');
  const matchesFavoriteStore = (offer) => {
    return storeMatchesOffer(offer?.store_id, favoriteStore);
  };

  const rules = db.prepare(`SELECT * FROM offers
      WHERE is_active = 1
        AND visible_in_app = 1
        AND type IN ('club', 'wholesale')
      ORDER BY priority DESC, id DESC`).all()
    .filter((offer) => {
      if (offer.active_from && new Date(offer.active_from).getTime() > now) return false;
      if (offer.active_to && new Date(offer.active_to).getTime() < now) return false;
      return matchesFavoriteStore(offer);
    })
    .map((offer) => offerShowcaseView(offer, favoriteStore, showcaseContext));

  const existingKeys = new Set(rules.map((o) => `${o.type}:${normalizeMatchValue(o.name)}`));
  const legacy = db.prepare(`SELECT * FROM promo_offers WHERE is_active = 1 ORDER BY id DESC`).all()
    .filter((offer) => {
      if (offer.active_from && new Date(offer.active_from).getTime() > now) return false;
      if (offer.active_to && new Date(offer.active_to).getTime() < now) return false;
      if (!matchesFavoriteStore(offer)) return false;
      return !existingKeys.has(`${offer.type}:${normalizeMatchValue(offer.name)}`);
    })
    .map((o) => {
      const store = o.store_id && o.store_id !== 'all'
        ? db.prepare('SELECT name FROM stores WHERE id = ? LIMIT 1').get(String(o.store_id))
        : null;
      return { ...o, image_url: normalizeImageUrl(o.image_url), legacy_promo: true, store_name: store?.name || 'Усі магазини' };
    });

  const stores = favoriteStoreRow ? [favoriteStoreRow] : [];

  res.json({
    ok: true,
    favorite_store: favoriteStore,
    favorite_store_name: favoriteStoreRow?.name || null,
    stores,
    offers: [...rules, ...legacy]
  });
});

app.get('/api/client/progress', clientAuth, (req, res) => {
  const stamps = db.prepare(`SELECT p.id AS program_id, p.name, p.code, p.required_qty, p.reward_stars, COALESCE(sp.progress, 0) AS progress, COALESCE(sp.completed_count, 0) AS completed_count FROM stamp_programs p LEFT JOIN client_stamp_progress sp ON sp.program_id = p.id AND sp.client_id = ? WHERE p.is_active = 1 ORDER BY p.id`).all(req.client.id);
  const challenges = db.prepare(`SELECT ch.*, COUNT(d.day) AS progress FROM challenges ch LEFT JOIN client_challenge_days d ON d.challenge_id = ch.id AND d.client_id = ? WHERE ch.is_active = 1 GROUP BY ch.id ORDER BY ch.id`).all(req.client.id);
  res.json({ ok: true, stamps, challenges });
});

app.get('/api/client/news', clientAuth, (req, res) => {
  res.json({ ok: true, news: db.prepare('SELECT * FROM news WHERE is_active = 1 ORDER BY created_at DESC').all() });
});

app.get('/api/client/banners', clientAuth, (req, res) => {
  const config = getSetting('home_banners', { enabled: true }) || { enabled: true };
  const enabled = config.enabled !== false;
  const banners = enabled
    ? db.prepare('SELECT * FROM home_banners WHERE is_active = 1 ORDER BY sort_order ASC, id DESC').all()
      .map((item) => ({ ...item, image_url: normalizeImageUrl(item.image_url) }))
    : [];
  const now = nowIso();
  const personal = enabled ? db.prepare(`SELECT * FROM personal_coupons
    WHERE client_id = ? AND status = 'active' AND expires_at > ? AND show_as_banner = 1
    ORDER BY created_at DESC`).all(req.client.id, now).map((coupon) => ({
      id: `coupon-${coupon.id}`, title: coupon.banner_title || `Персональна знижка −${coupon.discount_percent}%`,
      text: coupon.banner_text || `На ${coupon.product_name || 'обраний товар'} до ${new Date(coupon.expires_at).toLocaleDateString('uk-UA')}`,
      image_url: normalizeImageUrl(coupon.banner_image_url || '/assets/star.svg'), tag: 'ЛИШЕ ДЛЯ ВАС',
      source_type: 'personal_coupon', source_id: coupon.id, link_route: 'rewardCodes', sort_order: 1, is_personal: true
    })) : [];
  res.json({ ok: true, enabled, banners: [...personal, ...banners] });
});

app.get('/api/client/support/tickets', clientAuth, (req, res) => {
  const tickets = db.prepare('SELECT * FROM support_tickets WHERE client_id = ? ORDER BY updated_at DESC').all(req.client.id);
  const msg = db.prepare('SELECT * FROM support_messages WHERE ticket_id = ? ORDER BY created_at ASC');
  res.json({ ok: true, tickets: tickets.map((t) => ({ ...t, messages: msg.all(t.id) })) });
});

app.post('/api/client/support/tickets', clientAuth, (req, res) => {
  const subject = String(req.body?.subject || '').trim();
  const message = String(req.body?.message || '').trim();
  if (!subject || !message) return res.status(400).json({ ok: false, error: 'SUBJECT_AND_MESSAGE_REQUIRED' });
  const now = nowIso();
  const r = db.prepare(`INSERT INTO support_tickets(client_id, subject, status, created_at, updated_at) VALUES(?, ?, 'open', ?, ?)`)
    .run(req.client.id, subject, now, now);
  db.prepare(`INSERT INTO support_messages(ticket_id, sender_type, sender_id, message, created_at) VALUES(?, 'client', ?, ?, ?)`)
    .run(r.lastInsertRowid, String(req.client.id), message, now);
  logAudit({ actorType: 'client', actorId: String(req.client.id), action: 'support_ticket_created', entityType: 'support_ticket', entityId: String(r.lastInsertRowid), payload: { subject } });
  res.json({ ok: true, ticket_id: r.lastInsertRowid });
});

app.post('/api/client/support/tickets/:id/messages', clientAuth, (req, res) => {
  const ticket = db.prepare('SELECT * FROM support_tickets WHERE id = ? AND client_id = ?').get(req.params.id, req.client.id);
  if (!ticket) return res.status(404).json({ ok: false, error: 'TICKET_NOT_FOUND' });
  const message = String(req.body?.message || '').trim();
  if (!message) return res.status(400).json({ ok: false, error: 'MESSAGE_REQUIRED' });
  const now = nowIso();
  db.prepare(`INSERT INTO support_messages(ticket_id, sender_type, sender_id, message, created_at) VALUES(?, 'client', ?, ?, ?)`)
    .run(ticket.id, String(req.client.id), message, now);
  db.prepare(`UPDATE support_tickets SET status = 'open', updated_at = ? WHERE id = ?`).run(now, ticket.id);
  res.json({ ok: true });
});

app.get('/api/svg/qr', async (req, res) => {
  const text = String(req.query.text || '');
  if (!text) return res.status(400).send('text is required');
  const svg = await QRCode.toString(text, { type: 'svg', margin: 1, width: 256, color: { dark: '#111111', light: '#ffffff' } });
  res.setHeader('Content-Type', 'image/svg+xml');
  res.send(svg);
});

app.get('/api/svg/barcode', async (req, res) => {
  const text = String(req.query.text || '');
  if (!text) return res.status(400).send('text is required');
  const png = await bwipjs.toBuffer({ bcid: 'code128', text, scale: 2, height: 16, includetext: true, textxalign: 'center', backgroundcolor: 'FFFFFF' });
  res.setHeader('Content-Type', 'image/png');
  res.send(png);
});

// ---------------- 1C REST API ----------------

app.get('/api/1c/clients', oneCAuth, (req, res) => {
  expireReservedRewardQrs();
  const limit = Math.min(1000, Math.max(1, Number(req.query.limit || 500)));
  const since = String(req.query.since || '').trim();
  const q = String(req.query.q || '').trim();
  let rows;
  if (q) {
    rows = db.prepare(`SELECT * FROM clients
      WHERE is_blocked = 0 AND (name LIKE ? OR phone LIKE ? OR card_number LIKE ?)
      ORDER BY updated_at DESC LIMIT ?`).all(`%${q}%`, `%${q}%`, `%${q}%`, limit);
  } else if (since) {
    rows = db.prepare(`SELECT * FROM clients
      WHERE is_blocked = 0 AND COALESCE(updated_at, created_at, registered_at) >= ?
      ORDER BY updated_at DESC LIMIT ?`).all(since, limit);
  } else {
    rows = db.prepare(`SELECT * FROM clients
      WHERE is_blocked = 0
      ORDER BY updated_at DESC LIMIT ?`).all(limit);
  }

  const clients = rows.map((client) => ({
    id: client.id,
    name: client.name || '',
    phone: client.phone || '',
    email: client.email || '',
    birth_date: client.birth_date || '',
    favorite_store: client.favorite_store || '',
    card_number: client.card_number,
    card_token: client.card_token,
    barcode: normalizeCard(client.card_number),
    stars_balance: client.stars_balance || 0,
    available_stars: getClientAvailableStars(client.id),
    status: client.is_blocked ? 'blocked' : 'active',
    registered_at: client.registered_at,
    updated_at: client.updated_at || client.created_at || client.registered_at
  }));

  res.json({ ok: true, count: clients.length, clients });
});

app.get('/api/1c/client/search', oneCAuth, (req, res) => {
  expireReservedRewardQrs();
  const client = findClientForOneC(req.query);
  if (!client) return res.json({ ok: true, found: false });
  const rewards = db.prepare('SELECT id, name, stars_price FROM reward_products WHERE is_active = 1 AND COALESCE(is_program_reward, 0) = 0 AND stars_price <= ?').all(getClientAvailableStars(client.id));
  const stamps = db.prepare(`SELECT p.code, p.name, COALESCE(sp.progress, 0) AS progress, p.required_qty, p.reward_stars FROM stamp_programs p LEFT JOIN client_stamp_progress sp ON sp.program_id = p.id AND sp.client_id = ? WHERE p.is_active = 1 ORDER BY p.id`).all(client.id);
  res.json({ ok: true, found: true, client: {
    card_number: client.card_number,
    name: client.name,
    phone: client.phone,
    stars_balance: client.stars_balance,
    available_stars: getClientAvailableStars(client.id),
    status: client.is_blocked ? 'blocked' : 'active',
    available_rewards: rewards,
    stamp_rewards: stamps,
    restrictions: ['no_alcohol', 'no_tobacco', 'no_min_margin']
  } });
});


app.post('/api/1c/calculate', oneCAuth, (req, res) => {
  const body = req.body || {};
  const client = findClientForOneC({
    card_number: body.card_number,
    card_token: body.card_token,
    phone: body.phone
  });
  if (!client) return res.status(404).json({ ok: false, error: 'CLIENT_NOT_FOUND' });
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) return res.status(400).json({ ok: false, error: 'ITEMS_REQUIRED' });

  // Для онлайн-розрахунку ціни використовуємо фактичний поточний час сервера.
  // У старій 1С дата чека часто передається як 00:00:00, через що правило,
  // створене сьогодні, помилково мало статус NOT_STARTED.
  const pricingAt = nowIso();
  const resolvedStore = findStoreFromPayload(body);
  const requestedStoreIdentity = body.store_external_id || body.store_id || body.store_name || '';
  const storeId = String(resolvedStore?.id || requestedStoreIdentity || '').trim();

  const calculation = calculateDraftWithOffers({
    items,
    storeId,
    purchasedAt: pricingAt
  });

  res.json({
    ok: true,
    client: {
      id: client.id,
      name: client.name,
      phone: client.phone,
      card_number: client.card_number,
      stars_balance: client.stars_balance,
      available_stars: getClientAvailableStars(client.id)
    },
    resolved_store_id: resolvedStore?.id || null,
    resolved_store_name: resolvedStore?.name || null,
    ...calculation,
    ...(body.debug ? {
      debug_text: buildPricingDebug({
        items,
        storeId,
        purchasedAt: pricingAt,
        calculation
      })
    } : {})
  });
});

// Зарахування частини готівкової здачі на баланс StarClub.
// 1 грн здачі = 5 зірок. Операція створюється як pending і завершується
// лише після успішного фіскального проведення чека у 1С.

function completePendingChangeAccrualForReceipt({ receiptId, receiptNumber, fiscalReceiptNumber, clientId }) {
  const normalizedReceiptId = String(receiptId || '').trim();
  const normalizedReceiptNumber = String(receiptNumber || '').trim();
  if (!normalizedReceiptId && !normalizedReceiptNumber) return [];

  const clauses = [];
  const params = [];
  if (normalizedReceiptId) {
    clauses.push('receipt_id = ?');
    params.push(normalizedReceiptId);
  }
  if (normalizedReceiptNumber) {
    clauses.push('receipt_number = ?');
    params.push(normalizedReceiptNumber);
  }

  let sql = `SELECT * FROM change_accrual_operations
    WHERE status = 'pending' AND (${clauses.join(' OR ')})`;
  if (clientId) {
    sql += ' AND client_id = ?';
    params.push(clientId);
  }
  sql += ' ORDER BY created_at ASC';

  const pending = db.prepare(sql).all(...params);
  const completed = [];

  for (const operation of pending) {
    const completedAt = nowIso();
    const completeOne = db.transaction(() => {
      const fresh = db.prepare('SELECT * FROM change_accrual_operations WHERE id = ?').get(operation.id);
      if (!fresh || fresh.status !== 'pending') return null;

      const isTopup = fresh.operation_type === 'topup';
      const ledgerType = isTopup ? 'topup' : 'change_accrual';
      const ledgerSource = isTopup ? '1c_topup' : '1c_change';
      const ledgerDescription = isTopup
        ? `+${fresh.stars_amount} ⭐ поповнення`
        : `+${fresh.stars_amount} ⭐ з решти`;

      const balanceAfter = awardStars(
        fresh.client_id,
        ledgerType,
        fresh.stars_amount,
        ledgerSource,
        ledgerDescription,
        normalizedReceiptId || fresh.receipt_id || null,
        null
      );

      const ledger = db.prepare(`SELECT id FROM star_ledger
        WHERE client_id = ? AND type = ? AND source = ?
        ORDER BY id DESC LIMIT 1`).get(fresh.client_id, ledgerType, ledgerSource);

      db.prepare(`UPDATE change_accrual_operations
        SET status = 'completed', receipt_id = COALESCE(?, receipt_id),
            receipt_number = COALESCE(?, receipt_number), fiscal_receipt_number = COALESCE(?, fiscal_receipt_number),
            ledger_id = ?, completed_at = ?, updated_at = ?
        WHERE id = ? AND status = 'pending'`)
        .run(
          normalizedReceiptId || null,
          normalizedReceiptNumber || null,
          fiscalReceiptNumber || null,
          ledger?.id || null,
          completedAt,
          completedAt,
          fresh.id
        );

      return { operation_id: fresh.id, stars_added: fresh.stars_amount, stars_balance: balanceAfter };
    });

    const result = completeOne();
    if (result) {
      completed.push(result);
      logAudit({
        actorType: '1c',
        actorId: 'receipt-auto-complete',
        action: 'change_accrual_completed',
        entityType: 'change_accrual_operation',
        entityId: result.operation_id,
        payload: { receipt_id: normalizedReceiptId || null, stars_added: result.stars_added, automatic: true }
      });
    }
  }

  return completed;
}

app.post('/api/1c/change-accrual/prepare', oneCAuth, (req, res) => {
  const body = req.body || {};
  const operationType = body.operation_type === 'topup' || body.source === 'topup_from_1c'
    ? 'topup'
    : 'change';
  const client = findClientForOneC({
    card_number: body.card_number || body.card_token,
    card_token: body.card_token,
    phone: body.phone
  });

  if (!client) return res.status(404).json({ ok: false, error: 'CLIENT_NOT_FOUND' });
  if (client.is_blocked) return res.status(403).json({ ok: false, error: 'CLIENT_BLOCKED' });

  const amountCents = Math.round(Number(body.amount_cents ?? (Number(body.amount_uah || 0) * 100)));
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    return res.status(400).json({ ok: false, error: 'INVALID_AMOUNT' });
  }

  const starsAmount = amountCents; // 1 зірка = 1 копійка
  const operationId = randomToken('chg_');
  const createdAt = nowIso();
  const resolvedStore = findStoreFromPayload(body);
  const requestedStoreIdentity = body.store_external_id || body.store_id || body.store_name || '';
  const storeId = String(resolvedStore?.id || requestedStoreIdentity || '').trim();
  const normalizedCard = String(body.card_token || body.card_number || client.card_token || '').trim();

  db.prepare(`INSERT INTO change_accrual_operations(
      id, client_id, card_token, amount_cents, stars_amount, status,
      operation_type, receipt_id, receipt_number, store_id, store_name, cash_register, cashier,
      created_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      operationId,
      client.id,
      normalizedCard,
      amountCents,
      starsAmount,
      operationType,
      body.receipt_id || null,
      body.receipt_number || null,
      storeId || null,
      resolvedStore?.name || body.store_name || null,
      body.cash_register || null,
      body.cashier || null,
      createdAt,
      createdAt
    );

  logAudit({
    actorType: '1c',
    actorId: body.cashier || body.cash_register || storeId || '1c',
    action: 'change_accrual_prepared',
    entityType: 'change_accrual_operation',
    entityId: operationId,
    payload: { client_id: client.id, amount_cents: amountCents, stars_amount: starsAmount, receipt_id: body.receipt_id || null }
  });

  return res.status(201).json({
    ok: true,
    success: true,
    operation_id: operationId,
    status: 'pending',
    amount_cents: amountCents,
    amount_uah: money(amountCents),
    stars_amount: starsAmount,
    client: {
      id: client.id,
      card_number: client.card_number,
      stars_balance: Number(client.stars_balance || 0)
    }
  });
});

app.post('/api/1c/change-accrual/complete', oneCAuth, (req, res) => {
  const body = req.body || {};
  const operationId = String(body.operation_id || '').trim();
  if (!operationId) return res.status(400).json({ ok: false, error: 'OPERATION_ID_REQUIRED' });

  const existing = db.prepare('SELECT * FROM change_accrual_operations WHERE id = ?').get(operationId);
  if (!existing) return res.status(404).json({ ok: false, error: 'OPERATION_NOT_FOUND' });

  if (existing.status === 'completed') {
    const client = db.prepare('SELECT stars_balance FROM clients WHERE id = ?').get(existing.client_id);
    return res.json({
      ok: true,
      success: true,
      duplicate: true,
      operation_id: operationId,
      status: 'completed',
      stars_added: existing.stars_amount,
      stars_balance: Number(client?.stars_balance || 0)
    });
  }

  if (existing.status === 'cancelled') {
    return res.status(409).json({ ok: false, error: 'OPERATION_CANCELLED' });
  }

  const completedAt = nowIso();
  let balanceAfter = 0;

  const completeOperation = db.transaction(() => {
    const fresh = db.prepare('SELECT * FROM change_accrual_operations WHERE id = ?').get(operationId);
    if (!fresh) throw new Error('OPERATION_NOT_FOUND');
    if (fresh.status === 'completed') {
      const client = db.prepare('SELECT stars_balance FROM clients WHERE id = ?').get(fresh.client_id);
      return Number(client?.stars_balance || 0);
    }
    if (fresh.status !== 'pending') throw new Error(`INVALID_OPERATION_STATUS:${fresh.status}`);

    const isTopup = fresh.operation_type === 'topup';
    const ledgerType = isTopup ? 'topup' : 'change_accrual';
    const ledgerSource = isTopup ? '1c_topup' : '1c_change';
    const ledgerDescription = isTopup
      ? `+${fresh.stars_amount} ⭐ поповнення`
      : `+${fresh.stars_amount} ⭐ з решти`;

    const nextBalance = awardStars(
      fresh.client_id,
      ledgerType,
      fresh.stars_amount,
      ledgerSource,
      ledgerDescription,
      body.receipt_id || fresh.receipt_id || null,
      null
    );

    const ledger = db.prepare(`SELECT id FROM star_ledger
      WHERE client_id = ? AND type = ? AND source = ?
      ORDER BY id DESC LIMIT 1`).get(fresh.client_id, ledgerType, ledgerSource);

    db.prepare(`UPDATE change_accrual_operations
      SET status = 'completed', receipt_id = COALESCE(?, receipt_id),
          receipt_number = COALESCE(?, receipt_number), fiscal_receipt_number = ?,
          ledger_id = ?, completed_at = ?, updated_at = ?
      WHERE id = ?`)
      .run(
        body.receipt_id || null,
        body.receipt_number || null,
        body.fiscal_receipt_number || null,
        ledger?.id || null,
        completedAt,
        completedAt,
        operationId
      );

    return nextBalance;
  });

  try {
    balanceAfter = completeOperation();
  } catch (error) {
    const message = String(error?.message || error);
    if (message === 'OPERATION_NOT_FOUND') return res.status(404).json({ ok: false, error: message });
    if (message.startsWith('INVALID_OPERATION_STATUS:')) {
      return res.status(409).json({ ok: false, error: message });
    }
    throw error;
  }

  logAudit({
    actorType: '1c',
    actorId: body.cashier || '1c',
    action: 'change_accrual_completed',
    entityType: 'change_accrual_operation',
    entityId: operationId,
    payload: { receipt_id: body.receipt_id || existing.receipt_id || null, stars_added: existing.stars_amount }
  });

  return res.json({
    ok: true,
    success: true,
    operation_id: operationId,
    status: 'completed',
    amount_cents: existing.amount_cents,
    stars_added: existing.stars_amount,
    stars_balance: balanceAfter
  });
});

app.post('/api/1c/change-accrual/cancel', oneCAuth, (req, res) => {
  const body = req.body || {};
  const operationId = String(body.operation_id || '').trim();
  if (!operationId) return res.status(400).json({ ok: false, error: 'OPERATION_ID_REQUIRED' });

  const operation = db.prepare('SELECT * FROM change_accrual_operations WHERE id = ?').get(operationId);
  if (!operation) return res.status(404).json({ ok: false, error: 'OPERATION_NOT_FOUND' });

  if (operation.status === 'cancelled') {
    return res.json({ ok: true, success: true, duplicate: true, operation_id: operationId, status: 'cancelled' });
  }
  if (operation.status === 'completed') {
    return res.status(409).json({ ok: false, error: 'COMPLETED_OPERATION_CANNOT_BE_CANCELLED' });
  }

  const cancelledAt = nowIso();
  db.prepare(`UPDATE change_accrual_operations
    SET status = 'cancelled', cancel_reason = ?, cancelled_at = ?, updated_at = ?
    WHERE id = ? AND status = 'pending'`)
    .run(body.reason || null, cancelledAt, cancelledAt, operationId);

  logAudit({
    actorType: '1c',
    actorId: body.cashier || '1c',
    action: 'change_accrual_cancelled',
    entityType: 'change_accrual_operation',
    entityId: operationId,
    payload: { reason: body.reason || null }
  });

  return res.json({ ok: true, success: true, operation_id: operationId, status: 'cancelled' });
});

app.post('/api/1c/receipts', oneCAuth, (req, res) => {
  const body = req.body || {};
  if (isReturnPayload(body)) return handleOneCReturn(req, res);
  const resolvedStore = findStoreFromPayload(body);
  const requestedStoreIdentity = body.store_external_id || body.store_id || body.store_name || '';
  const storeId = String(resolvedStore?.id || requestedStoreIdentity || '').trim();
  if (!body.id) return res.status(400).json({ ok: false, error: 'RECEIPT_ID_REQUIRED' });

  const rewardTokens = [];
  if (body.reward_qr_token) rewardTokens.push(String(body.reward_qr_token));
  if (Array.isArray(body.reward_qr_tokens)) rewardTokens.push(...body.reward_qr_tokens.map(String));
  const cleanRewardTokens = rewardTokens.map((t) => String(t || '').trim()).filter(Boolean);
  const personalCouponCode = String(body.personal_coupon_code || '').trim();
  const isRewardReceipt = cleanRewardTokens.length > 0;

  const existing = db.prepare('SELECT * FROM receipts WHERE id = ?').get(body.id);
  if (existing) {
    const finalized = [];
    for (const rewardToken of cleanRewardTokens) {
      finalized.push(finalizeRewardQrOnce({
        token: rewardToken,
        receiptId: body.id,
        actorId: storeId || '1c',
        storeId: storeId || '1c'
      }));
    }
    const changeAccrualCompleted = completePendingChangeAccrualForReceipt({
      receiptId: body.id,
      receiptNumber: body.receipt_number || body.number,
      fiscalReceiptNumber: body.fiscal_number,
      clientId: existing.client_id
    });
    return res.json({
      ok: true,
      duplicate: true,
      receipt_id: existing.id,
      stars_accrued: existing.stars_accrued,
      stars_spent: existing.stars_spent,
      change_accrual_completed: changeAccrualCompleted,
      reward_finalize: finalized
    });
  }

  let client = findClientForOneC({ card_number: body.card_number, card_token: body.card_token, phone: body.phone });

  // Для чека за зірки клієнта можна визначити напряму через QR, навіть якщо карта не передалась у чеку.
  if (!client && personalCouponCode) { const row=db.prepare('SELECT c.* FROM personal_coupons pc JOIN clients c ON c.id=pc.client_id WHERE pc.code=? LIMIT 1').get(personalCouponCode); if(row) client=row; }

  if (!client && cleanRewardTokens.length) {
    const row = db.prepare('SELECT c.* FROM reward_qrs q JOIN clients c ON c.id = q.client_id WHERE q.token = ? LIMIT 1').get(cleanRewardTokens[0]);
    if (row) client = row;
  }

  if (!client) {
    // Звичайний покупець без картки Star Club: чек у 1С не блокуємо і бонусну операцію не створюємо.
    // Для товару за зірки клієнт визначається через reward QR вище, тому цей skip стосується лише звичайних чеків.
    return res.json({
      ok: true,
      skipped: true,
      reason: 'NO_LOYALTY_CLIENT',
      receipt_id: body.id,
      stars_accrued: 0,
      stars_spent: 0
    });
  }

 const items = Array.isArray(body.items) ? body.items : [];
const totalCents = Math.round(Number(body.total_cents || 0));
const purchasedAt = body.purchased_at || nowIso();

/*
 * У чеку з товаром за зірки виключаємо лише сам товар,
 * позначений no_star_accrual=true.
 * Інші звичайні товари продовжують нараховувати зірки.
 */
const eligibleItems = items.filter((item) => {
  const flags = item?.flags || item || {};

  return !Boolean(
    flags.no_star_accrual ||
    flags.is_alcohol ||
    flags.is_tobacco ||
    flags.is_min_margin
  );
});

const eligibleCentsFromItems = eligibleItems.reduce(
  (sum, item) =>
    sum +
    Math.max(
      0,
      Math.round(
        Number(
          item.line_total_cents ??
          item.total_cents ??
          0
        )
      )
    ),
  0
);

/*
 * Беремо фактичну суму дозволених позицій.
 * body.eligible_cents використовуємо як резерв для старих чеків,
 * у яких немає масиву items.
 */
const eligibleCents = items.length
  ? eligibleCentsFromItems
  : Math.max(
      0,
      Math.round(
        Number(body.eligible_cents || 0)
      )
    );

const excludedCents = Math.max(
  0,
  totalCents - eligibleCents
);

/*
 * Клубні множники та спеціальні правила застосовуються
 * тільки до товарів, які дозволяють нарахування.
 */
const accrual = calculateAccrualWithOffers(
  eligibleItems,
  storeId,
  purchasedAt
);

const starsAccrued = eligibleItems.length
  ? Math.max(0, Number(accrual.stars || 0))
  : Math.floor(eligibleCents / 100);

  let starsSpent = Math.abs(Number(body.stars_spent || 0));
  if (isRewardReceipt && starsSpent === 0) {
    for (const rewardToken of cleanRewardTokens) {
      const row = db.prepare('SELECT stars_reserved FROM reward_qrs WHERE token = ?').get(rewardToken);
      if (row) starsSpent += Math.abs(Number(row.stars_reserved || 0));
    }
  }

  db.prepare(`INSERT INTO receipts(id, fiscal_number, client_id, store_id, cash_register, cashier, total_cents, eligible_cents, excluded_cents, stars_accrued, stars_spent, club_conditions_json, is_return, purchased_at, created_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`).run(
      body.id,
      body.fiscal_number || null,
      client.id,
      storeId || null,
      body.cash_register || null,
      body.cashier || null,
      totalCents,
      eligibleCents,
      excludedCents,
      starsAccrued,
      starsSpent,
      JSON.stringify([...(body.club_conditions || []), ...accrual.applied]),
      purchasedAt,
      nowIso()
    );

  const insertItem = db.prepare(`INSERT INTO receipt_items(receipt_id, product_id, external_product_id, name, category, qty, price_cents, line_total_cents, is_alcohol, is_tobacco, is_min_margin, no_star_accrual, no_redeem)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const adminExcludedCodes = getAdminStarAccrualExclusionSet();

  for (const item of items) {
    const flags = item.flags || item;
    const excludedFromStars = isItemExcludedFromStarAccrual(item, adminExcludedCodes);
    insertItem.run(
  body.id,
  item.product_id || null,
  item.external_product_id || null,
  item.name || 'Товар',
  item.category || null,
  Number(item.qty || 1),
  Math.round(Number(item.price_cents || 0)),
  Math.round(Number(item.line_total_cents || item.total_cents || 0)),
  flags.is_alcohol ? 1 : 0,
  flags.is_tobacco ? 1 : 0,
  flags.is_min_margin ? 1 : 0,
  excludedFromStars ? 1 : 0,
  flags.no_redeem ? 1 : 0
);
  }

  if (starsAccrued > 0) {
    awardStars(client.id, 'purchase_accrual', starsAccrued, 'receipt', `+${starsAccrued} ⭐ за покупку`, body.id, null);
  }

  const finalized = [];
  for (const rewardToken of cleanRewardTokens) {
    finalized.push(finalizeRewardQrOnce({
      token: rewardToken,
      receiptId: body.id,
      actorId: storeId || '1c',
      storeId: storeId || '1c'
    }));
  }

  db.prepare('UPDATE clients SET last_purchase_at = ?, updated_at = ? WHERE id = ?')
    .run(purchasedAt, nowIso(), client.id);

  const profileBonusResult = tryAwardProfileBonus(client.id, 'after_first_purchase');

  if (eligibleItems.length > 0) {
  addChallengeVisit(
    client.id,
    body.id,
    purchasedAt,
    eligibleCents,
    eligibleItems
  );

  updateStampProgress(
    client.id,
    body.id,
    eligibleItems
  );
}
  logAudit({
    actorType: '1c',
    actorId: storeId || '1c',
    action: isRewardReceipt ? 'reward_receipt_imported' : 'receipt_imported',
    entityType: 'receipt',
    entityId: body.id,
    payload: { starsAccrued, starsSpent, eligibleCents, rewardTokens: cleanRewardTokens, profileBonus: profileBonusResult }
  });

  const changeAccrualCompleted = completePendingChangeAccrualForReceipt({
    receiptId: body.id,
    receiptNumber: body.receipt_number || body.number,
    fiscalReceiptNumber: body.fiscal_number,
    clientId: client.id
  });

  let personalCouponFinalize = null;
  if (personalCouponCode) {
    const coupon=db.prepare('SELECT * FROM personal_coupons WHERE code=?').get(personalCouponCode);
    if(coupon && coupon.status==='active'){db.prepare("UPDATE personal_coupons SET status='used', used_at=? WHERE id=?").run(nowIso(),coupon.id);personalCouponFinalize={ok:true,status:'used',code:personalCouponCode};}
    else personalCouponFinalize={ok:false,error:coupon?'COUPON_STATUS_'+String(coupon.status).toUpperCase():'COUPON_NOT_FOUND'};
  }
  const fresh = db.prepare('SELECT * FROM clients WHERE id = ?').get(client.id);
  res.json({
    ok: true,
    duplicate: false,
    receipt_id: body.id,
    resolved_store_id: resolvedStore?.id || null,
    resolved_store_name: resolvedStore?.name || null,
    stars_accrued: starsAccrued,
    stars_spent: starsSpent,
    balance: fresh.stars_balance,
    change_accrual_completed: changeAccrualCompleted,
    reward_finalize: finalized,
    personal_coupon_finalize: personalCouponFinalize
  });
});

app.post('/api/1c/reward-qr/validate', oneCAuth, (req, res) => {
  const token = String(req.body?.token || req.body?.manual_code || req.body?.code || '').trim();
  if (!token) return res.status(400).json({ ok: false, valid: false, error: 'TOKEN_REQUIRED' });

  expireReservedRewardQrs();

  const row = db.prepare(`SELECT q.*, r.name, r.stars_price, r.product_external_id, r.store_id, r.conditions,
      sp.category AS program_category,
      sp.name AS program_name,
      COALESCE(p.price_cents, 0) AS product_price_cents,
      p.name AS product_1c_name,
      c.card_number, c.phone, c.name AS client_name, c.stars_balance
    FROM reward_qrs q
    JOIN reward_products r ON r.id = q.reward_product_id
    JOIN clients c ON c.id = q.client_id
    LEFT JOIN stamp_programs sp ON sp.id = q.program_id
    LEFT JOIN products p ON p.external_id = COALESCE(NULLIF(r.product_external_id, ''), NULLIF(sp.category, '')) OR p.id = COALESCE(NULLIF(r.product_external_id, ''), NULLIF(sp.category, ''))
    WHERE q.token = ?`).get(token);

  if (!row) {
    const coupon = db.prepare(`SELECT pc.*, c.card_number, c.phone, c.name AS client_name, COALESCE(p.price_cents,0) AS product_price_cents, COALESCE(p.name,pc.product_name) AS product_1c_name
      FROM personal_coupons pc JOIN clients c ON c.id=pc.client_id LEFT JOIN products p ON p.external_id=pc.product_external_id WHERE pc.code=?`).get(token);
    if (!coupon) return res.status(404).json({ ok: false, valid: false, error: 'QR_NOT_FOUND' });
    if (coupon.status !== 'active') return res.status(400).json({ ok:false,valid:false,error:'COUPON_STATUS_'+String(coupon.status).toUpperCase() });
    if (new Date(coupon.expires_at).getTime() < Date.now()) { db.prepare("UPDATE personal_coupons SET status='expired' WHERE id=?").run(coupon.id); return res.status(400).json({ok:false,valid:false,error:'COUPON_EXPIRED'}); }
    const original=Math.max(0,Number(coupon.product_price_cents||0)); const discounted=Math.max(0,Math.round(original*(100-Number(coupon.discount_percent||0))/100));
    return res.json({ok:true,valid:true,status:'active',qr:{code_type:'personal_coupon',source_type:'personal_coupon',token:coupon.code,manual_code:coupon.code,product_external_id:coupon.product_external_id,product_id:coupon.product_external_id,product_name:coupon.product_1c_name||coupon.product_name,qty:1,max_units:Math.max(1,Number(coupon.max_units||1)),max_discount_units:Math.max(1,Number(coupon.max_units||1)),price_cents:discounted,price_uah:money(discounted),original_price_cents:original,discount_percent:Number(coupon.discount_percent||0),expires_at:coupon.expires_at,client:{card_number:coupon.card_number,phone:coupon.phone,name:coupon.client_name}}});
  }
  if (row.status !== 'reserved') return res.status(400).json({ ok: false, valid: false, status: row.status, error: 'QR_ALREADY_' + row.status.toUpperCase() });
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare('UPDATE reward_qrs SET status = ?, canceled_at = ? WHERE id = ?').run('expired', nowIso(), row.id);
    return res.status(400).json({ ok: false, valid: false, status: 'expired', error: 'QR_EXPIRED' });
  }

  const productExternalId = String(row.product_external_id || (row.source_type === 'stamp_program' ? row.program_category : '') || '').trim();
  const productName = row.product_1c_name || (row.source_type === 'stamp_program' ? row.program_name : '') || row.name;
  const productPriceCents = Number(row.product_price_cents || 0);

  res.json({ ok: true, valid: true, status: 'reserved', qr: {
    id: row.id,
    token: row.token,
    manual_code: row.token,
    product_name: productName,
    product_external_id: productExternalId,
    product_id: productExternalId,
    product_1c_name: row.product_1c_name || productName,
    qty: 1,
    price_cents: productPriceCents,
    price_uah: money(productPriceCents),
    line_total_cents: productPriceCents,
    technical_price_cents: Math.max(1, Math.round(Number(process.env.REWARD_TECHNICAL_PRICE_CENTS || 10))),
    stars_to_spend: row.stars_reserved,
    expires_at: row.expires_at,
    conditions: row.conditions,
    store_id: row.store_id,
    source_type: row.source_type || 'stars',
    client: { card_number: row.card_number, phone: row.phone, name: row.client_name, balance: row.stars_balance }
  } });
});

app.post('/api/1c/reward-qr/finalize', oneCAuth, (req, res) => {
  const token = String(req.body?.token || req.body?.manual_code || req.body?.code || '').trim();
  const receiptId = String(req.body?.receipt_id || req.body?.receiptId || '').trim();
  const result = finalizeRewardQrOnce({
    token,
    receiptId,
    actorId: req.body?.store_id || '1c',
    storeId: req.body?.store_id || '1c'
  });
  if (!result.ok) {
    const status = result.error === 'QR_NOT_FOUND' ? 404 : 400;
    return res.status(status).json(result);
  }
  res.json(result);
});

app.post('/api/1c/reward-qr/cancel', oneCAuth, (req, res) => {
  const token = String(req.body?.token || '').trim();
  const row = db.prepare('SELECT * FROM reward_qrs WHERE token = ?').get(token);
  if (!row) return res.status(404).json({ ok: false, error: 'QR_NOT_FOUND' });
  if (row.status !== 'reserved') return res.status(400).json({ ok: false, error: 'QR_STATUS_' + row.status.toUpperCase() });
  db.prepare('UPDATE reward_qrs SET status = ?, canceled_at = ? WHERE id = ?').run('canceled', nowIso(), row.id);
  logAudit({ actorType: '1c', actorId: req.body?.store_id || '1c', action: 'reward_qr_canceled', entityType: 'reward_qr', entityId: String(row.id), payload: req.body });
  res.json({ ok: true, status: 'canceled' });
});

function handleOneCReturn(req, res) {
  const body = req.body || {};
  if (!body.id || !body.original_receipt_id) {
    return res.status(400).json({ ok: false, error: 'RETURN_ID_AND_ORIGINAL_REQUIRED' });
  }

  const existing = db.prepare('SELECT * FROM receipts WHERE id = ?').get(body.id);
  if (existing) {
    if (!existing.is_return || existing.original_receipt_id !== body.original_receipt_id) {
      return res.status(409).json({ ok: false, error: 'RETURN_ID_CONFLICT', message: 'Цей документ уже записаний як інша операція. Потрібна звірка, повторне нарахування заблоковано.' });
    }
    return res.json({ ok: true, duplicate: true, return_id: existing.id, stars_canceled: Math.max(0, -existing.stars_accrued) });
  }

  const original = db.prepare('SELECT * FROM receipts WHERE id = ?').get(body.original_receipt_id);
  if (!original) {
    return res.status(409).json({ ok: false, error: 'ORIGINAL_RECEIPT_NOT_FOUND', message: 'Спочатку синхронізуйте первинний чек продажу, потім повторіть повернення.' });
  }

  if (original.is_return) return res.status(400).json({ ok: false, error: 'ORIGINAL_MUST_BE_SALE' });

  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(original.client_id);
  if (!client) return res.status(404).json({ ok: false, error: 'CLIENT_NOT_FOUND' });

  const originalItems = db.prepare('SELECT * FROM receipt_items WHERE receipt_id = ?').all(original.id);
  const previous = db.prepare('SELECT * FROM receipts WHERE original_receipt_id = ? AND is_return = 1').all(original.id);
  const previousItems = db.prepare(`SELECT i.* FROM receipt_items i JOIN receipts r ON r.id = i.receipt_id
    WHERE r.original_receipt_id = ? AND r.is_return = 1`).all(original.id);
  let plan;
  try { plan = planReturn(original, originalItems, previous, previousItems, body); }
  catch (error) { return res.status(400).json({ ok: false, error: error.message }); }
  const { items, returnedEligibleCents, starsToCancel, isFullReturn } = plan;
  const originalEligibleCents = Math.max(0, Number(original.eligible_cents || 0));
  const originalStarsAccrued = Math.max(0, Number(original.stars_accrued || 0));

  const totalCents = Math.abs(Math.round(Number(body.total_cents || 0)));
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO receipts(id, fiscal_number, client_id, store_id, cash_register, cashier, total_cents, eligible_cents, excluded_cents, stars_accrued, stars_spent, is_return, original_receipt_id, purchased_at, created_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?, ?)`)
      .run(
        body.id,
        body.fiscal_number || null,
        client.id,
        body.store_id || original.store_id,
        body.cash_register || null,
        body.cashier || null,
        -totalCents,
        -returnedEligibleCents,
        0,
        -starsToCancel,
        body.original_receipt_id,
        body.returned_at || nowIso(),
        nowIso()
      );

    const insertItem = db.prepare(`INSERT INTO receipt_items(receipt_id, product_id, external_product_id, name, category, qty, price_cents, line_total_cents, is_alcohol, is_tobacco, is_min_margin, no_star_accrual, no_redeem)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    for (const item of items) {
      const flags = item.flags || item;
      insertItem.run(
        body.id,
        item.product_id || null,
        item.external_product_id || null,
        item.name || 'Повернення товару',
        item.category || null,
        -Math.abs(Number(item.qty || 1)),
        Math.abs(Math.round(Number(item.price_cents || 0))),
        -Math.abs(Math.round(Number(item.line_total_cents || item.total_cents || 0))),
        flags.is_alcohol ? 1 : 0,
        flags.is_tobacco ? 1 : 0,
        flags.is_min_margin ? 1 : 0,
        flags.no_star_accrual ? 1 : 0,
        flags.no_redeem ? 1 : 0
      );
    }

    if (starsToCancel > 0) {
      awardStars(client.id, 'return_cancel', -starsToCancel, 'return', `-${starsToCancel} ⭐ скасування нарахування через повернення`, body.id, null);
    }

    logAudit({
      actorType: '1c',
      actorId: body.store_id || '1c',
      action: 'return_imported',
      entityType: 'receipt',
      entityId: body.id,
      payload: {
        original: body.original_receipt_id,
        starsToCancel,
        fullReturn: isFullReturn,
        returnedEligibleCents,
        originalEligibleCents,
        originalStarsAccrued
      }
    });
  });

  tx();
  const fresh = db.prepare('SELECT * FROM clients WHERE id = ?').get(client.id);
  res.json({ ok: true, return_id: body.id, stars_canceled: starsToCancel, balance: fresh.stars_balance });
}
app.post('/api/1c/returns', oneCAuth, handleOneCReturn);

app.get('/api/catalog/products/:id/image', (req, res) => {
  const productId = normalizeOneCCode(req.params.id);
  if (!productId) return res.status(404).end();
  const row = db.prepare('SELECT mime_type, image_data FROM product_images WHERE product_id = ? LIMIT 1').get(productId);
  if (!row?.image_data) return res.status(404).end();
  const imageBuffer = Buffer.from(row.image_data);
  res.set('Cache-Control', 'no-store');
  res.type(row.mime_type || 'application/octet-stream');
  return res.send(imageBuffer);
});

app.post('/api/1c/products/image', oneCAuth, (req, res) => {
  const productExternalId = normalizeOneCCode(req.body?.external_id || req.body?.product_external_id || req.body?.product_id);
  if (!productExternalId) return res.status(400).json({ ok: false, error: 'PRODUCT_ID_REQUIRED' });

  const product = db.prepare('SELECT id, external_id FROM products WHERE external_id = ? OR id = ? LIMIT 1').get(productExternalId, productExternalId);
  if (!product) return res.status(404).json({ ok: false, error: 'PRODUCT_NOT_FOUND' });

  let raw = String(req.body?.image_base64 || req.body?.image || '').trim();
  const dataUriMatch = raw.match(/^data:image\/[^;]+;base64,(.+)$/i);
  if (dataUriMatch) raw = dataUriMatch[1];
  raw = raw.replace(/\s+/g, '');
  if (!raw) return res.status(400).json({ ok: false, error: 'IMAGE_REQUIRED' });
  if (raw.length > 14_000_000) return res.status(413).json({ ok: false, error: 'IMAGE_TOO_LARGE' });

  let imageBuffer;
  try {
    imageBuffer = Buffer.from(raw, 'base64');
  } catch {
    return res.status(400).json({ ok: false, error: 'IMAGE_BASE64_INVALID' });
  }
  if (!imageBuffer.length || imageBuffer.length > 10 * 1024 * 1024) {
    return res.status(413).json({ ok: false, error: 'IMAGE_TOO_LARGE' });
  }

  const mimeType = detectProductImageMime(imageBuffer);
  if (!mimeType) return res.status(415).json({ ok: false, error: 'IMAGE_FORMAT_UNSUPPORTED' });

  const t = nowIso();
  const imageUrl = productImageRoute(product.id);
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO product_images(product_id, mime_type, image_data, updated_at)
      VALUES(?, ?, ?, ?)
      ON CONFLICT(product_id) DO UPDATE SET
        mime_type = excluded.mime_type,
        image_data = excluded.image_data,
        updated_at = excluded.updated_at`).run(product.id, mimeType, imageBuffer, t);
    db.prepare('UPDATE products SET image_url = ?, updated_at = ? WHERE id = ?').run(imageUrl, t, product.id);
  });
  tx();

  return res.json({ ok: true, product_id: product.id, image_url: imageUrl, mime_type: mimeType, bytes: imageBuffer.length });
});

app.post('/api/1c/products/sync', oneCAuth, (req, res) => {
  const products = Array.isArray(req.body?.products) ? req.body.products : [];
  const t = nowIso();
  const defaultStoreExternalId = normalizeOneCCode(req.body?.store_external_id || req.body?.store_id);
  const defaultStoreName = String(req.body?.store_name || '').trim();

  const upsertProduct = db.prepare(`INSERT INTO products(
      external_id, id, name, category, group_external_id, group_name, group_path_json,
      image_url, price_cents, is_alcohol, is_tobacco, is_min_margin, no_star_accrual, no_redeem, updated_at
    ) VALUES(
      @external_id, @id, @name, @category, @group_external_id, @group_name, @group_path_json,
      @image_url, @price_cents, @is_alcohol, @is_tobacco, @is_min_margin, @no_star_accrual, @no_redeem, @updated_at
    ) ON CONFLICT(external_id) DO UPDATE SET
      name = excluded.name,
      category = excluded.category,
      group_external_id = excluded.group_external_id,
      group_name = excluded.group_name,
      group_path_json = excluded.group_path_json,
      image_url = COALESCE(excluded.image_url, products.image_url),
      is_alcohol = excluded.is_alcohol,
      is_tobacco = excluded.is_tobacco,
      is_min_margin = excluded.is_min_margin,
      no_star_accrual = excluded.no_star_accrual,
      no_redeem = excluded.no_redeem,
      updated_at = excluded.updated_at`);

  const upsertStore = db.prepare(`INSERT INTO stores(
      id, external_id, name, image_url, source, synced_at, is_active, created_at, updated_at
    ) VALUES(
      @id, @external_id, @name, '/assets/star.svg', '1c', @synced_at, 1, @created_at, @updated_at
    ) ON CONFLICT(id) DO UPDATE SET
      external_id = excluded.external_id,
      name = excluded.name,
      source = '1c',
      synced_at = excluded.synced_at,
      is_active = 1,
      updated_at = excluded.updated_at`);

  const upsertPrice = db.prepare(`INSERT INTO product_store_prices(
      product_id, store_id, synced_price_cents, manual_price_cents, use_manual_price,
      synced_at, created_at, updated_at
    ) VALUES(
      @product_id, @store_id, @synced_price_cents, NULL, 0,
      @synced_at, @created_at, @updated_at
    ) ON CONFLICT(product_id, store_id) DO UPDATE SET
      synced_price_cents = excluded.synced_price_cents,
      synced_at = excluded.synced_at,
      updated_at = excluded.updated_at`);

  const deleteProductBarcodes = db.prepare('DELETE FROM product_barcodes WHERE product_id = ?');
  const upsertProductBarcode = db.prepare(`INSERT INTO product_barcodes(barcode, product_id, is_primary, created_at, updated_at)
    VALUES(?, ?, ?, ?, ?)
    ON CONFLICT(barcode) DO UPDATE SET product_id = excluded.product_id, is_primary = excluded.is_primary, updated_at = excluded.updated_at`);

  let synced = 0;
  let pricesSynced = 0;
  let zeroPrices = 0;
  let barcodesSynced = 0;
  let productsWithBarcodes = 0;
  let productsWithoutBarcodes = 0;
  const storesSynced = new Set();
  const touchedProducts = new Set();
  const tx = db.transaction(() => {
    for (const p of products) {
      const productExternalId = normalizeOneCCode(p?.external_id);
      if (!productExternalId) continue;
      const flags = p.flags || p;
      const storeExternalId = normalizeOneCCode(p.store_external_id || p.store_id || defaultStoreExternalId);
      const storeName = String(p.store_name || defaultStoreName || storeExternalId || '').trim();
      const rawPrice = Number(p.price_cents);
      const priceCents = Number.isFinite(rawPrice) ? Math.max(0, Math.round(rawPrice)) : 0;

      upsertProduct.run({
        external_id: productExternalId,
        id: productExternalId,
        name: p.name || 'Товар',
        category: p.category || p.group_name || null,
        group_external_id: p.group_external_id ? normalizeOneCCode(p.group_external_id) : null,
        group_name: p.group_name || p.category || null,
        group_path_json: Array.isArray(p.group_path) ? JSON.stringify(p.group_path.map(normalizeOneCCode).filter(Boolean)) : null,
        image_url: p.image_url ? normalizeImageUrl(p.image_url) : null,
        price_cents: priceCents,
        is_alcohol: flags.is_alcohol ? 1 : 0,
        is_tobacco: flags.is_tobacco ? 1 : 0,
        is_min_margin: flags.is_min_margin ? 1 : 0,
        no_star_accrual: flags.no_star_accrual ? 1 : 0,
        no_redeem: flags.no_redeem ? 1 : 0,
        updated_at: t
      });

      if (payloadHasProductBarcodes(p)) {
        const barcodes = productBarcodesFromPayload(p);
        deleteProductBarcodes.run(productExternalId);
        barcodes.forEach((barcode, index) => {
          upsertProductBarcode.run(barcode, productExternalId, index === 0 ? 1 : 0, t, t);
          barcodesSynced += 1;
        });
        if (barcodes.length) productsWithBarcodes += 1;
        else productsWithoutBarcodes += 1;
      } else {
        productsWithoutBarcodes += 1;
      }

      if (storeExternalId) {
        upsertStore.run({
          id: storeExternalId,
          external_id: storeExternalId,
          name: storeName || storeExternalId,
          synced_at: t,
          created_at: t,
          updated_at: t
        });
        upsertPrice.run({
          product_id: productExternalId,
          store_id: storeExternalId,
          synced_price_cents: priceCents,
          synced_at: t,
          created_at: t,
          updated_at: t
        });
        storesSynced.add(storeExternalId);
        touchedProducts.add(productExternalId);
        pricesSynced += 1;
        if (priceCents === 0) zeroPrices += 1;
      }
      synced += 1;
    }
    for (const productId of touchedProducts) refreshLegacyProductPrice(productId);
  });
  tx();
  res.json({
    ok: true,
    synced,
    stores_synced: storesSynced.size,
    prices_synced: pricesSynced,
    barcodes_synced: barcodesSynced,
    products_with_barcodes: productsWithBarcodes,
    products_without_barcodes: productsWithoutBarcodes,
    zero_prices: zeroPrices
  });
});


app.post('/api/1c/personal-coupon/validate', oneCAuth, (req, res) => {
  const code = String(req.body?.code || req.body?.coupon_code || '').trim();
  if (!code) return res.status(400).json({ ok: false, valid: false, error: 'COUPON_CODE_REQUIRED' });
  const row = db.prepare(`SELECT pc.*, c.name AS client_name, c.phone, c.card_number
    FROM personal_coupons pc
    JOIN clients c ON c.id = pc.client_id
    WHERE pc.code = ?`).get(code);
  if (!row) return res.status(404).json({ ok: false, valid: false, error: 'COUPON_NOT_FOUND' });
  if (row.status !== 'active') return res.status(400).json({ ok: false, valid: false, error: 'COUPON_STATUS_' + row.status.toUpperCase(), status: row.status });
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare("UPDATE personal_coupons SET status = 'expired' WHERE id = ?").run(row.id);
    return res.status(400).json({ ok: false, valid: false, error: 'COUPON_EXPIRED', status: 'expired' });
  }
  res.json({ ok: true, valid: true, coupon: {
    code: row.code,
    discount_percent: row.discount_percent,
    max_units: Math.max(1, Number(row.max_units || 1)),
    max_discount_units: Math.max(1, Number(row.max_units || 1)),
    qty: 1,
    product_external_id: row.product_external_id,
    product_name: row.product_name,
    expires_at: row.expires_at,
    client: { name: row.client_name, phone: row.phone, card_number: row.card_number }
  } });
});

app.post('/api/1c/personal-coupon/finalize', oneCAuth, (req, res) => {
  const code = String(req.body?.code || req.body?.coupon_code || '').trim();
  const receiptId = String(req.body?.receipt_id || '').trim();
  if (!code || !receiptId) return res.status(400).json({ ok: false, error: 'CODE_AND_RECEIPT_REQUIRED' });
  const row = db.prepare('SELECT * FROM personal_coupons WHERE code = ?').get(code);
  if (!row) return res.status(404).json({ ok: false, error: 'COUPON_NOT_FOUND' });
  if (row.status !== 'active') return res.status(400).json({ ok: false, error: 'COUPON_STATUS_' + row.status.toUpperCase(), status: row.status });
  db.prepare("UPDATE personal_coupons SET status = 'used', used_at = ? WHERE id = ?").run(nowIso(), row.id);
  logAudit({ actorType: '1c', actorId: req.body?.store_id || '1c', action: 'personal_coupon_used', entityType: 'personal_coupon', entityId: String(row.id), payload: { code, receiptId } });
  res.json({ ok: true, status: 'used', code, receipt_id: receiptId });
});


// ---------------- Admin CRUD for ТЗ v1.1 ----------------
app.get('/api/admin/stores', adminAuth, (req, res) => {
  const stores = db.prepare(`SELECT s.*, COUNT(psp.id) AS prices_count
    FROM stores s
    LEFT JOIN product_store_prices psp ON psp.store_id = s.id
    GROUP BY s.id
    ORDER BY CASE WHEN s.source = '1c' THEN 0 ELSE 1 END, s.name`).all();
  res.json({ ok: true, stores });
});

app.post('/api/admin/stores', adminAuth, (req, res) => {
  const b = req.body || {};
  const id = normalizeOneCCode(b.id || b.external_id);
  const name = String(b.name || '').trim();
  if (!id || !name) return res.status(400).json({ ok: false, error: 'STORE_ID_AND_NAME_REQUIRED' });
  const t = nowIso();
  db.prepare(`INSERT INTO stores(id, external_id, name, address, work_hours, phone, image_url, source, is_active, created_at, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET external_id=excluded.external_id, name=excluded.name, address=excluded.address, work_hours=excluded.work_hours, phone=excluded.phone, image_url=excluded.image_url, is_active=excluded.is_active, updated_at=excluded.updated_at`)
    .run(id, id, name, b.address || null, b.work_hours || null, b.phone || null, b.image_url || '/assets/star.svg', b.is_active === false ? 0 : 1, t, t);
  logAudit({ actorType: 'admin', actorId: String(req.admin.id), action: 'store_saved', entityType: 'store', entityId: id, payload: b });
  res.json({ ok: true, id });
});

app.patch('/api/admin/stores/:id', adminAuth, (req, res) => {
  const existing = db.prepare('SELECT * FROM stores WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ ok: false, error: 'STORE_NOT_FOUND' });
  const b = req.body || {};
  db.prepare('UPDATE stores SET name=?, address=?, work_hours=?, phone=?, image_url=?, is_active=?, updated_at=? WHERE id=?')
    .run(b.name ?? existing.name, b.address ?? existing.address, b.work_hours ?? existing.work_hours, b.phone ?? existing.phone, b.image_url ?? existing.image_url, b.is_active === undefined ? existing.is_active : (b.is_active ? 1 : 0), nowIso(), req.params.id);
  logAudit({ actorType: 'admin', actorId: String(req.admin.id), action: 'store_updated', entityType: 'store', entityId: req.params.id, payload: b });
  res.json({ ok: true });
});

app.delete('/api/admin/stores/:id', adminAuth, (req, res) => {
  const existing = db.prepare('SELECT * FROM stores WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ ok: false, error: 'STORE_NOT_FOUND' });
  db.prepare('UPDATE stores SET is_active = 0, updated_at = ? WHERE id = ?').run(nowIso(), req.params.id);
  logAudit({ actorType: 'admin', actorId: String(req.admin.id), action: 'store_disabled', entityType: 'store', entityId: req.params.id, payload: {} });
  res.json({ ok: true });
});

app.get('/api/admin/catalog/rewards', adminAuth, (req, res) => {
  res.json({ ok: true, items: db.prepare('SELECT * FROM reward_products ORDER BY id DESC').all() });
});

function resolveRewardProductFromOneC(productExternalId) {
  const code = normalizeOneCCode(productExternalId);
  if (!code) return null;
  return db.prepare(`SELECT external_id, name, image_url
    FROM products
    WHERE external_id = ?
    LIMIT 1`).get(code) || null;
}

app.post('/api/admin/catalog/rewards', adminAuth, (req, res) => {
  const b = req.body || {};
  const productCode = normalizeOneCCode(b.product_external_id);
  const syncedProduct = productCode ? resolveRewardProductFromOneC(productCode) : null;
  if (productCode && !syncedProduct) return res.status(400).json({ ok: false, error: 'PRODUCT_NOT_FOUND_IN_1C_SYNC' });
  const resolvedName = String(syncedProduct?.name || b.name || '').trim();
  if (!resolvedName || !Number(b.stars_price)) return res.status(400).json({ ok: false, error: 'NAME_AND_STARS_REQUIRED' });
  const t = nowIso();
  const row = {
    product_external_id: productCode || null,
    name: resolvedName,
    image_url: b.image_url || '/assets/star.svg',
    stars_price: Math.round(Number(b.stars_price)),
    store_id: b.store_id || 'all',
    active_from: b.active_from || t,
    active_to: b.active_to || null,
    total_limit: b.total_limit ? Number(b.total_limit) : null,
    per_client_limit: b.per_client_limit ? Number(b.per_client_limit) : 1,
    conditions: b.conditions || null,
    created_at: t,
    updated_at: t
  };
  const result = db.prepare(`INSERT INTO reward_products(product_external_id, name, image_url, stars_price, store_id, active_from, active_to, total_limit, per_client_limit, conditions, created_at, updated_at)
    VALUES(@product_external_id, @name, @image_url, @stars_price, @store_id, @active_from, @active_to, @total_limit, @per_client_limit, @conditions, @created_at, @updated_at)`).run(row);
  logAudit({ actorType: 'admin', actorId: 'admin', action: 'reward_product_created', entityType: 'reward_product', entityId: String(result.lastInsertRowid), payload: row });
  res.json({ ok: true, id: result.lastInsertRowid });
});

app.patch('/api/admin/catalog/rewards/:id', adminAuth, (req, res) => {
  const b = req.body || {};
  const existing = db.prepare('SELECT * FROM reward_products WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ ok: false, error: 'REWARD_NOT_FOUND' });
  const productCode = normalizeOneCCode(b.product_external_id ?? existing.product_external_id);
  const syncedProduct = productCode ? resolveRewardProductFromOneC(productCode) : null;
  if (productCode && !syncedProduct) return res.status(400).json({ ok: false, error: 'PRODUCT_NOT_FOUND_IN_1C_SYNC' });
  const resolvedName = String(syncedProduct?.name || b.name || existing.name || '').trim();
  db.prepare(`UPDATE reward_products SET product_external_id = ?, name = ?, image_url = ?, stars_price = ?, store_id = ?, active_from = ?, active_to = ?, total_limit = ?, per_client_limit = ?, conditions = ?, is_active = ?, updated_at = ? WHERE id = ?`)
    .run(productCode || null, resolvedName, b.image_url ?? existing.image_url, b.stars_price ?? existing.stars_price, b.store_id ?? existing.store_id, b.active_from ?? existing.active_from, b.active_to ?? existing.active_to, b.total_limit ?? existing.total_limit, b.per_client_limit ?? existing.per_client_limit, b.conditions ?? existing.conditions, b.is_active === undefined ? existing.is_active : (b.is_active ? 1 : 0), nowIso(), req.params.id);
  logAudit({ actorType: 'admin', actorId: 'admin', action: 'reward_product_updated', entityType: 'reward_product', entityId: req.params.id, payload: b });
  res.json({ ok: true });
});

function parseJsonArraySafe(value) {
  if (!value) return null;
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function resolvePricingTarget(targetRef, explicitType = null) {
  const rawRef = String(targetRef || '').trim();
  const type = explicitType ? String(explicitType) : null;
  if (type === 'all' || !rawRef) return { target_type: type || 'all', target_value: null };

  const ref = normalizeOneCCode(rawRef);
  if (type === 'product' || type === 'group') {
    return { target_type: type, target_value: ref };
  }
  if (type === 'category') return { target_type: 'category', target_value: rawRef };

  // Коди товарів і груп мають однаковий вигляд ЦБ000004323,
  // тому без explicitType спочатку використовуємо вже синхронізовані дані.
  const product = db.prepare('SELECT external_id FROM products WHERE external_id = ? LIMIT 1').get(ref);
  if (product) return { target_type: 'product', target_value: normalizeOneCCode(product.external_id) };

  const group = db.prepare(`SELECT group_external_id FROM products
    WHERE group_external_id = ? LIMIT 1`).get(ref);
  if (group?.group_external_id) {
    return { target_type: 'group', target_value: normalizeOneCCode(group.group_external_id) };
  }

  // Старі виклики без типу лишаємо сумісними, але нова адмінка завжди передає type.
  return { target_type: 'group', target_value: ref };
}

function normalizeOfferPriceInput(body, existing = null) {
  const mode = body.price_mode !== undefined ? (body.price_mode || null) : (existing?.price_mode || null);
  if (!mode) {
    if (body.club_price_cents !== undefined && body.club_price_cents !== null && body.club_price_cents !== '') {
      return { price_mode: 'fixed', price_value: Math.round(Number(body.club_price_cents)), club_price_cents: Math.round(Number(body.club_price_cents)) };
    }
    return { price_mode: null, price_value: null, club_price_cents: null };
  }

  let priceValue;
  if (body.price_value === undefined) priceValue = existing?.price_value ?? null;
  else if (mode === 'percent') priceValue = Number(body.price_value || 0);
  else priceValue = Math.round(Number(body.price_value || 0) * 100);

  if (body.price_value_cents !== undefined && mode !== 'percent') {
    priceValue = Math.round(Number(body.price_value_cents || 0));
  }

  return {
    price_mode: mode,
    price_value: priceValue,
    club_price_cents: mode === 'fixed' ? priceValue : null
  };
}

function defaultOfferPriority(type, targetType) {
  if (type === 'wholesale') return targetType === 'product' ? 450 : 400;
  if (type === 'club') return targetType === 'product' ? 300 : 200;
  return 100;
}

function normalizeOfferTiers(body, existing = null) {
  if (Array.isArray(body.tiers)) return JSON.stringify(body.tiers);
  if (body.tiers_json !== undefined) return body.tiers_json || null;
  return existing?.tiers_json || null;
}

app.get('/api/admin/catalog/star-exclusions', adminAuth, (req, res) => {
  const excluded = db.prepare(`SELECT e.product_external_id, e.created_at, e.created_by,
      COALESCE(p.name, e.product_external_id) AS name,
      p.group_name, p.price_cents
    FROM star_accrual_exclusions e
    LEFT JOIN products p ON p.external_id = e.product_external_id
    ORDER BY COALESCE(p.name, e.product_external_id)`).all();
  res.json({ ok: true, excluded });
});

app.put('/api/admin/catalog/star-exclusions', adminAuth, (req, res) => {
  const rawCodes = Array.isArray(req.body?.product_external_ids) ? req.body.product_external_ids : [];
  const codes = [...new Set(rawCodes.map(normalizeOneCCode).filter(Boolean))];
  const findProduct = db.prepare('SELECT external_id FROM products WHERE external_id = ? LIMIT 1');
  const unknown = codes.filter((code) => !findProduct.get(code));
  if (unknown.length) {
    return res.status(400).json({ ok: false, error: 'UNKNOWN_PRODUCTS', message: `Не знайдено в номенклатурі 1С: ${unknown.slice(0, 10).join(', ')}` });
  }

  const actorId = String(req.admin?.id || req.admin?.telegram_id || 'admin');
  const createdAt = nowIso();
  const replaceAll = db.transaction(() => {
    db.prepare('DELETE FROM star_accrual_exclusions').run();
    const insert = db.prepare('INSERT INTO star_accrual_exclusions(product_external_id, created_at, created_by) VALUES(?, ?, ?)');
    for (const code of codes) insert.run(code, createdAt, actorId);
  });
  replaceAll();
  logAudit({ actorType: 'admin', actorId, action: 'star_accrual_exclusions_updated', entityType: 'settings', entityId: 'star_accrual_exclusions', payload: { product_external_ids: codes } });
  res.json({ ok: true, count: codes.length, product_external_ids: codes });
});

app.get('/api/admin/catalog/star-group-exclusions', adminAuth, (req, res) => {
  const groups = db.prepare('SELECT group_external_id, group_name, created_at FROM star_accrual_group_exclusions ORDER BY group_name, group_external_id').all();
  res.json({ ok: true, groups });
});

app.put('/api/admin/catalog/star-group-exclusions', adminAuth, (req, res) => {
  const groups = Array.isArray(req.body?.groups) ? req.body.groups : [];
  const actorId = String(req.admin?.id || 'admin');
  db.transaction(() => {
    db.prepare('DELETE FROM star_accrual_group_exclusions').run();
    const insert = db.prepare('INSERT INTO star_accrual_group_exclusions(group_external_id, group_name, created_at, created_by) VALUES(?, ?, ?, ?)');
    groups.forEach((group) => { const code = normalizeProductCode(group?.group_external_id || group?.id); if (code) insert.run(code, String(group?.group_name || group?.name || ''), nowIso(), actorId); });
  })();
  res.json({ ok: true, count: groups.length });
});


app.get('/api/admin/catalog/product-groups', adminAuth, (req, res) => {
  const storeId = String(req.query.store_id || '').trim();
  const rows = db.prepare(`SELECT external_id, group_external_id, group_name, category, group_path_json, price_cents, id FROM products`).all();
  const groups = new Map();
  const touch = (id, name, product, priceCents) => {
    const key = normalizeOneCCode(id);
    if (!key) return;
    const current = groups.get(key) || { id: key, name: String(name || key), products: new Set(), prices: [] };
    if ((!current.name || current.name === current.id) && name) current.name = String(name);
    if (product?.external_id) current.products.add(String(product.external_id));
    const storePrice = storeId ? priceForProductAndStore(product, storeId) : priceCents;
    const price = Math.max(0, Math.round(Number(storePrice || 0)));
    if (price > 0) current.prices.push(price);
    groups.set(key, current);
  };
  for (const row of rows) {
    touch(row.group_external_id, row.group_name || row.category, row, row.price_cents);
    const path = parseJsonArraySafe(row.group_path_json) || [];
    for (const groupId of path) touch(groupId, groupId, row, row.price_cents);
  }
  const result = [...groups.values()].map((g) => ({
    id: g.id, name: g.name, products_count: g.products.size,
    min_price_cents: g.prices.length ? Math.min(...g.prices) : null,
    max_price_cents: g.prices.length ? Math.max(...g.prices) : null
  })).sort((a, b) => String(a.name).localeCompare(String(b.name), 'uk'));
  res.json({ ok: true, groups: result, store_id: storeId || null });
});

app.get('/api/admin/catalog/products', adminAuth, (req, res) => {
  const q = String(req.query.q || '').trim();
  const groupId = normalizeOneCCode(req.query.group_id);
  const storeId = String(req.query.store_id || '').trim();
  const clauses = [];
  const args = [];
  if (q) {
    const mask = `%${q}%`;
    clauses.push('(p.name LIKE ? OR p.external_id LIKE ? OR p.group_name LIKE ? OR p.category LIKE ?)');
    args.push(mask, mask, mask, mask);
  }
  if (groupId) {
    clauses.push('(p.group_external_id = ? OR p.group_path_json LIKE ?)');
    args.push(groupId, `%"${groupId.replaceAll('\"', '')}"%`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const products = db.prepare(`SELECT p.id, p.external_id, p.name, p.category, p.group_external_id, p.group_name, p.price_cents AS legacy_price_cents, p.image_url
    FROM products p ${where} ORDER BY p.name LIMIT 10000`).all(...args).map((product) => {
      const storePrice = storeId ? getProductStorePrice(product.id, storeId) : null;
      return {
        ...product,
        store_id: storeId || null,
        synced_price_cents: storePrice?.synced_price_cents ?? null,
        manual_price_cents: storePrice?.manual_price_cents ?? null,
        use_manual_price: storePrice?.use_manual_price ?? 0,
        price_cents: storePrice?.effective_price_cents ?? product.legacy_price_cents
      };
    });
  res.json({ ok: true, products, store_id: storeId || null });
});

app.get('/api/admin/catalog/store-prices', adminAuth, (req, res) => {
  const q = String(req.query.q || '').trim();
  const selectedStoreId = String(req.query.store_id || '').trim();
  const limit = Math.min(500, Math.max(1, Number(req.query.limit || 100)));
  const clauses = [];
  const args = [];
  if (q) {
    const mask = `%${q}%`;
    clauses.push('(p.name LIKE ? OR p.external_id LIKE ? OR p.group_name LIKE ?)');
    args.push(mask, mask, mask);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const products = db.prepare(`SELECT p.* FROM products p ${where} ORDER BY p.name LIMIT ${limit}`).all(...args);
  const priceRows = db.prepare(`SELECT psp.*, s.name AS store_name, s.external_id AS store_external_id
    FROM product_store_prices psp JOIN stores s ON s.id = psp.store_id
    WHERE s.is_active = 1 ${selectedStoreId ? 'AND psp.store_id = ?' : ''}
    ORDER BY s.name`).all(...(selectedStoreId ? [selectedStoreId] : []));
  const byProduct = new Map();
  for (const row of priceRows) {
    const list = byProduct.get(String(row.product_id)) || [];
    list.push({ ...row, effective_price_cents: effectiveStorePriceCents(row) });
    byProduct.set(String(row.product_id), list);
  }
  res.json({ ok: true, products: products.map((product) => ({ ...product, prices: byProduct.get(String(product.id)) || [] })) });
});

app.patch('/api/admin/catalog/product-store-prices', adminAuth, (req, res) => {
  const b = req.body || {};
  const productId = normalizeOneCCode(b.product_id || b.product_external_id);
  const storeId = normalizeOneCCode(b.store_id);
  if (!productId || !storeId) return res.status(400).json({ ok: false, error: 'PRODUCT_AND_STORE_REQUIRED' });
  const product = productCatalogRowByCode(productId);
  const store = db.prepare('SELECT * FROM stores WHERE id = ? OR external_id = ? LIMIT 1').get(storeId, storeId);
  if (!product || !store) return res.status(404).json({ ok: false, error: 'PRODUCT_OR_STORE_NOT_FOUND' });
  const existing = getProductStorePrice(product.id, store.id);
  const t = nowIso();
  if (!existing) {
    db.prepare(`INSERT INTO product_store_prices(product_id, store_id, synced_price_cents, manual_price_cents, use_manual_price, synced_at, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?)`).run(product.id, store.id, Math.max(0, Math.round(Number(b.synced_price_cents || 0))), nullableCents(b.manual_price_cents), b.use_manual_price ? 1 : 0, t, t, t);
  } else {
    db.prepare(`UPDATE product_store_prices SET manual_price_cents=?, use_manual_price=?, updated_at=? WHERE product_id=? AND store_id=?`)
      .run(nullableCents(b.manual_price_cents, existing.manual_price_cents), b.use_manual_price ? 1 : 0, t, product.id, store.id);
  }
  refreshLegacyProductPrice(product.id);
  const saved = getProductStorePrice(product.id, store.id);
  logAudit({ actorType: 'admin', actorId: String(req.admin?.id || 'admin'), action: 'product_store_price_updated', entityType: 'product', entityId: product.id, payload: b });
  res.json({ ok: true, price: saved });
});

app.get('/api/admin/catalog/offers', adminAuth, (req, res) => {
  const rows = db.prepare(`SELECT o.*, s.name AS store_name FROM offers o
    LEFT JOIN stores s ON s.id = o.store_id ORDER BY o.id DESC`).all().map((o) => ({
    ...o,
    tiers: parseJsonArraySafe(o.tiers_json),
    target_type: getOfferTargetType(o),
    target_value: getOfferTargetValue(o),
    price_value_uah: (o.price_mode === 'amount' || o.price_mode === 'fixed') ? Number(o.price_value || 0) / 100 : null,
    effective_old_price_cents: offerEffectiveOldPrice(o, o.calculated_old_price_cents),
    effective_new_price_cents: offerManualNewPrice(o) ?? o.calculated_new_price_cents
  }));
  res.json({ ok: true, offers: rows });
});

function validatePricingStoreAndFixed(body, targetType, targetValues) {
  const storeId = String(body.store_id || '').trim();
  if ((body.type === 'club' || body.type === 'wholesale') && !storeId) return 'STORE_REQUIRED';
  if (body.type === 'club' && body.price_mode === 'fixed' && (targetType !== 'product' || targetValues.length !== 1)) return 'FIXED_PRICE_SINGLE_PRODUCT_ONLY';
  return null;
}

function pricingOfferInsertStatement() {
  return db.prepare(`INSERT INTO offers(
      type, name, description, image_url, product_external_id, category,
      target_type, target_value, price_mode, price_value, priority, parent_offer_id, visible_in_app, rounding_mode,
      club_price_cents, old_price_cents, calculated_old_price_cents, calculated_new_price_cents,
      manual_old_price_cents, use_manual_old_price, manual_new_price_cents, use_manual_new_price,
      stars_multiplier, tiers_json, store_id, audience, active_from, active_to, is_active, created_at, updated_at
    ) VALUES(
      @type, @name, @description, @image_url, @product_external_id, @category,
      @target_type, @target_value, @price_mode, @price_value, @priority, @parent_offer_id, @visible_in_app, @rounding_mode,
      @club_price_cents, @old_price_cents, @calculated_old_price_cents, @calculated_new_price_cents,
      @manual_old_price_cents, @use_manual_old_price, @manual_new_price_cents, @use_manual_new_price,
      @stars_multiplier, @tiers_json, @store_id, @audience, @active_from, @active_to, @is_active, @created_at, @updated_at
    )`);
}

function makePricingOfferRow(body, targetType, targetValue, createdAt, nameOverride = null, existing = null) {
  const price = normalizeOfferPriceInput(body, existing || undefined);
  const tiersJson = normalizeOfferTiers(body, existing || undefined);
  const snapshot = buildOfferSnapshotFields({
    body, existing, targetType, targetValue, storeId: body.store_id || existing?.store_id,
    type: body.type || existing?.type, price, tiersJson
  });
  return {
    type: String(body.type || existing?.type),
    name: nameOverride || String(body.name ?? existing?.name ?? '').trim(),
    description: body.description === undefined ? existing?.description : (body.description || null),
    image_url: body.image_url === undefined ? existing?.image_url : normalizeImageUrl(body.image_url),
    product_external_id: targetType === 'product' ? targetValue : null,
    category: targetType === 'group' || targetType === 'category' ? targetValue : null,
    target_type: targetType,
    target_value: targetValue,
    price_mode: price.price_mode,
    price_value: price.price_value,
    priority: Number(body.priority ?? existing?.priority ?? defaultOfferPriority(body.type || existing?.type, targetType)),
    parent_offer_id: body.parent_offer_id ?? existing?.parent_offer_id ?? null,
    visible_in_app: body.visible_in_app === undefined ? (existing?.visible_in_app ?? 1) : (body.visible_in_app ? 1 : 0),
    rounding_mode: body.rounding_mode || existing?.rounding_mode || 'kopeck',
    club_price_cents: price.club_price_cents,
    old_price_cents: snapshot.old_price_cents,
    calculated_old_price_cents: snapshot.calculated_old_price_cents,
    calculated_new_price_cents: snapshot.calculated_new_price_cents,
    manual_old_price_cents: snapshot.manual_old_price_cents,
    use_manual_old_price: snapshot.use_manual_old_price,
    manual_new_price_cents: snapshot.manual_new_price_cents,
    use_manual_new_price: snapshot.use_manual_new_price,
    stars_multiplier: body.stars_multiplier === undefined ? (existing?.stars_multiplier ?? null) : (body.stars_multiplier ? Number(body.stars_multiplier) : null),
    tiers_json: tiersJson,
    store_id: body.store_id || existing?.store_id || 'all',
    audience: body.audience || existing?.audience || 'all',
    active_from: body.active_from || existing?.active_from || createdAt,
    active_to: body.active_to === undefined ? (existing?.active_to ?? null) : (body.active_to || null),
    is_active: body.is_active === undefined ? (existing?.is_active ?? 1) : (body.is_active ? 1 : 0),
    created_at: existing?.created_at || createdAt,
    updated_at: createdAt
  };
}

app.post('/api/admin/catalog/offers', adminAuth, (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.type) return res.status(400).json({ ok: false, error: 'TYPE_AND_NAME_REQUIRED' });
  const target = resolvePricingTarget(b.target_value || b.target_ref || b.product_external_id || b.category, b.target_type);
  const validationError = validatePricingStoreAndFixed(b, target.target_type, [target.target_value]);
  if (validationError) return res.status(400).json({ ok: false, error: validationError });
  const t = nowIso();
  const row = makePricingOfferRow(b, target.target_type, target.target_value, t);
  const result = pricingOfferInsertStatement().run(row);
  logAudit({ actorType: 'admin', actorId: String(req.admin?.id || 'admin'), action: 'offer_created', entityType: 'offer', entityId: String(result.lastInsertRowid), payload: row });
  res.json({ ok: true, id: result.lastInsertRowid, saved: db.prepare('SELECT * FROM offers WHERE id = ?').get(result.lastInsertRowid) });
});

app.post('/api/admin/catalog/pricing/bulk', adminAuth, (req, res) => {
  const b = req.body || {};
  const targetType = String(b.target_type || 'group');
  const targetValues = Array.isArray(b.target_values) ? [...new Set(b.target_values.map((v) => targetType === 'all' ? 'all' : normalizeOneCCode(v)).filter(Boolean))] : [];
  if (!targetValues.length) return res.status(400).json({ ok: false, error: 'TARGETS_REQUIRED' });
  if (!b.type || !b.name) return res.status(400).json({ ok: false, error: 'TYPE_AND_NAME_REQUIRED' });
  const validationError = validatePricingStoreAndFixed(b, targetType, targetValues);
  if (validationError) return res.status(400).json({ ok: false, error: validationError });

  const createdIds = [];
  const createdAt = nowIso();
  const insert = pricingOfferInsertStatement();
  const tx = db.transaction(() => {
    for (const targetValue of targetValues) {
      const product = targetType === 'product' ? productCatalogRowByCode(targetValue) : null;
      const separateName = targetValues.length > 1 && product ? `${String(b.name).trim()} — ${product.name}` : String(b.name).trim();
      const row = makePricingOfferRow({ ...b, visible_in_app: b.visible_in_app !== false }, targetType, targetValue, createdAt, separateName);
      const result = insert.run(row);
      createdIds.push(result.lastInsertRowid);
    }
  });
  tx();
  logAudit({ actorType: 'admin', actorId: String(req.admin?.id || 'admin'), action: 'pricing_bulk_created', entityType: 'offer', entityId: String(createdIds[0] || ''), payload: { type: b.type, targetType, targetValues, created: createdIds.length } });
  res.json({ ok: true, created: createdIds.length, ids: createdIds });
});


app.get('/api/admin/catalog/promo-offers', adminAuth, (req, res) => {
  const items = db.prepare('SELECT * FROM promo_offers ORDER BY id DESC').all()
    .map((item) => ({ ...item, image_url: normalizeImageUrl(item.image_url) }));
  res.json({ ok: true, items });
});

app.post('/api/admin/catalog/promo-offers', adminAuth, (req, res) => {
  const b = req.body || {};
  const type = String(b.type || '').trim();
  const name = String(b.name || '').trim();
  if (!['club', 'wholesale'].includes(type)) return res.status(400).json({ ok: false, error: 'PROMO_TYPE_INVALID' });
  if (!name) return res.status(400).json({ ok: false, error: 'PROMO_NAME_REQUIRED' });
  const t = nowIso();
  const row = {
    type,
    name,
    description: b.description || null,
    image_url: normalizeImageUrl(b.image_url),
    current_price_cents: b.current_price_cents === null || b.current_price_cents === undefined || b.current_price_cents === '' ? null : Math.max(0, Math.round(Number(b.current_price_cents))),
    old_price_cents: b.old_price_cents === null || b.old_price_cents === undefined || b.old_price_cents === '' ? null : Math.max(0, Math.round(Number(b.old_price_cents))),
    badge: b.badge || (type === 'wholesale' ? 'ОПТОВА ПРОПОЗИЦІЯ' : 'КЛУБНА ЦІНА'),
    store_id: b.store_id || 'all',
    active_from: b.active_from || t,
    active_to: b.active_to || null,
    is_active: b.is_active === false ? 0 : 1,
    source_offer_id: null,
    created_at: t,
    updated_at: t
  };
  const result = db.prepare(`INSERT INTO promo_offers(
    type, name, description, image_url, current_price_cents, old_price_cents,
    badge, store_id, active_from, active_to, is_active, source_offer_id, created_at, updated_at
  ) VALUES(
    @type, @name, @description, @image_url, @current_price_cents, @old_price_cents,
    @badge, @store_id, @active_from, @active_to, @is_active, @source_offer_id, @created_at, @updated_at
  )`).run(row);
  logAudit({ actorType: 'admin', actorId: String(req.admin?.id || 'admin'), action: 'promo_offer_created', entityType: 'promo_offer', entityId: String(result.lastInsertRowid), payload: row });
  res.json({ ok: true, id: result.lastInsertRowid });
});

app.patch('/api/admin/catalog/promo-offers/:id', adminAuth, (req, res) => {
  const b = req.body || {};
  const existing = db.prepare('SELECT * FROM promo_offers WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ ok: false, error: 'PROMO_OFFER_NOT_FOUND' });
  const type = b.type ?? existing.type;
  if (!['club', 'wholesale'].includes(String(type))) return res.status(400).json({ ok: false, error: 'PROMO_TYPE_INVALID' });
  const row = {
    id: req.params.id,
    type: String(type),
    name: b.name ?? existing.name,
    description: b.description === undefined ? existing.description : (b.description || null),
    image_url: b.image_url === undefined ? existing.image_url : normalizeImageUrl(b.image_url),
    current_price_cents: b.current_price_cents === undefined ? existing.current_price_cents : (b.current_price_cents === null || b.current_price_cents === '' ? null : Math.max(0, Math.round(Number(b.current_price_cents)))),
    old_price_cents: b.old_price_cents === undefined ? existing.old_price_cents : (b.old_price_cents === null || b.old_price_cents === '' ? null : Math.max(0, Math.round(Number(b.old_price_cents)))),
    badge: b.badge === undefined ? existing.badge : (b.badge || null),
    store_id: b.store_id ?? existing.store_id,
    active_from: b.active_from ?? existing.active_from,
    active_to: b.active_to === undefined ? existing.active_to : (b.active_to || null),
    is_active: b.is_active === undefined ? existing.is_active : (b.is_active ? 1 : 0),
    updated_at: nowIso()
  };
  db.prepare(`UPDATE promo_offers SET
    type=@type, name=@name, description=@description, image_url=@image_url,
    current_price_cents=@current_price_cents, old_price_cents=@old_price_cents,
    badge=@badge, store_id=@store_id, active_from=@active_from, active_to=@active_to,
    is_active=@is_active, updated_at=@updated_at
    WHERE id=@id`).run(row);
  logAudit({ actorType: 'admin', actorId: String(req.admin?.id || 'admin'), action: 'promo_offer_updated', entityType: 'promo_offer', entityId: req.params.id, payload: b });
  res.json({ ok: true });
});

app.delete('/api/admin/catalog/promo-offers/:id', adminAuth, (req, res) => {
  const existing = db.prepare('SELECT id FROM promo_offers WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ ok: false, error: 'PROMO_OFFER_NOT_FOUND' });
  db.prepare('DELETE FROM promo_offers WHERE id = ?').run(req.params.id);
  logAudit({ actorType: 'admin', actorId: String(req.admin?.id || 'admin'), action: 'promo_offer_deleted', entityType: 'promo_offer', entityId: req.params.id, payload: {} });
  res.json({ ok: true });
});

function bannerSourceSnapshot(sourceType, sourceId) {
  if (sourceType === 'pricing_offer') {
    const source = db.prepare(`SELECT id, type, name, description, image_url
      FROM offers WHERE id = ? AND type IN ('club', 'wholesale') LIMIT 1`).get(sourceId);
    return source ? {
      title: source.name,
      text: source.description,
      image_url: source.image_url,
      tag: source.type === 'wholesale' ? 'ОПТОВА ПРОПОЗИЦІЯ' : 'КЛУБНА ПРОПОЗИЦІЯ'
    } : null;
  }
  if (sourceType === 'promo_offer') {
    const source = db.prepare(`SELECT id, type, name, description, image_url, badge
      FROM promo_offers WHERE id = ? LIMIT 1`).get(sourceId);
    return source ? {
      title: source.name,
      text: source.description,
      image_url: source.image_url,
      tag: source.badge || (source.type === 'wholesale' ? 'ОПТОВА ПРОПОЗИЦІЯ' : 'КЛУБНА ПРОПОЗИЦІЯ')
    } : null;
  }
  return null;
}

function normalizeBannerInput(body = {}, existing = null) {
  const sourceType = ['pricing_offer', 'promo_offer'].includes(String(body.source_type || ''))
    ? String(body.source_type)
    : 'custom';
  const sourceId = sourceType === 'custom' ? null : Number(body.source_id || 0) || null;
  const source = sourceId ? bannerSourceSnapshot(sourceType, sourceId) : null;
  const linkRoute = ['offers', 'news', 'rewards', 'none'].includes(String(body.link_route || ''))
    ? String(body.link_route)
    : (existing?.link_route || 'offers');
  const title = String(body.title ?? source?.title ?? existing?.title ?? '').trim();
  return {
    title,
    text: body.text === undefined ? (source?.text ?? existing?.text ?? null) : (String(body.text || '').trim() || null),
    image_url: normalizeImageUrl(body.image_url ?? source?.image_url ?? existing?.image_url),
    tag: String(body.tag ?? source?.tag ?? existing?.tag ?? 'STAR CLUB').trim() || 'STAR CLUB',
    source_type: sourceType,
    source_id: sourceId,
    link_route: linkRoute,
    sort_order: Number.isFinite(Number(body.sort_order)) ? Math.round(Number(body.sort_order)) : Number(existing?.sort_order || 100),
    is_active: body.is_active === undefined ? Number(existing?.is_active ?? 1) : (body.is_active ? 1 : 0)
  };
}

app.get('/api/admin/catalog/banners', adminAuth, (req, res) => {
  const items = db.prepare('SELECT * FROM home_banners ORDER BY sort_order ASC, id DESC').all()
    .map((item) => ({ ...item, image_url: normalizeImageUrl(item.image_url) }));
  const pricingSources = db.prepare(`SELECT id, type, name, description, image_url
    FROM offers WHERE type IN ('club', 'wholesale') ORDER BY id DESC`).all().map((source) => ({
      key: `pricing_offer:${source.id}`,
      source_type: 'pricing_offer',
      source_id: source.id,
      type: source.type,
      title: source.name,
      text: source.description || '',
      image_url: normalizeImageUrl(source.image_url),
      tag: source.type === 'wholesale' ? 'ОПТОВА ПРОПОЗИЦІЯ' : 'КЛУБНА ПРОПОЗИЦІЯ'
    }));
  const promoSources = db.prepare(`SELECT id, type, name, description, image_url, badge
    FROM promo_offers ORDER BY id DESC`).all().map((source) => ({
      key: `promo_offer:${source.id}`,
      source_type: 'promo_offer',
      source_id: source.id,
      type: source.type,
      title: source.name,
      text: source.description || '',
      image_url: normalizeImageUrl(source.image_url),
      tag: source.badge || (source.type === 'wholesale' ? 'ОПТОВА ПРОПОЗИЦІЯ' : 'КЛУБНА ПРОПОЗИЦІЯ')
    }));
  const config = getSetting('home_banners', { enabled: true }) || { enabled: true };
  res.json({ ok: true, enabled: config.enabled !== false, items, sources: [...pricingSources, ...promoSources] });
});

app.put('/api/admin/catalog/banners/settings', adminAuth, (req, res) => {
  const enabled = req.body?.enabled !== false;
  db.prepare(`INSERT INTO settings(key, value) VALUES('home_banners', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify({ enabled }));
  logAudit({ actorType: 'admin', actorId: String(req.admin?.id || 'admin'), action: 'home_banners_visibility_updated', entityType: 'setting', entityId: 'home_banners', payload: { enabled } });
  res.json({ ok: true, enabled });
});

app.post('/api/admin/catalog/banners', adminAuth, (req, res) => {
  const row = normalizeBannerInput(req.body || {});
  if (!row.title) return res.status(400).json({ ok: false, error: 'BANNER_TITLE_REQUIRED' });
  if (row.source_type !== 'custom' && !bannerSourceSnapshot(row.source_type, row.source_id)) {
    return res.status(400).json({ ok: false, error: 'BANNER_SOURCE_NOT_FOUND' });
  }
  const t = nowIso();
  const result = db.prepare(`INSERT INTO home_banners(
    title, text, image_url, tag, source_type, source_id, link_route, sort_order, is_active, created_at, updated_at
  ) VALUES(@title, @text, @image_url, @tag, @source_type, @source_id, @link_route, @sort_order, @is_active, @created_at, @updated_at)`)
    .run({ ...row, created_at: t, updated_at: t });
  logAudit({ actorType: 'admin', actorId: String(req.admin?.id || 'admin'), action: 'home_banner_created', entityType: 'home_banner', entityId: String(result.lastInsertRowid), payload: row });
  res.json({ ok: true, id: result.lastInsertRowid });
});

app.patch('/api/admin/catalog/banners/:id', adminAuth, (req, res) => {
  const existing = db.prepare('SELECT * FROM home_banners WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ ok: false, error: 'BANNER_NOT_FOUND' });
  const row = { ...normalizeBannerInput(req.body || {}, existing), id: req.params.id, updated_at: nowIso() };
  if (!row.title) return res.status(400).json({ ok: false, error: 'BANNER_TITLE_REQUIRED' });
  if (row.source_type !== 'custom' && !bannerSourceSnapshot(row.source_type, row.source_id)) {
    return res.status(400).json({ ok: false, error: 'BANNER_SOURCE_NOT_FOUND' });
  }
  db.prepare(`UPDATE home_banners SET
    title=@title, text=@text, image_url=@image_url, tag=@tag, source_type=@source_type,
    source_id=@source_id, link_route=@link_route, sort_order=@sort_order,
    is_active=@is_active, updated_at=@updated_at WHERE id=@id`).run(row);
  logAudit({ actorType: 'admin', actorId: String(req.admin?.id || 'admin'), action: 'home_banner_updated', entityType: 'home_banner', entityId: req.params.id, payload: row });
  res.json({ ok: true });
});

app.delete('/api/admin/catalog/banners/:id', adminAuth, (req, res) => {
  const existing = db.prepare('SELECT id FROM home_banners WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ ok: false, error: 'BANNER_NOT_FOUND' });
  db.prepare('DELETE FROM home_banners WHERE id = ?').run(req.params.id);
  logAudit({ actorType: 'admin', actorId: String(req.admin?.id || 'admin'), action: 'home_banner_deleted', entityType: 'home_banner', entityId: req.params.id, payload: {} });
  res.json({ ok: true });
});

app.get('/api/admin/catalog/challenges', adminAuth, (req, res) => {
  res.json({ ok: true, challenges: db.prepare('SELECT * FROM challenges ORDER BY id DESC').all() });
});

app.post('/api/admin/catalog/challenges', adminAuth, (req, res) => {
  const b = req.body || {};
  if (!b.name || !Number(b.required_visits) || !Number(b.reward_stars)) return res.status(400).json({ ok: false, error: 'CHALLENGE_FIELDS_REQUIRED' });
  const code = b.code || randomToken('challenge_');
  const t = nowIso();
  const result = db.prepare(`INSERT INTO challenges(code, name, description, required_visits, min_total_cents, reward_stars, period_type, store_id, category, is_repeatable, is_active, active_from, active_to, created_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(code, b.name, b.description || null, Number(b.required_visits), Math.round(Number(b.min_total_cents || 0)), Number(b.reward_stars), b.period_type || 'week', b.store_id || 'all', b.category || null, b.is_repeatable ? 1 : 0, 1, b.active_from || t, b.active_to || null, t);
  logAudit({ actorType: 'admin', actorId: 'admin', action: 'challenge_created', entityType: 'challenge', entityId: String(result.lastInsertRowid), payload: b });
  res.json({ ok: true, id: result.lastInsertRowid });
});

app.get('/api/admin/catalog/stamps', adminAuth, (req, res) => {
  res.json({ ok: true, programs: db.prepare('SELECT * FROM stamp_programs ORDER BY id DESC').all() });
});

app.post('/api/admin/catalog/stamps', adminAuth, (req, res) => {
  const b = req.body || {};
  const targetType = String(b.target_type || 'group').toLowerCase();
  const targetValue = targetType === 'all' ? 'all' : normalizeOneCCode(b.target_value || b.category);
  const targetName = String(b.target_name || '').trim() || targetValue;
  if (!b.name || !targetValue || !Number(b.required_qty) || Number.isNaN(Number(b.reward_stars ?? 0))) {
    return res.status(400).json({ ok: false, error: 'STAMP_FIELDS_REQUIRED' });
  }
  const t = nowIso();
  const result = db.prepare(`INSERT INTO stamp_programs(
      code, name, category, target_type, target_value, target_name,
      required_qty, reward_stars, is_repeatable, is_active, created_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`)
    .run(
      b.code || randomToken('stamp_'),
      b.name,
      targetValue,
      targetType,
      targetValue,
      targetName,
      Number(b.required_qty),
      Number(b.reward_stars),
      b.is_repeatable === false ? 0 : 1,
      t
    );
  logAudit({ actorType: 'admin', actorId: 'admin', action: 'stamp_program_created', entityType: 'stamp_program', entityId: String(result.lastInsertRowid), payload: b });
  res.json({ ok: true, id: result.lastInsertRowid });
});

app.get('/api/admin/catalog/news', adminAuth, (req, res) => {
  res.json({ ok: true, news: db.prepare('SELECT * FROM news ORDER BY id DESC').all() });
});

app.post('/api/admin/catalog/news', adminAuth, (req, res) => {
  const b = req.body || {};
  if (!b.title || !b.text) return res.status(400).json({ ok: false, error: 'NEWS_FIELDS_REQUIRED' });
  const result = db.prepare('INSERT INTO news(title, text, image_url, tag, is_active, created_at) VALUES(?, ?, ?, ?, ?, ?)')
    .run(b.title, b.text, b.image_url || '/assets/star.svg', b.tag || 'STAR CLUB', b.is_active === false ? 0 : 1, nowIso());
  logAudit({ actorType: 'admin', actorId: 'admin', action: 'news_created', entityType: 'news', entityId: String(result.lastInsertRowid), payload: b });
  res.json({ ok: true, id: result.lastInsertRowid });
});


app.delete('/api/admin/catalog/rewards/:id', adminAuth, (req, res) => {
  const existing = db.prepare('SELECT * FROM reward_products WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ ok: false, error: 'REWARD_NOT_FOUND' });
  db.prepare('DELETE FROM reward_qrs WHERE reward_product_id = ?').run(req.params.id);
  db.prepare('DELETE FROM reward_products WHERE id = ?').run(req.params.id);
  logAudit({ actorType: 'admin', actorId: 'admin', action: 'reward_product_deleted', entityType: 'reward_product', entityId: req.params.id, payload: {} });
  res.json({ ok: true });
});

app.patch('/api/admin/catalog/offers/:id', adminAuth, (req, res) => {
  const b = req.body || {};
  const existing = db.prepare('SELECT * FROM offers WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ ok: false, error: 'OFFER_NOT_FOUND' });
  const target = (b.target_value !== undefined || b.target_type !== undefined)
    ? resolvePricingTarget(b.target_value, b.target_type || existing.target_type)
    : { target_type: getOfferTargetType(existing), target_value: getOfferTargetValue(existing) };
  const merged = { ...existing, ...b, type: b.type ?? existing.type, store_id: b.store_id ?? existing.store_id };
  const validationError = validatePricingStoreAndFixed(merged, target.target_type, [target.target_value]);
  if (validationError) return res.status(400).json({ ok: false, error: validationError });
  const row = { ...makePricingOfferRow(merged, target.target_type, target.target_value, nowIso(), null, existing), id: req.params.id };
  db.prepare(`UPDATE offers SET
      type=@type, name=@name, description=@description, image_url=@image_url,
      product_external_id=@product_external_id, category=@category, target_type=@target_type, target_value=@target_value,
      price_mode=@price_mode, price_value=@price_value, priority=@priority, parent_offer_id=@parent_offer_id,
      visible_in_app=@visible_in_app, rounding_mode=@rounding_mode, club_price_cents=@club_price_cents,
      old_price_cents=@old_price_cents, calculated_old_price_cents=@calculated_old_price_cents,
      calculated_new_price_cents=@calculated_new_price_cents, manual_old_price_cents=@manual_old_price_cents,
      use_manual_old_price=@use_manual_old_price, manual_new_price_cents=@manual_new_price_cents,
      use_manual_new_price=@use_manual_new_price, stars_multiplier=@stars_multiplier, tiers_json=@tiers_json,
      store_id=@store_id, audience=@audience, active_from=@active_from, active_to=@active_to,
      is_active=@is_active, updated_at=@updated_at WHERE id=@id`).run(row);
  logAudit({ actorType: 'admin', actorId: String(req.admin?.id || 'admin'), action: 'offer_updated', entityType: 'offer', entityId: req.params.id, payload: b });
  res.json({ ok: true });
});

app.delete('/api/admin/catalog/offers/:id', adminAuth, (req, res) => {
  db.prepare('DELETE FROM offers WHERE id = ?').run(req.params.id);
  logAudit({ actorType: 'admin', actorId: 'admin', action: 'offer_deleted', entityType: 'offer', entityId: req.params.id, payload: {} });
  res.json({ ok: true });
});

app.patch('/api/admin/catalog/challenges/:id', adminAuth, (req, res) => {
  const b = req.body || {};
  const existing = db.prepare('SELECT * FROM challenges WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ ok: false, error: 'CHALLENGE_NOT_FOUND' });
  db.prepare(`UPDATE challenges SET name=?, description=?, required_visits=?, min_total_cents=?, reward_stars=?, period_type=?, store_id=?, category=?, is_repeatable=?, is_active=?, active_from=?, active_to=? WHERE id=?`)
    .run(b.name ?? existing.name, b.description ?? existing.description, b.required_visits ?? existing.required_visits, b.min_total_cents ?? existing.min_total_cents, b.reward_stars ?? existing.reward_stars, b.period_type ?? existing.period_type, b.store_id ?? existing.store_id, b.category ?? existing.category, b.is_repeatable === undefined ? existing.is_repeatable : (b.is_repeatable ? 1 : 0), b.is_active === undefined ? existing.is_active : (b.is_active ? 1 : 0), b.active_from ?? existing.active_from, b.active_to ?? existing.active_to, req.params.id);
  logAudit({ actorType: 'admin', actorId: 'admin', action: 'challenge_updated', entityType: 'challenge', entityId: req.params.id, payload: b });
  res.json({ ok: true });
});

app.delete('/api/admin/catalog/challenges/:id', adminAuth, (req, res) => {
  db.prepare('DELETE FROM client_challenge_days WHERE challenge_id = ?').run(req.params.id);
  db.prepare('DELETE FROM client_challenge_rewards WHERE challenge_id = ?').run(req.params.id);
  db.prepare('DELETE FROM challenges WHERE id = ?').run(req.params.id);
  logAudit({ actorType: 'admin', actorId: 'admin', action: 'challenge_deleted', entityType: 'challenge', entityId: req.params.id, payload: {} });
  res.json({ ok: true });
});

app.patch('/api/admin/catalog/stamps/:id', adminAuth, (req, res) => {
  const b = req.body || {};
  const existing = db.prepare('SELECT * FROM stamp_programs WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ ok: false, error: 'STAMP_NOT_FOUND' });

  const targetType = String(b.target_type ?? existing.target_type ?? 'group').toLowerCase();
  const rawTargetValue = b.target_value ?? b.category ?? existing.target_value ?? existing.category;
  const targetValue = targetType === 'all' ? 'all' : normalizeOneCCode(rawTargetValue);
  const targetName = String(b.target_name ?? existing.target_name ?? targetValue).trim() || targetValue;

  db.prepare(`UPDATE stamp_programs SET
      name = ?, category = ?, target_type = ?, target_value = ?, target_name = ?,
      required_qty = ?, reward_stars = ?, is_repeatable = ?, is_active = ?
    WHERE id = ?`)
    .run(
      b.name ?? existing.name,
      targetValue,
      targetType,
      targetValue,
      targetName,
      b.required_qty ?? existing.required_qty,
      b.reward_stars ?? existing.reward_stars,
      b.is_repeatable === undefined ? existing.is_repeatable : (b.is_repeatable ? 1 : 0),
      b.is_active === undefined ? existing.is_active : (b.is_active ? 1 : 0),
      req.params.id
    );
  logAudit({ actorType: 'admin', actorId: 'admin', action: 'stamp_program_updated', entityType: 'stamp_program', entityId: req.params.id, payload: b });
  res.json({ ok: true });
});

app.delete('/api/admin/catalog/stamps/:id', adminAuth, (req, res) => {
  db.prepare('DELETE FROM client_stamp_progress WHERE program_id = ?').run(req.params.id);
  db.prepare('DELETE FROM stamp_programs WHERE id = ?').run(req.params.id);
  logAudit({ actorType: 'admin', actorId: 'admin', action: 'stamp_program_deleted', entityType: 'stamp_program', entityId: req.params.id, payload: {} });
  res.json({ ok: true });
});

app.patch('/api/admin/catalog/news/:id', adminAuth, (req, res) => {
  const b = req.body || {};
  const existing = db.prepare('SELECT * FROM news WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ ok: false, error: 'NEWS_NOT_FOUND' });
  db.prepare('UPDATE news SET title=?, text=?, image_url=?, tag=?, is_active=? WHERE id=?')
    .run(b.title ?? existing.title, b.text ?? existing.text, b.image_url ?? existing.image_url, b.tag ?? existing.tag, b.is_active === undefined ? existing.is_active : (b.is_active ? 1 : 0), req.params.id);
  logAudit({ actorType: 'admin', actorId: 'admin', action: 'news_updated', entityType: 'news', entityId: req.params.id, payload: b });
  res.json({ ok: true });
});

app.delete('/api/admin/catalog/news/:id', adminAuth, (req, res) => {
  db.prepare('DELETE FROM news WHERE id = ?').run(req.params.id);
  logAudit({ actorType: 'admin', actorId: 'admin', action: 'news_deleted', entityType: 'news', entityId: req.params.id, payload: {} });
  res.json({ ok: true });
});

app.get('/api/admin/support/tickets', adminAuth, (req, res) => {
  const tickets = db.prepare(`SELECT t.*, c.name AS client_name, c.phone, c.card_number FROM support_tickets t
    JOIN clients c ON c.id = t.client_id ORDER BY CASE t.status WHEN 'open' THEN 0 WHEN 'answered' THEN 1 ELSE 2 END, t.updated_at DESC`).all();
  const msg = db.prepare('SELECT * FROM support_messages WHERE ticket_id = ? ORDER BY created_at ASC');
  res.json({ ok: true, tickets: tickets.map((t) => ({ ...t, messages: msg.all(t.id) })) });
});

app.post('/api/admin/support/tickets/:id/reply', adminAuth, (req, res) => {
  const ticket = db.prepare('SELECT * FROM support_tickets WHERE id = ?').get(req.params.id);
  if (!ticket) return res.status(404).json({ ok: false, error: 'TICKET_NOT_FOUND' });
  const message = String(req.body?.message || '').trim();
  if (!message) return res.status(400).json({ ok: false, error: 'MESSAGE_REQUIRED' });
  const now = nowIso();
  db.prepare(`INSERT INTO support_messages(ticket_id, sender_type, sender_id, message, created_at) VALUES(?, 'admin', ?, ?, ?)`)
    .run(ticket.id, String(req.admin.id), message, now);
  db.prepare(`UPDATE support_tickets SET status = 'answered', assigned_admin_id = ?, updated_at = ? WHERE id = ?`).run(req.admin.id || null, now, ticket.id);
  logAudit({ actorType: 'admin', actorId: String(req.admin.id), action: 'support_ticket_replied', entityType: 'support_ticket', entityId: String(ticket.id), payload: {} });
  res.json({ ok: true });
});

app.patch('/api/admin/support/tickets/:id', adminAuth, (req, res) => {
  const status = ['open', 'answered', 'closed'].includes(req.body?.status) ? req.body.status : 'open';
  db.prepare('UPDATE support_tickets SET status = ?, updated_at = ?, closed_at = ? WHERE id = ?')
    .run(status, nowIso(), status === 'closed' ? nowIso() : null, req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/users', ownerAuth, (req, res) => {
  res.json({ ok: true, users: db.prepare('SELECT * FROM admin_users ORDER BY role DESC, created_at DESC').all().map(formatAdmin) });
});

app.post('/api/admin/users', ownerAuth, (req, res) => {
  const login = String(req.body?.login || '').trim();
  const password = String(req.body?.password || '');
  const telegramIdInput = String(req.body?.telegram_id || '').trim();
  const telegramId = telegramIdInput || (login ? `webadmin:${login}` : '');
  if (!telegramId) return res.status(400).json({ ok: false, error: 'TELEGRAM_OR_LOGIN_REQUIRED' });
  if (login && password.length < 6) return res.status(400).json({ ok: false, error: 'PASSWORD_TOO_SHORT' });
  const permissions = Array.isArray(req.body?.permissions) ? [...new Set(req.body.permissions.map(String))] : [];
  if (!permissions.length) return res.status(400).json({ ok: false, error: 'ADMIN_PERMISSIONS_REQUIRED' });
  if (login) {
    const existingLogin = db.prepare('SELECT id FROM admin_users WHERE login = ? AND telegram_id != ?').get(login, telegramId);
    if (existingLogin) return res.status(409).json({ ok: false, error: 'LOGIN_ALREADY_EXISTS' });
  }
  const now = nowIso();
  const existing = db.prepare('SELECT * FROM admin_users WHERE telegram_id = ?').get(telegramId);
  const nextHash = login && password ? hashPassword(password) : existing?.password_hash || null;
  const nextPasswordSetAt = login && password ? now : existing?.password_set_at || null;
  db.prepare(`INSERT INTO admin_users(telegram_id, name, username, role, permissions_json, login, password_hash, password_set_at, is_active, created_at, updated_at)
    VALUES(?, ?, ?, 'admin', ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(telegram_id) DO UPDATE SET
      name=excluded.name, username=excluded.username, role='admin',
      permissions_json=excluded.permissions_json, login=excluded.login,
      password_hash=COALESCE(excluded.password_hash, admin_users.password_hash),
      password_set_at=COALESCE(excluded.password_set_at, admin_users.password_set_at),
      is_active=1, updated_at=excluded.updated_at`)
    .run(telegramId, req.body?.name || login || 'Admin', req.body?.username || null, JSON.stringify(permissions), login || null, nextHash, nextPasswordSetAt, now, now);
  const created = db.prepare('SELECT * FROM admin_users WHERE telegram_id = ?').get(telegramId);
  logAudit({ actorType: 'admin', actorId: String(req.admin.id), action: 'admin_created_or_updated', entityType: 'admin_user', entityId: String(created.id), payload: { telegram_id: telegramId, login, permissions } });
  res.json({ ok: true, user: formatAdmin(created) });
});

app.patch('/api/admin/users/:id', ownerAuth, (req, res) => {
  const current = db.prepare('SELECT * FROM admin_users WHERE id = ?').get(req.params.id);
  if (!current) return res.status(404).json({ ok: false, error: 'ADMIN_NOT_FOUND' });
  if (current.role === 'owner') return res.status(400).json({ ok: false, error: 'OWNER_CANNOT_BE_EDITED_HERE' });
  const permissions = Array.isArray(req.body?.permissions) ? [...new Set(req.body.permissions.map(String))] : [];
  if (req.body?.is_active !== false && !permissions.length) return res.status(400).json({ ok: false, error: 'ADMIN_PERMISSIONS_REQUIRED' });
  const login = String(req.body?.login ?? current.login ?? '').trim();
  const password = String(req.body?.password || '');
  if (login) {
    const existingLogin = db.prepare('SELECT id FROM admin_users WHERE login = ? AND id != ?').get(login, current.id);
    if (existingLogin) return res.status(409).json({ ok: false, error: 'LOGIN_ALREADY_EXISTS' });
  }
  const passwordHash = password ? hashPassword(password) : current.password_hash;
  const passwordSetAt = password ? nowIso() : current.password_set_at;
  db.prepare(`UPDATE admin_users
    SET name = ?, username = ?, role = 'admin', permissions_json = ?, login = ?, password_hash = ?, password_set_at = ?, is_active = ?, updated_at = ?
    WHERE id = ?`)
    .run(req.body?.name || current.name || login || 'Admin', req.body?.username ?? current.username, JSON.stringify(permissions), login || null, passwordHash, passwordSetAt, req.body?.is_active === false ? 0 : 1, nowIso(), req.params.id);
  const updated = db.prepare('SELECT * FROM admin_users WHERE id = ?').get(req.params.id);
  logAudit({ actorType: 'admin', actorId: String(req.admin.id), action: 'admin_permissions_updated', entityType: 'admin_user', entityId: String(updated.id), payload: { permissions, is_active: Boolean(updated.is_active), login } });
  res.json({ ok: true, user: formatAdmin(updated) });
});

app.delete('/api/admin/users/:id', ownerAuth, (req, res) => {
  const current = db.prepare('SELECT * FROM admin_users WHERE id = ?').get(req.params.id);
  if (!current) return res.status(404).json({ ok: false, error: 'ADMIN_NOT_FOUND' });
  if (current.role === 'owner') return res.status(400).json({ ok: false, error: 'OWNER_CANNOT_BE_DELETED' });
  db.prepare('DELETE FROM admin_sessions WHERE admin_user_id = ?').run(current.id);
  db.prepare('DELETE FROM admin_users WHERE id = ?').run(current.id);
  logAudit({ actorType: 'admin', actorId: String(req.admin.id), action: 'admin_deleted', entityType: 'admin_user', entityId: String(current.id), payload: { telegram_id: current.telegram_id } });
  res.json({ ok: true });
});

app.get('/api/admin/settings/client-cleanup/preview', adminAuth, (req, res) => {
  const config = getClientCleanupConfig();
  const candidates = clientCleanupCandidates(config);
  res.json({
    ok: true,
    config,
    summary: {
      total: candidates.length,
      zero_balance: candidates.filter((item) => item.reason === 'zero_balance').length,
      positive_balance: candidates.filter((item) => item.reason === 'positive_balance').length
    },
    candidates: candidates.slice(0, 50)
  });
});

app.put('/api/admin/settings/client_cleanup', adminAuth, (req, res) => {
  const input = req.body?.value ?? req.body ?? {};
  const config = saveClientCleanupConfig(input);
  logAudit({
    actorType: 'admin',
    actorId: String(req.admin?.id || 'admin'),
    action: 'client_cleanup_settings_updated',
    entityType: 'setting',
    entityId: 'client_cleanup',
    payload: config
  });
  res.json({ ok: true, config });
});

app.post('/api/admin/settings/client-cleanup/run', adminAuth, (req, res) => {
  const result = runClientCleanup({ actorId: String(req.admin?.id || 'admin'), trigger: 'manual' });
  res.json(result);
});

app.get('/api/admin/settings', adminAuth, (req, res) => {
  res.json({ ok: true, settings: db.prepare('SELECT * FROM settings ORDER BY key').all().map(r => ({ key: r.key, value: JSON.parse(r.value) })) });
});

app.put('/api/admin/settings/:key', adminAuth, (req, res) => {
  db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(req.params.key, JSON.stringify(req.body?.value ?? req.body));
  logAudit({ actorType: 'admin', actorId: 'admin', action: 'setting_updated', entityType: 'setting', entityId: req.params.key, payload: req.body });
  res.json({ ok: true });
});

function receiptWithItems(receipt) {
  if (!receipt) return null;
  const items = db.prepare('SELECT * FROM receipt_items WHERE receipt_id = ? ORDER BY id').all(receipt.id);
  const isRewardPurchase = Number(receipt.stars_spent || 0) > 0;
  return {
    ...receipt,
    total_uah: money(receipt.total_cents),
    eligible_uah: money(receipt.eligible_cents),
    is_reward_purchase: isRewardPurchase,
    display_title: isRewardPurchase ? 'Покупка за зірки' : (receipt.store_id || 'Магазин Star'),
    display_amount: isRewardPurchase ? `-${receipt.stars_spent} ⭐` : `${money(receipt.total_cents)} грн`,
    items
  };
}

function getClientTopProducts(clientId) {
  return db.prepare(`SELECT
      COALESCE(i.external_product_id, i.product_id, i.name) AS product_key,
      COALESCE(i.external_product_id, i.product_id, '') AS product_external_id,
      i.name,
      i.category,
      SUM(i.qty) AS total_qty,
      COUNT(DISTINCT r.id) AS receipts_count,
      SUM(i.line_total_cents) AS total_cents,
      MAX(r.purchased_at) AS last_purchase_at
    FROM receipt_items i
    JOIN receipts r ON r.id = i.receipt_id
    WHERE r.client_id = ? AND r.is_return = 0
    GROUP BY product_key, i.name, i.category
    ORDER BY total_qty DESC, receipts_count DESC, total_cents DESC
    LIMIT 3`).all(clientId).map((row) => ({ ...row, total_uah: money(row.total_cents) }));
}

function getClientPersonalCoupons(clientId) {
  return db.prepare(`
    SELECT *
    FROM personal_coupons
    WHERE client_id = ?
      AND status = 'active'
      AND datetime(expires_at) > datetime(?)
    ORDER BY created_at DESC
    LIMIT 50
  `).all(
    clientId,
    nowIso()
  );
}

// ---------------- Admin API ----------------
app.get('/api/admin/summary', adminAuth, (req, res) => {
  const storeId = String(req.query.store_id || 'all').trim();
  const dateFrom = String(req.query.date_from || '').trim();
  const dateTo = String(req.query.date_to || '').trim();
  const balanceMode = String(req.query.balance_mode || 'date').trim();
  const balanceDate = String(req.query.balance_date || dateTo || '').trim();
  const balanceFrom = String(req.query.balance_from || '').trim();
  const balanceTo = String(req.query.balance_to || '').trim();

  // Гнучкі фільтри блоку «Топ товарів».
  // Старі параметри аналітики не видаляємо — лише додаємо нові.
  const requestedTopProductSort = String(req.query.top_product_sort || 'qty').trim();
  const topProductSort = ['qty', 'sum'].includes(requestedTopProductSort) ? requestedTopProductSort : 'qty';
  const requestedTobaccoFilter = String(req.query.top_product_tobacco || 'all').trim();
  const topProductTobacco = ['all', 'with', 'without'].includes(requestedTobaccoFilter) ? requestedTobaccoFilter : 'all';
  const requestedAlcoholFilter = String(req.query.top_product_alcohol || 'all').trim();
  const topProductAlcohol = ['all', 'with', 'without'].includes(requestedAlcoholFilter) ? requestedAlcoholFilter : 'all';
  const topProductMinQty = Math.max(0, Number(req.query.top_product_min_qty || 0) || 0);
  const topProductMinTotalUah = Math.max(0, Number(req.query.top_product_min_total || 0) || 0);
  const topProductMinReceipts = Math.max(0, Math.trunc(Number(req.query.top_product_min_receipts || 0) || 0));
  const requestedTopProductLimit = Math.trunc(Number(req.query.top_product_limit || 5) || 5);
  const topProductLimit = Math.min(100, Math.max(1, requestedTopProductLimit));
  const topProductSearch = String(req.query.top_product_search || '').trim();

  const where = ["r.is_return = 0"]; const params = [];
  if (storeId && storeId !== 'all') { where.push('(r.store_id = ? OR r.store_id IN (SELECT external_id FROM stores WHERE id = ?))'); params.push(storeId, storeId); }
  if (dateFrom) { where.push('r.purchased_at >= ?'); params.push(`${dateFrom}T00:00:00`); }
  if (dateTo) { where.push('r.purchased_at <= ?'); params.push(`${dateTo}T23:59:59`); }
  const receiptWhere = where.join(' AND ');
  const clients = db.prepare('SELECT COUNT(*) AS c FROM clients').get().c;
  const active = db.prepare('SELECT COUNT(*) AS c FROM clients WHERE last_purchase_at IS NOT NULL').get().c;
  const receipts = db.prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(r.total_cents),0) total, COALESCE(SUM(r.stars_accrued),0) accrued, COALESCE(SUM(r.stars_spent),0) spent, COALESCE(AVG(r.total_cents),0) avg_total FROM receipts r WHERE ${receiptWhere}`).get(...params);
  const cashAccrued = db.prepare(`SELECT COALESCE(SUM(stars_amount),0) AS s FROM change_accrual_operations WHERE status='completed' ${dateFrom?'AND completed_at >= ?':''} ${dateTo?'AND completed_at <= ?':''}`).get(...([dateFrom?`${dateFrom}T00:00:00`:null,dateTo?`${dateTo}T23:59:59`:null].filter(Boolean))).s;
  const ledgerWhere=[]; const ledgerParams=[];
  if(balanceMode==='date' && balanceDate){ledgerWhere.push('created_at <= ?');ledgerParams.push(`${balanceDate}T23:59:59`);}
  if(balanceMode==='range'){if(balanceFrom){ledgerWhere.push('created_at >= ?');ledgerParams.push(`${balanceFrom}T00:00:00`);}if(balanceTo){ledgerWhere.push('created_at <= ?');ledgerParams.push(`${balanceTo}T23:59:59`);}}
  const stars = balanceMode==='all' ? db.prepare('SELECT COALESCE(SUM(amount),0) s FROM star_ledger').get().s : db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM star_ledger ${ledgerWhere.length?'WHERE '+ledgerWhere.join(' AND '):''}`).get(...ledgerParams).s;
  const topStores = db.prepare(`SELECT COALESCE(s.name,r.store_id,'Невідомий магазин') name, COUNT(*) receipts, COALESCE(SUM(r.total_cents),0) total_cents FROM receipts r LEFT JOIN stores s ON s.id=r.store_id OR s.external_id=r.store_id WHERE ${receiptWhere} GROUP BY COALESCE(s.name,r.store_id) ORDER BY total_cents DESC LIMIT 5`).all(...params);

  const topProductWhere = [receiptWhere];
  const topProductParams = [...params];

  // Для аналітики тип підакцизного товару визначаємо за групою 1С:
  // ЕКА/ЭКА «А» — сигарети, ЕКА/ЭКА «Б» — алкоголь.
  // Старі прапорці та назви залишаємо як резерв, але група має пріоритет.
  const analyticsGroupTextExpr = `(
    COALESCE(i.category, '') || ' ' ||
    COALESCE(p.category, '') || ' ' ||
    COALESCE(p.group_name, '') || ' ' ||
    COALESCE(p.name, '')
  )`;

  const ekaATobaccoExpr = `(
    INSTR(${analyticsGroupTextExpr}, 'ЭКА "А"') > 0
    OR INSTR(${analyticsGroupTextExpr}, 'ЭКА «А»') > 0
    OR INSTR(${analyticsGroupTextExpr}, 'ЭКА А') > 0
    OR INSTR(${analyticsGroupTextExpr}, 'ЕКА "А"') > 0
    OR INSTR(${analyticsGroupTextExpr}, 'ЕКА «А»') > 0
    OR INSTR(${analyticsGroupTextExpr}, 'ЕКА А') > 0
    OR INSTR(${analyticsGroupTextExpr}, 'эка "а"') > 0
    OR INSTR(${analyticsGroupTextExpr}, 'эка «а»') > 0
    OR INSTR(${analyticsGroupTextExpr}, 'эка а') > 0
    OR INSTR(${analyticsGroupTextExpr}, 'ека "а"') > 0
    OR INSTR(${analyticsGroupTextExpr}, 'ека «а»') > 0
    OR INSTR(${analyticsGroupTextExpr}, 'ека а') > 0
  )`;

  const ekaBAlcoholExpr = `(
    INSTR(${analyticsGroupTextExpr}, 'ЭКА "Б"') > 0
    OR INSTR(${analyticsGroupTextExpr}, 'ЭКА «Б»') > 0
    OR INSTR(${analyticsGroupTextExpr}, 'ЭКА Б') > 0
    OR INSTR(${analyticsGroupTextExpr}, 'ЕКА "Б"') > 0
    OR INSTR(${analyticsGroupTextExpr}, 'ЕКА «Б»') > 0
    OR INSTR(${analyticsGroupTextExpr}, 'ЕКА Б') > 0
    OR INSTR(${analyticsGroupTextExpr}, 'эка "б"') > 0
    OR INSTR(${analyticsGroupTextExpr}, 'эка «б»') > 0
    OR INSTR(${analyticsGroupTextExpr}, 'эка б') > 0
    OR INSTR(${analyticsGroupTextExpr}, 'ека "б"') > 0
    OR INSTR(${analyticsGroupTextExpr}, 'ека «б»') > 0
    OR INSTR(${analyticsGroupTextExpr}, 'ека б') > 0
  )`;

  const tobaccoNameFallbackExpr = `(
    INSTR(COALESCE(i.name, ''), 'Сигар') > 0
    OR INSTR(COALESCE(i.category, ''), 'Сигар') > 0
    OR INSTR(COALESCE(p.name, ''), 'Сигар') > 0
    OR INSTR(COALESCE(p.group_name, ''), 'Сигар') > 0
    OR INSTR(COALESCE(i.name, ''), 'сигар') > 0
    OR INSTR(COALESCE(i.category, ''), 'сигар') > 0
    OR INSTR(COALESCE(p.name, ''), 'сигар') > 0
    OR INSTR(COALESCE(p.group_name, ''), 'сигар') > 0
    OR INSTR(COALESCE(i.name, ''), 'Цигар') > 0
    OR INSTR(COALESCE(i.category, ''), 'Цигар') > 0
    OR INSTR(COALESCE(i.name, ''), 'цигар') > 0
    OR INSTR(COALESCE(i.category, ''), 'цигар') > 0
    OR INSTR(COALESCE(i.name, ''), 'Тютюн') > 0
    OR INSTR(COALESCE(i.category, ''), 'Тютюн') > 0
    OR INSTR(COALESCE(i.name, ''), 'тютюн') > 0
    OR INSTR(COALESCE(i.category, ''), 'тютюн') > 0
    OR INSTR(COALESCE(i.name, ''), 'Табак') > 0
    OR INSTR(COALESCE(i.category, ''), 'Табак') > 0
    OR INSTR(COALESCE(i.name, ''), 'табак') > 0
    OR INSTR(COALESCE(i.category, ''), 'табак') > 0
    OR LOWER(COALESCE(i.name, '')) LIKE '%tobacco%'
    OR LOWER(COALESCE(i.category, '')) LIKE '%tobacco%'
    OR LOWER(COALESCE(i.name, '')) LIKE '%cigarette%'
    OR LOWER(COALESCE(i.category, '')) LIKE '%cigarette%'
    OR LOWER(COALESCE(i.name, '')) LIKE '%heets%'
    OR LOWER(COALESCE(i.name, '')) LIKE '%terea%'
  )`;

  const tobaccoAnalyticsExpr = `(
    ${ekaATobaccoExpr}
    OR (
      NOT ${ekaBAlcoholExpr}
      AND (
        COALESCE(i.is_tobacco, 0) = 1
        OR COALESCE(p.is_tobacco, 0) = 1
        OR ${tobaccoNameFallbackExpr}
      )
    )
  )`;

  const alcoholAnalyticsExpr = `(
    ${ekaBAlcoholExpr}
    OR (
      NOT ${ekaATobaccoExpr}
      AND NOT ${tobaccoNameFallbackExpr}
      AND (
        COALESCE(i.is_alcohol, 0) = 1
        OR COALESCE(p.is_alcohol, 0) = 1
      )
    )
  )`;

  if (topProductTobacco === 'with') topProductWhere.push(tobaccoAnalyticsExpr);
  if (topProductTobacco === 'without') topProductWhere.push(`NOT ${tobaccoAnalyticsExpr}`);
  if (topProductAlcohol === 'with') topProductWhere.push(alcoholAnalyticsExpr);
  if (topProductAlcohol === 'without') topProductWhere.push(`NOT ${alcoholAnalyticsExpr}`);
  if (topProductSearch) {
    topProductWhere.push('(LOWER(i.name) LIKE LOWER(?) OR LOWER(COALESCE(i.category, "")) LIKE LOWER(?))');
    topProductParams.push(`%${topProductSearch}%`, `%${topProductSearch}%`);
  }

  const topProductHaving = [];
  const topProductHavingParams = [];
  if (topProductMinQty > 0) {
    topProductHaving.push('SUM(i.qty) >= ?');
    topProductHavingParams.push(topProductMinQty);
  }
  if (topProductMinTotalUah > 0) {
    topProductHaving.push('SUM(i.line_total_cents) >= ?');
    topProductHavingParams.push(Math.round(topProductMinTotalUah * 100));
  }
  if (topProductMinReceipts > 0) {
    topProductHaving.push('COUNT(DISTINCT i.receipt_id) >= ?');
    topProductHavingParams.push(topProductMinReceipts);
  }

  const topProductOrder = topProductSort === 'sum'
    ? 'total_cents DESC, qty DESC, receipts_count DESC'
    : 'qty DESC, total_cents DESC, receipts_count DESC';

  const topProducts = db.prepare(`
    SELECT
      i.name,
      COALESCE(i.category, '') category,
      SUM(i.qty) qty,
      COUNT(DISTINCT i.receipt_id) receipts_count,
      SUM(i.line_total_cents) total_cents,
      MAX(CASE WHEN ${tobaccoAnalyticsExpr} THEN 1 ELSE 0 END) is_tobacco,
      MAX(CASE WHEN ${alcoholAnalyticsExpr} THEN 1 ELSE 0 END) is_alcohol
    FROM receipt_items i
    JOIN receipts r ON r.id = i.receipt_id
    LEFT JOIN products p
      ON p.external_id = i.external_product_id
      OR p.id = i.product_id
    WHERE ${topProductWhere.join(' AND ')}
    GROUP BY i.name, COALESCE(i.category, '')
    ${topProductHaving.length ? `HAVING ${topProductHaving.join(' AND ')}` : ''}
    ORDER BY ${topProductOrder}
    LIMIT ?
  `).all(...topProductParams, ...topProductHavingParams, topProductLimit);

  const stores = db.prepare(`SELECT id, external_id, name, source FROM stores WHERE is_active=1 AND source='1c' ORDER BY name`).all();
  res.json({
    ok:true,
    stores,
    filters:{
      store_id:storeId,
      date_from:dateFrom,
      date_to:dateTo,
      balance_mode:balanceMode,
      balance_date:balanceDate,
      balance_from:balanceFrom,
      balance_to:balanceTo,
      top_product_sort:topProductSort,
      top_product_tobacco:topProductTobacco,
      top_product_alcohol:topProductAlcohol,
      top_product_min_qty:topProductMinQty,
      top_product_min_total:topProductMinTotalUah,
      top_product_min_receipts:topProductMinReceipts,
      top_product_limit:topProductLimit,
      top_product_search:topProductSearch
    },
    summary:{
      clients,
      active,
      stars,
      receipts:receipts.c,
      total_sales_uah:money(receipts.total),
      average_receipt_uah:money(receipts.avg_total),
      stars_accrued:Number(receipts.accrued||0),
      cash_change_stars:Number(cashAccrued||0),
      stars_spent:Number(receipts.spent||0),
      rewards_used:db.prepare('SELECT COUNT(*) c FROM reward_qrs WHERE status="used"').get().c,
      top_stores:topStores.map(x=>({...x,total_uah:money(x.total_cents)})),
      top_products:topProducts.map(x=>({...x,total_uah:money(x.total_cents)}))
    }
  });
});

app.get('/api/admin/clients', adminAuth, (req, res) => {
  const q = String(req.query.q || '').trim();
  const requestedSort = String(req.query.sort || 'newest').trim();
  const sort = ['newest', 'receipt_count', 'receipt_total', 'average_receipt'].includes(requestedSort) ? requestedSort : 'newest';
  const storeId = String(req.query.store_id || 'all').trim();
  const dateFrom = String(req.query.date_from || '').trim();
  const dateTo = String(req.query.date_to || '').trim();

  const receiptWhere = ['r.is_return = 0'];
  const receiptParams = [];
  if (storeId && storeId !== 'all') {
    receiptWhere.push('(r.store_id = ? OR r.store_id IN (SELECT external_id FROM stores WHERE id = ?))');
    receiptParams.push(storeId, storeId);
  }
  if (dateFrom) {
    receiptWhere.push('r.purchased_at >= ?');
    receiptParams.push(`${dateFrom}T00:00:00`);
  }
  if (dateTo) {
    receiptWhere.push('r.purchased_at <= ?');
    receiptParams.push(`${dateTo}T23:59:59`);
  }

  const clientWhere = [];
  const clientParams = [];
  if (q) {
    clientWhere.push('(c.phone LIKE ? OR c.name LIKE ? OR c.card_number LIKE ?)');
    clientParams.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  const hasReceiptFilter = (storeId && storeId !== 'all') || dateFrom || dateTo;
  if (hasReceiptFilter) clientWhere.push('COALESCE(ra.receipts_count, 0) > 0');

  const orderBy = {
    newest: 'c.created_at DESC',
    receipt_count: 'COALESCE(ra.receipts_count, 0) DESC, COALESCE(ra.receipts_total_cents, 0) DESC, c.created_at DESC',
    receipt_total: 'COALESCE(ra.receipts_total_cents, 0) DESC, COALESCE(ra.receipts_count, 0) DESC, c.created_at DESC',
    average_receipt: 'COALESCE(ra.average_receipt_cents, 0) DESC, COALESCE(ra.receipts_count, 0) DESC, c.created_at DESC'
  }[sort];

  const sql = `
    WITH receipt_analytics AS (
      SELECT
        r.client_id,
        COUNT(*) AS receipts_count,
        COALESCE(SUM(r.total_cents), 0) AS receipts_total_cents,
        COALESCE(AVG(r.total_cents), 0) AS average_receipt_cents
      FROM receipts r
      WHERE ${receiptWhere.join(' AND ')}
      GROUP BY r.client_id
    )
    SELECT
      c.*,
      COALESCE(ra.receipts_count, 0) AS receipts_count,
      COALESCE(ra.receipts_total_cents, 0) AS receipts_total_cents,
      COALESCE(ra.average_receipt_cents, 0) AS average_receipt_cents
    FROM clients c
    LEFT JOIN receipt_analytics ra ON ra.client_id = c.id
    ${clientWhere.length ? `WHERE ${clientWhere.join(' AND ')}` : ''}
    ORDER BY ${orderBy}
    LIMIT 200
  `;

  const rows = db.prepare(sql).all(...receiptParams, ...clientParams);
  const stores = db.prepare(`SELECT id, external_id, name FROM stores WHERE is_active = 1 AND source = '1c' ORDER BY name`).all();
  res.json({
    ok: true,
    stores,
    filters: { q, sort, store_id: storeId, date_from: dateFrom, date_to: dateTo },
    clients: rows.map(row => ({
      ...formatClient(row),
      receipts_count: Number(row.receipts_count || 0),
      receipts_total_uah: money(row.receipts_total_cents || 0),
      average_receipt_uah: money(row.average_receipt_cents || 0)
    }))
  });
});

app.get('/api/admin/clients/:id', adminAuth, (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ ok: false, error: 'CLIENT_NOT_FOUND' });
  const ledgerLimit = Math.min(50, Math.max(3, Number(req.query.ledger_limit || 3)));
  const receiptLimit = Math.min(50, Math.max(3, Number(req.query.receipt_limit || 3)));
  const ledger = db.prepare('SELECT * FROM star_ledger WHERE client_id = ? ORDER BY created_at DESC LIMIT ?').all(client.id, ledgerLimit);
  const receipts = db.prepare('SELECT * FROM receipts WHERE client_id = ? ORDER BY purchased_at DESC LIMIT ?').all(client.id, receiptLimit).map(receiptWithItems);
  const ledgerCount = db.prepare('SELECT COUNT(*) AS c FROM star_ledger WHERE client_id = ?').get(client.id).c;
  const receiptsCount = db.prepare('SELECT COUNT(*) AS c FROM receipts WHERE client_id = ?').get(client.id).c;
  const progress = db.prepare(`SELECT p.name, p.code, COALESCE(sp.progress, 0) AS progress, p.required_qty, p.reward_stars, COALESCE(sp.completed_count, 0) AS completed_count
    FROM stamp_programs p
    LEFT JOIN client_stamp_progress sp ON sp.program_id = p.id AND sp.client_id = ?
    WHERE p.is_active = 1 ORDER BY p.id`).all(client.id);
  res.json({
    ok: true,
    client: formatClient(client),
    ledger,
    receipts,
    progress,
    analytics: { top_products: getClientTopProducts(client.id) },
    personal_coupons: getClientPersonalCoupons(client.id),
    counts: { ledger: ledgerCount, receipts: receiptsCount }
  });
});

app.get('/api/admin/clients/:id/ledger', adminAuth, (req, res) => {
  const client = db.prepare('SELECT id FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ ok: false, error: 'CLIENT_NOT_FOUND' });
  const offset = Math.max(0, Number(req.query.offset || 0));
  const limit = Math.min(50, Math.max(1, Number(req.query.limit || 10)));
  const items = db.prepare('SELECT * FROM star_ledger WHERE client_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(client.id, limit, offset);
  const total = db.prepare('SELECT COUNT(*) AS c FROM star_ledger WHERE client_id = ?').get(client.id).c;
  res.json({ ok: true, items, total, offset, limit });
});

app.get('/api/admin/clients/:id/receipts', adminAuth, (req, res) => {
  const client = db.prepare('SELECT id FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ ok: false, error: 'CLIENT_NOT_FOUND' });
  const offset = Math.max(0, Number(req.query.offset || 0));
  const limit = Math.min(50, Math.max(1, Number(req.query.limit || 10)));
  const receipts = db.prepare('SELECT * FROM receipts WHERE client_id = ? ORDER BY purchased_at DESC LIMIT ? OFFSET ?').all(client.id, limit, offset).map(receiptWithItems);
  const total = db.prepare('SELECT COUNT(*) AS c FROM receipts WHERE client_id = ?').get(client.id).c;
  res.json({ ok: true, receipts, total, offset, limit });
});

app.post('/api/admin/clients/:id/personal-coupons', adminAuth, (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ ok: false, error: 'CLIENT_NOT_FOUND' });
  const productExternalId = String(req.body?.product_external_id || '').trim();
  const productName = String(req.body?.product_name || req.body?.name || '').trim();
  const discountPercent = Math.min(99, Math.max(1, Math.round(Number(req.body?.discount_percent || 10))));
  const maxUnits = Math.min(999, Math.max(1, Math.round(Number(req.body?.max_units || 1))));
  if (!productExternalId && !productName) return res.status(400).json({ ok: false, error: 'PRODUCT_REQUIRED' });
  const code = getUniqueCouponCode();
  const days = Math.min(90, Math.max(1, Number(req.body?.valid_days || 7)));
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * days).toISOString();
  const bannerTitle = String(req.body?.banner_title || `Персональна знижка −${discountPercent}%`).trim();
  const bannerText = String(req.body?.banner_text || `На ${productName || 'обраний товар'}`).trim();
  const bannerImageUrl = normalizeImageUrl(req.body?.banner_image_url || '/assets/star.svg');
  const showAsBanner = req.body?.show_as_banner ? 1 : 0;
  const r = db.prepare(`INSERT INTO personal_coupons(client_id, code, product_external_id, product_name, discount_percent, max_units, status, expires_at, created_at, created_by_admin_id, banner_title, banner_text, banner_image_url, show_as_banner)
    VALUES(?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`).run(client.id, code, productExternalId || null, productName || null, discountPercent, maxUnits, expiresAt, nowIso(), req.admin?.id || null, bannerTitle, bannerText, bannerImageUrl, showAsBanner);
  const coupon = db.prepare('SELECT * FROM personal_coupons WHERE id = ?').get(r.lastInsertRowid);
  logAudit({ actorType: 'admin', actorId: String(req.admin.id), action: 'personal_coupon_created', entityType: 'personal_coupon', entityId: String(coupon.id), payload: { client_id: client.id, code, productExternalId, productName, discountPercent, maxUnits } });
  res.json({ ok: true, coupon });
});


app.patch('/api/admin/clients/:id/personal-coupons/:couponId/banner', adminAuth, (req, res) => {
  const coupon = db.prepare('SELECT * FROM personal_coupons WHERE id = ? AND client_id = ?').get(req.params.couponId, req.params.id);
  if (!coupon) return res.status(404).json({ ok: false, error: 'COUPON_NOT_FOUND' });
  const b = req.body || {};
  db.prepare(`UPDATE personal_coupons SET banner_title=?, banner_text=?, banner_image_url=?, show_as_banner=? WHERE id=?`)
    .run(String(b.banner_title || coupon.banner_title || '').trim() || null, String(b.banner_text || coupon.banner_text || '').trim() || null, normalizeImageUrl(b.banner_image_url || coupon.banner_image_url || '/assets/star.svg'), b.show_as_banner === false ? 0 : 1, coupon.id);
  res.json({ ok: true, coupon: db.prepare('SELECT * FROM personal_coupons WHERE id=?').get(coupon.id) });
});

app.delete('/api/admin/clients/:id/personal-coupons/:couponId', adminAuth, (req, res) => {
  const clientId = Number(req.params.id);
  const couponId = Number(req.params.couponId);
  const coupon = db.prepare('SELECT * FROM personal_coupons WHERE id = ? AND client_id = ?').get(couponId, clientId);
  if (!coupon) return res.status(404).json({ ok: false, error: 'COUPON_NOT_FOUND' });

  db.prepare('DELETE FROM personal_coupons WHERE id = ? AND client_id = ?').run(couponId, clientId);
  logAudit({
    actorType: 'admin',
    actorId: String(req.admin?.id || 'admin'),
    action: 'personal_coupon_deleted',
    entityType: 'personal_coupon',
    entityId: String(couponId),
    payload: { client_id: clientId, code: coupon.code, product_external_id: coupon.product_external_id }
  });

  res.json({ ok: true, deleted: true, coupon_id: couponId });
});


app.get('/api/admin/clients/:id/personal-coupons', adminAuth, (req, res) => {
  const client = db.prepare('SELECT id FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ ok: false, error: 'CLIENT_NOT_FOUND' });
  res.json({ ok: true, coupons: getClientPersonalCoupons(client.id) });
});

app.post('/api/admin/clients/:id/block', adminAuth, (req, res) => {
  db.prepare('UPDATE clients SET is_blocked = ?, updated_at = ? WHERE id = ?').run(req.body?.blocked ? 1 : 0, nowIso(), req.params.id);
  logAudit({ actorType: 'admin', actorId: 'admin', action: req.body?.blocked ? 'client_blocked' : 'client_unblocked', entityType: 'client', entityId: req.params.id, payload: req.body });
  res.json({ ok: true });
});

app.post('/api/admin/clients/:id/adjust-stars', adminAuth, (req, res) => {
  const amount = Math.round(Number(req.body?.amount || 0));
  if (!amount) return res.status(400).json({ ok: false, error: 'AMOUNT_REQUIRED' });
  const balance = awardStars(Number(req.params.id), 'manual_adjustment', amount, 'admin', req.body?.description || 'Ручне коригування');
  logAudit({ actorType: 'admin', actorId: 'admin', action: 'manual_star_adjustment', entityType: 'client', entityId: req.params.id, payload: { amount, balance } });
  res.json({ ok: true, balance });
});

app.get('/api/admin/reward-qrs', adminAuth, (req, res) => {
  const rows = db.prepare(`SELECT q.*, c.name AS client_name, c.phone, r.name AS reward_name FROM reward_qrs q JOIN clients c ON c.id = q.client_id JOIN reward_products r ON r.id = q.reward_product_id ORDER BY q.created_at DESC LIMIT 200`).all();
  res.json({ ok: true, qrs: rows });
});

app.get('/api/admin/audit', adminAuth, (req, res) => {
  res.json({ ok: true, logs: db.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 200').all() });
});

app.get('/admin-desktop', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin-desktop.html')));
app.get('/admin-pc', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin-desktop.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

let runningBot = null;
let cleanupTimer = null;
let shuttingDown = false;

const server = app.listen(port, async () => {
  console.log(`Star Club prototype is running on http://localhost:${port}`);

  try {
    const cleanup = runClientCleanup({ actorId: 'system', trigger: 'startup' });
    if (cleanup.deleted) console.log(`Star Club: automatically deleted ${cleanup.deleted} inactive client(s).`);
  } catch (error) {
    console.error('Star Club client cleanup failed:', error.message || error);
  }
  cleanupTimer = setInterval(() => {
    try {
      const cleanup = runClientCleanup({ actorId: 'system', trigger: 'daily' });
      if (cleanup.deleted) console.log(`Star Club: automatically deleted ${cleanup.deleted} inactive client(s).`);
    } catch (error) {
      console.error('Star Club client cleanup failed:', error.message || error);
    }
  }, CLIENT_CLEANUP_DAY_MS);
  cleanupTimer.unref?.();

  if (String(process.env.RUN_BOT || 'true') !== 'false') {
    try {
      runningBot = await startStarClubBot();
    } catch (error) {
      console.error('Telegram bot was not started:', error.message || error);
    }
  }
});

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (cleanupTimer) clearInterval(cleanupTimer);
  try { runningBot?.stop(signal); } catch {}

  const finish = async () => {
    try {
      await closeDb();
      console.log(`Star Club database flushed before ${signal}`);
      process.exit(0);
    } catch (error) {
      console.error('Star Club database shutdown flush failed:', error.message || error);
      process.exit(1);
    }
  };

  server.close(() => { void finish(); });
}

process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
