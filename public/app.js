const $app = document.querySelector('#app');
const $nav = document.querySelector('#bottomNav');
const $toast = document.querySelector('#toast');

const tg = window.Telegram?.WebApp;
// Keep the existing iPhone/iPad layout, including Telegram's embedded browser.
const isAppleMobile = tg?.platform === 'ios' || /iPhone|iPad|iPod/i.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const compactDesktopMobile = !isAppleMobile && (tg?.platform === 'android'
  || /Android|Windows/i.test(navigator.userAgent));
document.body.classList.toggle('android-windows-layout', compactDesktopMobile);
if (tg) {
  tg.ready();
  tg.expand();
  tg.setHeaderColor('#0b0d10');
  tg.setBackgroundColor('#0b0d10');
}

const persistedRoute = localStorage.getItem('starclub_route') || 'home';

const state = {
  token: localStorage.getItem('starclub_session') || '',
  client: null,
  route: persistedRoute === 'stars' ? 'home' : persistedRoute,
  stores: [],
  data: {},
  liveSignature: '',
  liveBusy: false,
  activitySnapshot: null,
  activityReady: false,
  activityBusy: false,
  lastNotifyAt: 0,
  notifications: [],
  notificationsLoadedFor: '',
  notificationPanelOpen: false,
  openCashierOnCard: false,
  priceScanner: null
};

const icons = {
  home: 'home', stores: 'store', offers: 'tags', more: 'menu', card: 'credit-card', rewards: 'gift',
  history: 'history', profile: 'user-round', challenges: 'trophy', news: 'newspaper', support: 'message-circle',
  qr: 'qr-code', progress: 'award', notification: 'bell', receipt: 'receipt-text'
};

const fallbackStores = [];

function safeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function appIcon(name, className = '') {
  const file = String(name || '').replace(/[^a-z0-9-]/g, '') || 'circle-star';
  return `<img class="app-icon ${safeHtml(className)}" src="/assets/icons/${file}.svg" alt="" aria-hidden="true">`;
}

function toast(text) {
  $toast.textContent = text;
  $toast.classList.add('show');
  setTimeout(() => $toast.classList.remove('show'), 2600);
}

function playAppNotificationSound() {
  try { tg?.HapticFeedback?.notificationOccurred?.('success'); } catch {}
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.2);
    setTimeout(() => ctx.close?.(), 450);
  } catch {}
}

function notificationStorageKey() {
  return `starclub_notifications_${state.client?.id || state.client?.card_number || 'guest'}`;
}

function ensureNotificationsLoaded() {
  const key = notificationStorageKey();
  if (state.notificationsLoadedFor === key) return;
  state.notificationsLoadedFor = key;
  try {
    const stored = JSON.parse(localStorage.getItem(key) || '[]');
    state.notifications = Array.isArray(stored) ? stored.slice(0, 30) : [];
  } catch {
    state.notifications = [];
  }
}

function saveNotifications() {
  ensureNotificationsLoaded();
  try { localStorage.setItem(notificationStorageKey(), JSON.stringify(state.notifications.slice(0, 30))); } catch {}
}

function notificationTitle(route) {
  if (route === 'rewardCodes') return 'Новий QR-код';
  if (route === 'history') return 'Нова покупка';
  if (route === 'support') return 'Відповідь підтримки';
  return 'Повідомлення';
}

function addInboxNotification(text, route = null, options = {}) {
  ensureNotificationsLoaded();
  const dedupeKey = options.dedupeKey || `${route || 'info'}:${text}`;
  if (state.notifications.some((n) => n.dedupeKey === dedupeKey)) return;
  const item = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    title: options.title || notificationTitle(route),
    text,
    route,
    dedupeKey,
    read: false,
    created_at: new Date().toISOString()
  };
  state.notifications = [item, ...state.notifications].slice(0, 30);
  saveNotifications();
  const now = Date.now();
  if (now - state.lastNotifyAt > 700) playAppNotificationSound();
  state.lastNotifyAt = now;
  renderNotificationBadgeOnly();
}

function notifyInApp(text, route = null, options = {}) {
  addInboxNotification(text, route, options);
}

function syncPersonalQrNotifications(qrs = [], coupons = []) {
  if (!state.client?.id) return;
  ensureNotificationsLoaded();
  const storageKey = `${notificationStorageKey()}_seen_codes`;
  let stored = [];
  try { stored = JSON.parse(localStorage.getItem(storageKey) || '[]'); } catch {}
  const seen = new Set(Array.isArray(stored) ? stored : []);
  const entries = [
    ...qrs.filter((q) => q.status === 'reserved').map((q) => ({
      key: `created-qr:${q.token || q.manual_code || q.id}`,
      text: `Ваш QR-код на товар «${q.reward?.name || 'Нагорода'}» доступний у розділі «Мої QR-коди».`
    })),
    ...coupons.filter((c) => c.status === 'active').map((c) => ({
      key: `personal-coupon:${c.id || c.code}`,
      text: `Ваш персональний код на товар «${c.product_name || 'Нагорода'}» доступний у розділі «Мої QR-коди».`
    }))
  ];
  for (const entry of entries.reverse()) {
    if (seen.has(entry.key)) continue;
    addInboxNotification(entry.text, 'rewardCodes', { dedupeKey: entry.key });
    seen.add(entry.key);
  }
  try { localStorage.setItem(storageKey, JSON.stringify([...seen].slice(-1000))); } catch {}
}

function unreadNotificationsCount() {
  ensureNotificationsLoaded();
  return state.notifications.filter((n) => !n.read).length;
}

function renderNotificationPanel() {
  ensureNotificationsLoaded();
  const list = state.notifications.slice(0, 12);
  return `
    <div class="notification-panel">
      <div class="notification-head">
        <b>Повідомлення</b>
        ${list.length ? '<button type="button" data-clear-notifications>Очистити</button>' : ''}
      </div>
      <div class="notification-list">
        ${list.length ? list.map((n) => `
          <button type="button" class="notification-item ${n.read ? '' : 'unread'}" data-open-notification="${n.id}">
            <span>${n.title || 'Повідомлення'}</span>
            <p>${n.text || ''}</p>
            <small>${fmtTime(n.created_at)} ${fmtDate(n.created_at)}</small>
          </button>
        `).join('') : '<div class="notification-empty">Нових повідомлень поки немає</div>'}
      </div>
    </div>
  `;
}

function notificationButton() {
  if (!state.client?.registered) return '<span class="topbar-spacer"></span>';
  const unread = unreadNotificationsCount();
  return `
    <div class="notification-wrap">
      <button type="button" class="icon-btn notification-btn ${unread ? 'has-unread' : ''}" data-toggle-notifications aria-label="Повідомлення">
        ${appIcon(icons.notification)}${unread ? `<span class="notification-badge">${unread > 9 ? '9+' : unread}</span>` : ''}
      </button>
      ${state.notificationPanelOpen ? renderNotificationPanel() : ''}
    </div>
  `;
}

function renderNotificationBadgeOnly() {
  const existing = document.querySelector('.notification-wrap');
  if (!existing || !state.client?.registered) return;
  existing.outerHTML = notificationButton();
  bindNotificationEvents();
}

const pendingClientReads = new Map();
let clientReadGeneration = 0;
function api(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  if (method !== 'GET') {
    clientReadGeneration++;
    pendingClientReads.clear();
    return performApiRequest(path, options);
  }
  if (!path.startsWith('/api/client/') || options.signal) return performApiRequest(path, options);
  const key = JSON.stringify([state.token, clientReadGeneration, path, options]);
  if (pendingClientReads.has(key)) return pendingClientReads.get(key);
  const pending = performApiRequest(path, options).finally(() => {
    if (pendingClientReads.get(key) === pending) pendingClientReads.delete(key);
  });
  pendingClientReads.set(key, pending);
  return pending;
}
async function performApiRequest(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  let res;
  try {
    res = await fetch(path, { ...options, headers });
  } catch (error) {
    throw new Error('Сервер не відповідає. Перевірте, чи запущено npm start');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    const message = data.message || data.error || data.detail || 'Помилка запиту';
    const err = new Error(message);
    err.code = data.error || message;
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function setRoute(route) {
  if (state.route === 'priceCheck' && route !== 'priceCheck') stopPriceScanner();
  state.notificationPanelOpen = false;
  state.route = route;
  localStorage.setItem('starclub_route', route);
  render();
  if (state.token && state.client?.registered) checkClientActivity({ initialize: true });
}

function fmtStars(n) {
  return new Intl.NumberFormat('uk-UA').format(Number(n || 0));
}

function fmtDate(s) {
  if (!s) return '—';
  return new Date(s).toLocaleDateString('uk-UA', { day: '2-digit', month: 'long' });
}

function fmtTime(s) {
  if (!s) return '';
  return new Date(s).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
}

async function bootstrap() {
  try {
    if (state.token) {
      const me = await api('/api/client/me');
      state.client = me.client;
    } else if (tg?.initData) {
      const auth = await api('/api/auth/telegram', {
        method: 'POST',
        body: JSON.stringify({ initData: tg.initData })
      });
      state.token = auth.session.token;
      localStorage.setItem('starclub_session', state.token);
      state.client = auth.client;
    }
  } catch (e) {
    console.error(e);
    localStorage.removeItem('starclub_session');
    state.token = '';
    state.client = null;
    state.route = 'start';
  }

  try {
    const stores = await api('/api/public/stores');
    state.stores = stores.stores || [];
  } catch {
    state.stores = [];
  }
  render();
}

function header(title, back = false) {
  return `
    <div class="topbar">
      ${back
        ? `<button class="back-button" type="button" data-back="1">${appIcon('arrow-left')}<span>Назад</span></button>`
        : `<span class="topbar-brand-mark" aria-hidden="true">${appIcon('circle-star')}</span>`}
      <h2>${title}</h2>
      ${notificationButton()}
    </div>
  `;
}

// Navigation artwork is isolated from icons used elsewhere in the app.
function navIcon(name) {
  const artwork = {
    home: '<path fill="currentColor" stroke="none" d="M3 10a2 2 0 0 1 .71-1.53l7-6a2 2 0 0 1 2.58 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2h-4v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8H5a2 2 0 0 1-2-2z"/>',
    'tags': '<path d="M13.172 2a2 2 0 0 1 1.414.586l6.71 6.71a2.4 2.4 0 0 1 0 3.408l-4.592 4.592a2.4 2.4 0 0 1-3.408 0l-6.71-6.71A2 2 0 0 1 6 9.172V3a1 1 0 0 1 1-1z" /> <path d="M2 7v6.172a2 2 0 0 0 .586 1.414l6.71 6.71a2.4 2.4 0 0 0 3.191.193" /> <circle cx="10.5" cy="6.5" r=".5" fill="currentColor" />',
    'credit-card': '<rect width="20" height="14" x="2" y="5" rx="2" /> <line x1="2" x2="22" y1="10" y2="10" />',
    'gift': '<path d="M12 7v14" /> <path d="M20 11v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8" /> <path d="M7.5 7a1 1 0 0 1 0-5A4.8 8 0 0 1 12 7a4.8 8 0 0 1 4.5-5 1 1 0 0 1 0 5" /> <rect x="3" y="7" width="18" height="4" rx="1" />',
    'menu': '<path d="M4 5h16" /> <path d="M4 12h16" /> <path d="M4 19h16" />',
  };
  if (!artwork[name]) return appIcon(name);
  return `<svg class="app-icon nav-reference-icon" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${artwork[name]}</svg>`;
}

function renderNav() {
  const registered = state.client?.registered;
  document.body.classList.toggle('app-nav-unified', Boolean(registered));
  $nav.classList.toggle('hidden', !registered);
  if (!registered) return;
  const items = [
    ['home', 'Головна', icons.home],
    ['offers', 'Пропозиції', icons.offers],
    ['card', 'Моя карта', icons.card],
    ['rewards', 'За зірки', icons.rewards],
    ['more', 'Ще', icons.more]
  ];
  const moreRoutes = ['stores', 'rewardCodes', 'progress', 'history', 'news', 'profile', 'support', 'priceCheck'];
  $nav.innerHTML = items.map(([route, label, icon]) => {
    const active = state.route === route || (route === 'more' && moreRoutes.includes(state.route));
    return `<button class="${active ? 'active' : ''} ${route === 'card' ? 'nav-card' : ''}" data-route="${route}" aria-label="${label}"><span class="nav-icon-shell">${navIcon(icon)}</span><small>${label}</small></button>`;
  }).join('');
}

function startScreen() {
  return `
    <section class="hero">
      <div class="hero-card">
        <div class="hero-logo"><div class="logo-star"></div></div>
        <h1>Ласкаво просимо<br>у Star Club</h1>
        <div class="benefits">
          <div class="benefit"><span class="circle-icon">${appIcon('circle-star')}</span>Збирайте зірки</div>
          <div class="benefit"><span class="circle-icon">${appIcon('badge-percent')}</span>Клубні ціни</div>
          <div class="benefit"><span class="circle-icon">${appIcon('gift')}</span>Товари за зірки</div>
          <div class="benefit"><span class="circle-icon">${appIcon('user-round')}</span>Персональні пропозиції</div>
        </div>
        <button class="btn" data-route="register">Зареєструватися</button>
        <div class="social-auth">
          <button class="social-btn" data-auth-telegram type="button">${appIcon('send')}<span>Увійти через Telegram</span></button>
        </div>
        <p class="link-row">Вже є акаунт? <button data-route="login">Увійти</button></p>
      </div>
    </section>
  `;
}

function loginScreen() {
  return `
    ${header('Вхід', true)}
    <form id="loginForm" class="stack">
      <div class="banner">
        <span class="circle-icon">★</span>
        <div>Увійдіть у Star Club<br><strong>за номером і паролем</strong></div>
      </div>
      <input class="input" name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="+380XXXXXXXXX" value="+380" maxlength="13" required>
      <input class="input" name="password" type="password" autocomplete="current-password" placeholder="Пароль" minlength="6" required>
      <button class="btn" type="submit">Увійти</button>
      <div class="social-auth">
        <button class="social-btn" data-auth-telegram type="button">${appIcon('send')}<span>Увійти через Telegram</span></button>
      </div>
      <p class="link-row">Ще немає акаунта? <button type="button" data-route="register">Зареєструватися</button></p>
    </form>
  `;
}

function telegramPasswordScreen() {
  const c = state.client || {};
  return `
    ${header('Створіть пароль', true)}
    <form id="telegramPasswordForm" class="stack">
      <div class="banner">
        <span class="circle-icon">${appIcon('send')}</span>
        <div>Telegram підтверджено<br><strong>${c.name || 'Клієнт Star Club'}</strong>${c.phone ? `<br><span class="small">${c.phone}</span>` : ''}</div>
      </div>
      <p class="small">Перед входом створіть пароль. Далі ви зможете входити за номером телефону і паролем.</p>
      <input class="input" name="password" type="password" autocomplete="new-password" placeholder="Пароль мінімум 6 символів" minlength="6" required>
      <input class="input" name="password_confirm" type="password" autocomplete="new-password" placeholder="Повторіть пароль" minlength="6" required>
      <button class="btn" type="submit">Зберегти пароль</button>
    </form>
  `;
}

function registerScreen() {
  const c = state.client || {};
  const stores = state.stores || [];
  const storeOptions = stores.map((s) => `<option value="${s.id}" ${c.favorite_store === s.id ? 'selected' : ''}>${s.name}</option>`).join('');
  const needPassword = !c.password_set;
  const bonus = c.profile_progress?.bonus || { enabled: true, stars: 500, grantWhen: 'immediately' };
  const showBonus = bonus.enabled && !c.profile_bonus_awarded;
  const bonusText = bonus.grantWhen === 'after_first_purchase' ? 'після першої покупки' : 'після повного профілю';
  return `
    ${header(c.registered ? 'Профіль' : 'Реєстрація', true)}
    <form id="registerForm" class="stack">
      ${showBonus ? `<div class="banner"><span class="circle-icon">★</span><div>Заповніть повний профіль<br>та отримайте <strong>${fmtStars(bonus.stars)} ★</strong> ${bonusText}</div></div>` : ''}
      <input class="input" name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="+380XXXXXXXXX" value="${c.phone || '+380'}" pattern="^(\\+?380\\d{9}|0\\d{9})$" maxlength="13" required>
      <input class="input" name="name" placeholder="Імʼя" value="${c.name || ''}" required>
      <label class="input-field date-field"><span>Дата народження</span><input class="input" name="birth_date" type="date" value="${c.birth_date || ''}" required></label>
      <label class="registration-store-field">
        <select class="input" name="favorite_store" required>
          <option value="">Улюблений магазин</option>
          ${storeOptions}
        </select>
        <span class="registration-field-chevron" aria-hidden="true"></span>
      </label>
      <input class="input" name="email" type="email" autocomplete="email" placeholder="Email (необовʼязково)" value="${c.email || ''}">
      <input class="input" name="preferences" placeholder="Вподобання через кому: кава, випічка" value="${Array.isArray(c.preferences) ? c.preferences.join(', ') : ''}">
      ${needPassword ? `
        <input class="input" name="password" type="password" autocomplete="new-password" placeholder="Пароль мінімум 6 символів" minlength="6" required>
        <input class="input" name="password_confirm" type="password" autocomplete="new-password" placeholder="Повторіть пароль" minlength="6" required>
      ` : ''}
      <section class="card gold-border registration-privacy-card">
        <h3>Реєстрація і конфіденційність</h3>
        <label class="check registration-privacy-check">
          <input type="checkbox" name="agree_privacy" ${(c.consents?.rules && c.consents?.personal_data && c.consents?.phone) ? 'checked' : ''} required>
          <span>Погоджуюсь з <button class="privacy-link" type="button" data-route="privacy">правилами конфіденційності</button></span>
        </label>
      </section>
      <button class="btn" type="submit">${c.registered ? 'Зберегти профіль' : 'Завершити реєстрацію'}</button>
    </form>
  `;
}


function privacyScreen() {
  return `
    ${header('Правила і конфіденційність', true)}
    <div class="stack privacy-page">
      <section class="card gold-border">
        <p class="eyebrow">STAR CLUB</p>
        <h2>Правила програми лояльності та Політика конфіденційності</h2>
        <p class="small">Редакція від 12 липня 2026 року.</p>
      </section>

      <section class="card">
        <h3>1. Загальні положення</h3>
        <p>Star Club — програма лояльності мережі магазинів «Надія». Реєстрація є добровільною. Учасник створює особистий акаунт, отримує цифрову картку, може накопичувати зірки, користуватися клубними або оптовими цінами, накопичувальними програмами, QR-кодами та персональними пропозиціями.</p>
        <p>Фактичні умови окремої пропозиції, строк її дії, перелік товарів, магазинів та інші обмеження відображаються у застосунку або визначаються правилами конкретної акції.</p>
      </section>

      <section class="card">
        <h3>2. Які дані обробляються</h3>
        <p>Для роботи Star Club можуть оброблятися: ім’я, мобільний номер, дата народження, електронна пошта за бажанням, улюблений магазин і вподобання; Telegram ID та дані, які Telegram передає застосунку; номер цифрової картки; історія покупок, товари, кількість, суми чеків, нарахування і списання зірок; прогрес накопичувальних програм і челенджів; QR-коди, купони та звернення до підтримки; технічні дані сесії, необхідні для входу, безпеки й роботи застосунку.</p>
      </section>

      <section class="card">
        <h3>3. Мета обробки</h3>
        <p>Дані використовуються для реєстрації та ідентифікації учасника, входу за номером телефону або Telegram, прив’язки цифрової картки, застосування клубних і оптових цін у 1С, ведення балансу зірок та історії чеків, нарахування прогресу, створення і підтвердження QR-кодів, підтримки користувача, запобігання зловживанням і забезпечення технічної безпеки.</p>
        <p>Маркетингові повідомлення надсилаються лише за окремою згодою. Відмова від них не припиняє участь у програмі.</p>
      </section>

      <section class="card">
        <h3>4. Обробка мобільного номера</h3>
        <p>Мобільний номер використовується як ідентифікатор учасника, для пошуку і прив’язки картки, входу до акаунта, відновлення доступу, об’єднання покупок з профілем, сервісних повідомлень та звернень до підтримки. Номер не повинен використовуватися для сторонньої реклами без окремої згоди учасника.</p>
      </section>

      <section class="card">
        <h3>5. Передавання і зберігання</h3>
        <p>Дані можуть оброблятися постачальниками технічної інфраструктури, Telegram, касовою системою та 1С, а також підрядниками, які забезпечують роботу сервісу, лише в обсязі, необхідному для їхніх функцій. Доступ до адміністративної частини обмежується авторизацією.</p>
        <p>Дані зберігаються протягом участі у програмі та додаткового строку, необхідного для виконання законних, бухгалтерських, безпекових або технічних вимог. Після припинення участі дані видаляються або знеособлюються, крім відомостей, які мають зберігатися за законом.</p>
      </section>

      <section class="card">
        <h3>6. Права учасника</h3>
        <p>Учасник може отримати інформацію про свої дані, уточнити або виправити їх, відкликати згоду на маркетингові повідомлення, звернутися щодо видалення акаунта чи припинення обробки, коли це допускається законодавством, а також подати звернення через розділ «Підтримка».</p>
        <p>Відкликання обов’язкової згоди на обробку даних, без яких неможливо ідентифікувати учасника та вести його бонусний рахунок, може призвести до закриття акаунта і припинення участі у програмі.</p>
      </section>

      <section class="card">
        <h3>7. Згода під час реєстрації</h3>
        <p>Позначаючи обов’язкові поля згоди та натискаючи «Завершити реєстрацію», учасник підтверджує, що прочитав ці правила, надає добровільну й поінформовану згоду на обробку персональних даних та окремо погоджується на обробку мобільного номера для цілей Star Club.</p>
        <p class="small">Для юридичного оформлення перед публічним запуском у цей документ потрібно підставити повне найменування, код ЄДРПОУ, адресу та контакт власника програми/володільця персональних даних.</p>
      </section>

      <button class="btn" type="button" data-route="register">Повернутися до реєстрації</button>
    </div>
  `;
}

function homeBanner() {
  const bannerData = state.data.banners || { enabled: false, items: [] };
  const remoteSlides = bannerData.enabled === false ? [] : (bannerData.items || []).slice(0, 7);
  const slides = [
    {
      tag: 'НОВИНКА',
      title: 'Сезонний раф «Карамельний горіх»',
      text: 'Спробуйте новий смак цієї осені.',
      image_url: '/assets/design/home-banner-coffee.webp',
      link_route: 'offers',
      home_generated: true
    },
    ...remoteSlides
  ];
  return `
    <section class="home-banner-v2" aria-label="Банери Star Club">
      <div class="home-banner-rail-v2">
        ${slides.map((item) => `
          <button class="home-banner-slide-v2" type="button" ${item.link_route && item.link_route !== 'none' ? `data-route="${safeHtml(item.link_route)}"` : ''}>
            ${item.home_generated
              ? `<img class="home-banner-generated-bg" src="${safeHtml(item.image_url)}" alt="">`
              : `<div class="home-banner-remote-bg"><img src="${safeHtml(item.image_url || '/assets/star.svg')}" alt="" onerror="this.onerror=null;this.src='/assets/star.svg'"></div>`}
            <div class="home-banner-copy-v2">
              <span>${safeHtml(item.tag || 'STAR CLUB')}</span>
              <h2>${safeHtml(item.title || 'Новини Star Club')}</h2>
              <p>${safeHtml(item.text || '')}</p>
            </div>
          </button>
        `).join('')}
      </div>
      <div class="home-banner-dots-v2" aria-hidden="true">${slides.map((_, index) => `<i class="${index === 0 ? 'active' : ''}"></i>`).join('')}</div>
    </section>`;
}

function bindHomeBannerCarousel() {
  const rail = document.querySelector('.home-banner-rail-v2');
  const dots = [...document.querySelectorAll('.home-banner-dots-v2 i')];
  if (!rail || dots.length < 2) return;
  let frame = 0;
  const syncDots = () => {
    frame = 0;
    const pageWidth = Math.max(1, rail.clientWidth);
    const activeIndex = Math.min(dots.length - 1, Math.max(0, Math.round(rail.scrollLeft / pageWidth)));
    dots.forEach((dot, index) => dot.classList.toggle('active', index === activeIndex));
  };
  rail.addEventListener('scroll', () => {
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(syncDots);
  }, { passive: true });
  syncDots();
}

function renderHomeStepIcons(progress, total, type) {
  const safeTotal = Math.max(1, Math.min(12, Number(total || 1)));
  const safeProgress = Math.max(0, Math.min(Number(progress || 0), safeTotal));
  return Array.from({ length: safeTotal }, (_, index) => {
    const active = index < safeProgress;
    const icon = type === 'cup'
      ? (active ? 'home-step-cup-on.svg' : 'home-step-cup-off.svg')
      : (active ? 'home-step-star-on.svg' : 'home-step-star-off.svg');
    return `<img src="/assets/icons/${icon}${type === 'cup' ? '' : '?v=45'}" alt="" aria-hidden="true">`;
  }).join('');
}

function homeScreen() {
  const c = state.client || {};
  const live = state.data.progress || { stamps: [], challenges: [] };
  const challenge = live.challenges?.[0] || {};
  const stamp = live.stamps?.[0] || {};
  const challengeRequired = Math.max(1, Number(challenge.required_visits || 7));
  const challengeProgress = Math.max(0, Math.min(Number(challenge.progress || 0), challengeRequired));
  const challengeReward = Number(challenge.reward_stars || 1000);
  const challengeLeft = Math.max(0, challengeRequired - challengeProgress);
  const stampRequired = Math.max(1, Number(stamp.required_qty || 9));
  const stampProgress = Math.max(0, Math.min(Number(stamp.progress || 0), stampRequired));
  const stampLeft = Math.max(0, stampRequired - stampProgress);
  const unread = unreadNotificationsCount();
  return `
    <section class="home-live-v2">
      <header class="home-live-header">
        <img class="home-live-mountains" src="/assets/design/home-header-mountains.webp" alt="" aria-hidden="true">
        <div class="home-live-brand-row">
          <div class="home-live-brand">
            <img class="home-live-brand-star" src="/assets/design/home-brand-star.svg" alt="" aria-hidden="true">
            <span>StarClub</span>
          </div>
        </div>
        <div class="home-live-welcome-row">
          <div class="home-live-user-icon">${appIcon('user-round')}</div>
          <div class="home-live-welcome-copy">
            <h1>Вітаємо, ${safeHtml(c.name || 'Denys')}!</h1>
            <p>Кожна покупка наближає<br>до нових можливостей!</p>
          </div>
          <div class="home-live-script"><span>Більше</span><span>ніж покупки</span><span>♡</span></div>
          <button type="button" class="home-live-bell" data-toggle-notifications aria-label="Повідомлення">
            ${appIcon(icons.notification)}
            ${unread ? `<span class="home-live-bell-badge">${unread > 9 ? '9+' : unread}</span>` : ''}
          </button>
        </div>
        ${state.notificationPanelOpen ? `<div class="home-live-notification-panel">${renderNotificationPanel()}</div>` : ''}
      </header>

      ${homeBanner()}

      <button class="home-live-balance" type="button" data-route="card">
        <div class="home-live-balance-copy">
          <span>Ваш баланс</span>
          <strong>${fmtStars(c.stars_balance)} <b><img src="/assets/design/home-balance-value-star.svg" alt="" aria-hidden="true"></b></strong>
          <small>Більше зірок — більше можливостей!</small>
        </div>
        <img class="home-live-balance-star" src="/assets/design/home-brand-star.svg" alt="" aria-hidden="true">
        <i>›</i>
      </button>

      <button class="home-live-program" type="button" data-route="progress">
        <span class="home-live-program-icon"><img src="/assets/icons/program-trophy-card.png" alt="" aria-hidden="true"></span>
        <div class="home-live-program-main">
          <div class="home-live-program-title">${safeHtml(challenge.name || '7 днів зі Star')}</div>
          <div class="home-live-program-subtitle">Ще ${challengeLeft} днів до бонусу ${fmtStars(challengeReward)} ★</div>
          <div class="home-live-steps home-live-stars">${renderHomeStepIcons(challengeProgress, challengeRequired, 'star')}</div>
        </div>
        <span class="home-live-program-count">${challengeProgress}/${challengeRequired}</span>
      </button>

      <button class="home-live-program" type="button" data-route="progress">
        <span class="home-live-program-icon"><img src="/assets/icons/program-coffee-card.png" alt="" aria-hidden="true"></span>
        <div class="home-live-program-main">
          <div class="home-live-program-title">${safeHtml(stamp.name || '10-та кава')}</div>
          <div class="home-live-program-subtitle">Ще ${stampLeft} до безкоштовного коду</div>
          <div class="home-live-steps home-live-cups">${renderHomeStepIcons(stampProgress, stampRequired, 'cup')}</div>
        </div>
        <span class="home-live-program-count">${stampProgress}/${stampRequired}</span>
      </button>
    </section>
  `;
}

async function refreshClient() {
  const me = await api('/api/client/me');
  state.client = me.client;
  renderNav();
}

async function loadRewards() {
  const [data, qrs] = await Promise.all([api('/api/client/rewards'), api('/api/client/reward-qrs')]);
  state.data.rewards = { ...data, qrs: qrs.qrs || [] };
  syncPersonalQrNotifications(qrs.qrs || [], qrs.coupons || []);
}

async function loadRewardQrs() {
  { const data = await api('/api/client/reward-qrs'); state.data.rewardQrs = data.qrs || []; state.data.personalCoupons = data.coupons || []; syncPersonalQrNotifications(data.qrs || [], data.coupons || []); }
}

async function loadOffers() {
  const data = await api('/api/client/offers');
  state.data.offers = data.offers || [];
  state.data.offerStores = data.stores || [];
  state.data.offerStoreId = data.favorite_store || state.client?.favorite_store || 'all';
  state.data.offerStoreName = data.favorite_store_name || data.stores?.[0]?.name || '';
}

async function loadProgress() {
  state.data.progress = await api('/api/client/progress');
}

async function loadHistory() {
  const [history, receipts] = await Promise.all([api('/api/client/star-history'), api('/api/client/receipts')]);
  state.data.ledger = history.items;
  state.data.receipts = receipts.receipts;
}

async function loadNews() {
  state.data.news = (await api('/api/client/news')).news;
}

async function loadBanners() {
  const data = await api('/api/client/banners');
  state.data.banners = { enabled: data.enabled !== false, items: data.banners || [] };
}

async function loadSupport() {
  state.data.supportTickets = (await api('/api/client/support/tickets')).tickets || [];
}

function activityStorageKey() {
  return `starclub_activity_${state.client?.id || state.client?.card_number || 'guest'}`;
}

function getLatestCouponKey(coupons = []) {
  return [...coupons]
    .sort(
      (a, b) =>
        new Date(b.updated_at || b.used_at || b.created_at || 0) -
        new Date(a.updated_at || a.used_at || a.created_at || 0)
    )
    .map(
      (coupon) =>
        `${coupon.id || coupon.code}:` +
        `${coupon.status || 'active'}:` +
        `${coupon.used_at || ''}:` +
        `${coupon.updated_at || ''}`
    )
    .join('|');
}

function getLatestReceiptKey(receipts = []) {
  const r = [...receipts].sort((a, b) => new Date(b.purchased_at || b.created_at || 0) - new Date(a.purchased_at || a.created_at || 0))[0];
  return r ? `${r.id || ''}|${r.purchased_at || r.created_at || ''}` : '';
}

function getLatestReservedQrKey(qrs = []) {
  const active = qrs.filter((q) => q.status === 'reserved');
  const q = active.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))[0];
  return q ? `${q.token || q.manual_code || q.id}|${q.created_at || ''}` : '';
}

function getLatestAdminSupportKey(tickets = []) {
  const adminMessages = [];
  tickets.forEach((ticket) => (ticket.messages || []).forEach((m) => {
    if (m.sender_type === 'admin') adminMessages.push(m);
  }));
  const m = adminMessages.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))[0];
  return m ? `${m.id || m.created_at}|${m.created_at || ''}` : '';
}

async function getClientActivitySnapshot() {
  const [qrsData, receiptsData, supportData, meData] = await Promise.all([
    api('/api/client/reward-qrs'),
    api('/api/client/receipts'),
    api('/api/client/support/tickets'),
    api('/api/client/me')
  ]);
  state.client = meData.client;
  renderNav();
  const qrs = qrsData.qrs || [];
  syncPersonalQrNotifications(qrs, qrsData.coupons || []);
  const receipts = receiptsData.receipts || [];
  const tickets = supportData.tickets || [];
  return {
    latestQr: getLatestReservedQrKey(qrs),
    latestReceipt: getLatestReceiptKey(receipts),
    latestSupport: getLatestAdminSupportKey(tickets),
    balance: state.client?.stars_balance ?? null,
    qrsCount: qrs.length,
    receiptsCount: receipts.length,
    latestCoupon: getLatestCouponKey(qrsData.coupons || []),
    supportCount: tickets.reduce((sum, t) => sum + (t.messages || []).length, 0)
  };
}

function loadStoredActivitySnapshot() {
  try { return JSON.parse(localStorage.getItem(activityStorageKey()) || 'null'); } catch { return null; }
}

function saveActivitySnapshot(snapshot) {
  state.activitySnapshot = snapshot;
  try { localStorage.setItem(activityStorageKey(), JSON.stringify(snapshot)); } catch {}
}

async function checkClientActivity({ initialize = false } = {}) {
  if (!state.token || !state.client?.registered || state.activityBusy || document.hidden) return;
  state.activityBusy = true;
  try {
    const previous = state.activitySnapshot || loadStoredActivitySnapshot();
    const next = await getClientActivitySnapshot();
    if (initialize || !previous || !state.activityReady) {
      saveActivitySnapshot(next);
      state.activityReady = true;
      return;
    }

    let message = '';
    let route = '';
    if (next.latestSupport && next.latestSupport !== previous.latestSupport) {
      message = 'Підтримка відповіла на ваше звернення';
      route = 'support';
    } else if (next.latestReceipt && next.latestReceipt !== previous.latestReceipt) {
      message = 'Покупку додано в історію';
      route = 'history';
    }

    saveActivitySnapshot(next);
    state.activityReady = true;
    if (message) notifyInApp(message, route, { dedupeKey: `${route}:${next.latestQr || next.latestSupport || next.latestReceipt}` });
  } catch (error) {
    console.warn('Activity check failed:', error.message || error);
  } finally {
    state.activityBusy = false;
  }
}

function hasFocusedEditor() {
  const active = document.activeElement;
  return Boolean(active && active.matches?.('input, textarea, select'));
}

function routeNeedsLiveRender(route = state.route) {
  return ['home', 'card', 'rewards', 'rewardCodes', 'history', 'progress', 'support'].includes(route);
}

async function refreshVisibleData({ forceRender = false } = {}) {
  if (!state.token || state.liveBusy || document.hidden) return;
  if (!forceRender && hasFocusedEditor()) return;
  state.liveBusy = true;
  const refreshedRoute = state.route;
  try {
    await refreshClient();
    if (state.route === 'home') await Promise.all([loadProgress(), loadBanners()]);
    if (state.route === 'rewards') await loadRewards();
    if (state.route === 'rewardCodes') await loadRewardQrs();
    if (state.route === 'history') await loadHistory();
    if (state.route === 'progress') await loadProgress();
    if (state.route === 'support') await loadSupport();
    const signature = JSON.stringify({
      route: state.route,
      client: state.client,
      routeData: state.route === 'home'
        ? { progress: state.data.progress, banners: state.data.banners }
        : state.data[state.route === 'rewardCodes' ? 'rewardQrs' : state.route === 'support' ? 'supportTickets' : state.route]
    });
    const changed = signature !== state.liveSignature;
    state.liveSignature = signature;
    if (state.route === refreshedRoute && (forceRender || changed) && routeNeedsLiveRender()) render({ reuseLoaded: true });
  } catch (error) {
    console.warn('Live refresh failed:', error.message || error);
  } finally {
    state.liveBusy = false;
  }
}

function startLiveRefresh() {
  window.clearInterval(state.liveTimer);
  state.liveTimer = window.setInterval(() => {
    refreshVisibleData();
    checkClientActivity();
  }, 6000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      refreshVisibleData({ forceRender: true });
      checkClientActivity();
    }
  });
}

async function cardScreen() {
  const data = await api('/api/client/card');
  const card = data.card;
  const displayNumber = safeHtml(card.card_number || '');
  return `
    <section class="star-card-screen">
      <header class="star-card-heading">
        <button class="star-card-back" type="button" data-back="1">${appIcon('arrow-left')}<span>Назад</span></button>
        <div class="star-card-heading-copy">
          <h2>Моя карта</h2>
          <p>Більше покупок — більше можливостей</p>
        </div>
        ${notificationButton()}
      </header>

      <section class="star-member-card star-member-card-main">
        <img class="star-member-art" src="/assets/design/card/member-card-art.webp" alt="" aria-hidden="true">
        <div class="star-member-left">
          <div class="star-member-brand"><div class="star-club-emblem"><span class="star-club-emblem-star">★</span></div>
          <div class="star-club-wordmark">STAR CLUB</div></div>
          <div class="star-member-name">${safeHtml(card.name || 'Клієнт Star Club')}</div>
          <div class="star-member-number-label">№ картки</div>
          <div class="star-member-number">${displayNumber}</div>
        </div>
      </section>

      <section class="star-balance-card">
        <img class="star-balance-art" src="/assets/design/card/balance-card-art.png" alt="" aria-hidden="true">
        <div class="star-balance-label">Актуальний баланс</div>
        <div class="star-balance-value"><strong>${fmtStars(card.stars_balance)}</strong><span>★</span></div>
        <div class="star-balance-note">${appIcon('coins')}<span>Збирайте зірки та отримуйте нагороди</span></div>
        <button class="star-cashier-button" type="button" data-show-cashier data-card-number="${displayNumber}">
          ${appIcon('barcode')}<span>Показати касиру</span><b aria-hidden="true">›</b>
        </button>
      </section>

      <img class="star-promo-card-image" src="/assets/design/card/promo-card-reference.webp" alt="Більше покупок — більше можливостей. Збирайте зірки, отримуйте нагороди та особливі пропозиції">
    </section>
  `;
}

function rewardReferenceImage(reward) {
  // Real 1C pictures and admin uploads take precedence over old decorative presets.
  const custom = String(reward.image_url || '');
  if(custom && !/^\/assets\/(?:star|baguette|coffee|croissant|water)\.svg$/i.test(custom)) return custom;
  const name = String(reward.name || '').toLowerCase();
  const preset = String(reward.image_url || '');
  let image = '';
  if (/buondi|буонді|еспресо|espresso/.test(name) || preset === '/assets/coffee.svg') image = 'espresso';
  else if (/круасан|croissant/.test(name)) image = 'croissant';
  else if (/snickers|снікерс|сникерс/.test(name)) image = 'snickers';
  else if (/моршин|morshyn/.test(name) || preset === '/assets/water.svg') image = 'water';
  else if (/lactel|лактель|лактел/.test(name)) image = 'milk';
  return image ? `/assets/design/rewards/${image}.webp` : (reward.image_url || '/assets/star.svg');
}

function rewardsScreen() {
  const data = state.data.rewards;
  const items = data?.items || [];
  const active = (data?.qrs || []).filter((q) => q.status === 'reserved' && q.source_type !== 'stamp_program');
  const query = String(state.data.rewardSearch || '').trim().toLocaleLowerCase('uk');
  const matches = (r) => `${r.name || ''} ${r.conditions || ''}`.toLocaleLowerCase('uk').includes(query);
  return `
    <section class="rewards-design">
      <header class="rewards-heading">
        <button class="back-button" type="button" data-back="1">${appIcon('arrow-left')}<span>Назад</span></button>
        <div><h2>За зірки</h2><p>Обирайте, отримуйте, насолоджуйтесь</p></div>
        ${notificationButton()}
      </header>
      <img class="rewards-reference-banner" src="/assets/design/rewards/banner.webp" alt="Обирайте улюблені нагороди за зірки. Більше покупок — більше можливостей. Вигода у кожній покупці!">
      <label class="rewards-search">${appIcon('search')}<input type="search" data-rewards-search value="${safeHtml(state.data.rewardSearch || '')}" placeholder="Пошук нагород..." aria-label="Пошук нагород" autocomplete="off"></label>
      <div class="rewards-product-list">
        ${items.map((r) => `
          <article class="rewards-product ${matches(r) ? '' : 'hidden'}" data-reward-search-text="${safeHtml(`${r.name || ''} ${r.conditions || ''}`.toLocaleLowerCase('uk'))}">
            <img class="rewards-product-image" src="${safeHtml(rewardReferenceImage(r))}" alt="${safeHtml(r.name)}" onerror="this.onerror=null;this.src='/assets/star.svg'">
            <div class="rewards-product-copy">
              <h3>${safeHtml(r.name)}</h3>
              <div class="rewards-product-price">${fmtStars(r.stars_price)} <span>★</span></div>
              <p>${safeHtml(r.conditions || '')}</p>
            </div>
            <button class="rewards-get" type="button" data-create-reward="${safeHtml(r.id)}" ${r.can_get ? '' : 'disabled'}>${r.can_get ? 'Отримати' : 'Недостатньо'}</button>
          </article>
        `).join('')}
        <p class="rewards-search-empty ${items.some(matches) ? 'hidden' : ''}" data-rewards-empty>${items.length ? 'Нагород за вашим запитом не знайдено' : 'Наразі немає доступних нагород'}</p>
      </div>
      <div class="stack rewards-code-access">
        <p class="small">Доступно: ${fmtStars(data?.available_stars || 0)} ★</p>
        ${active.length ? `<section class="card gold-border"><b>Активні коди</b><p class="small">У вас є активний QR-код. Його можна повторно відкрити.</p>${active.map((q)=>`<button class="reward-code-row" data-open-reward-code="${safeHtml(q.token)}"><span>${safeHtml(q.reward.name)}</span><b>${safeHtml(q.manual_code)}</b></button>`).join('')}</section>` : ''}
        <button class="card gold-border reward-codes-link" data-route="rewardCodes"><b>Мої QR-коди</b><p class="small">Активні коди та історія використання</p></button>
      </div>
    </section>`;
}

function rewardCodesScreen() {
  const qrs = state.data.rewardQrs || [];

const coupons = (state.data.personalCoupons || []).filter((coupon) => {
  const status = String(coupon.status || 'active').toLowerCase();
  const expiresAt = coupon.expires_at
    ? new Date(coupon.expires_at).getTime()
    : Number.POSITIVE_INFINITY;

  return status === 'active' && expiresAt > Date.now();
});
  const active = qrs.filter((q) => q.status === 'reserved');
  const history = qrs.filter((q) => q.status !== 'reserved');
  const statusText = { reserved: 'активний', used: 'використаний', canceled: 'скасований', expired: 'прострочений' };
  const renderQr = (q) => `
    <section class="card reward-code-card">
      <div class="progress-row"><div><b>${q.reward.name}</b><p class="small">${q.manual_code} · ${fmtStars(q.stars_reserved)} ★</p></div><span class="pill">${statusText[q.status] || q.status}</span></div>
      <p class="small">Створено: ${fmtDate(q.created_at)} ${fmtTime(q.created_at)}${q.status === 'reserved' ? ` · діє до ${fmtTime(q.expires_at)}` : ''}</p>
      ${q.status === 'reserved' ? `<div class="modal-actions"><button class="btn secondary" data-cancel-reward-code="${q.manual_code}" type="button">Скасувати</button><button class="btn" data-open-reward-code="${q.manual_code}" type="button">Відкрити QR</button></div>` : ''}
    </section>`;
  return `
    ${header('Мої QR-коди', true)}
    <div class="stack">
      ${coupons.length ? `<section class="card personal-coupon-list"><div class="section-heading compact"><span>${appIcon('ticket-percent')}</span><div><h3>Персональні знижки</h3><p>Лише для вас</p></div></div>${coupons.map(c=>`<article class="personal-coupon-card"><span class="personal-coupon-value">−${c.discount_percent}%</span><div class="personal-coupon-copy"><b>${safeHtml(c.product_name||'Персональна пропозиція')}</b><p>Діє до ${new Date(c.expires_at).toLocaleDateString('uk-UA')} · максимум ${Number(c.max_units||1)} шт.</p></div><button type="button" class="btn personal-coupon-show" data-show-personal-coupon="${safeHtml(c.code)}" data-coupon-name="${safeHtml(c.product_name||'Персональна пропозиція')}" data-coupon-percent="${Number(c.discount_percent||0)}" data-coupon-max-units="${Number(c.max_units||1)}" data-coupon-expiry="${safeHtml(c.expires_at||'')}">Показати касиру</button></article>`).join('')}</section>` : ''}
      <section class="card gold-border"><b>Активні</b>${active.length ? active.map(renderQr).join('') : '<div class="empty">Активних кодів немає</div>'}</section>
      <section class="card"><b>Історія</b>${history.length ? history.map(renderQr).join('') : '<div class="empty">Історія кодів порожня</div>'}</section>
    </div>
  `;
}

function formatOfferMoney(cents) {
  return `${(Number(cents || 0) / 100).toFixed(2).replace('.', ',')} грн`;
}

function clientOfferPriceLabel(o) {
  if (o.current_price_cents !== null && o.current_price_cents !== undefined) {
    return `${o.price_from ? 'від ' : ''}${formatOfferMoney(o.current_price_cents)}`;
  }
  return o.discount_label || 'Star Club';
}

function offersScreen() {
  const all = state.data.offers || [];
  const tab = state.data.offerTab || 'club';
  const selectedStore = state.data.offerStoreId || state.client?.favorite_store || 'all';
  const selectedStoreName = state.data.offerStoreName || selectedStore;
  const items = all.filter((o) => {
    if (o.type !== tab) return false;
    const offerStore = String(o.store_id || 'all');
    return offerStore === 'all' || selectedStore === 'all' || offerStore === String(selectedStore);
  });
  return `
    <section class="offers-design ${tab === 'wholesale' ? 'offers-wholesale' : 'offers-club'}">
    <header class="offers-heading">
      <button class="back-button" type="button" data-back="1">${appIcon('arrow-left')}<span>Назад</span></button>
      <div class="offers-heading-copy"><img loading="lazy" decoding="async" src="/assets/starclub-crown.svg" alt="" aria-hidden="true"><h2>${tab === 'club' ? 'Клубні пропозиції' : 'Оптові пропозиції'}</h2><p>${tab === 'wholesale' ? 'Більші обсяги — більша вигода' : 'Вигідніше з кожною покупкою'}</p></div>
      ${notificationButton()}
    </header>
    <div class="stack offers-content">
      <div class="tabs">
        <button class="${tab === 'club' ? 'active' : ''}" data-offer-tab="club">${appIcon('star-fill')}Клубні</button>
        <button class="${tab === 'wholesale' ? 'active' : ''}" data-offer-tab="wholesale">${appIcon('shopping-cart')}Оптові</button>
      </div>
      <button type="button" class="offers-store-note" data-route="profile">${appIcon('store')}<span>Ціни для улюбленого магазину</span><b>${safeHtml(selectedStoreName || 'не вибрано')}</b><i aria-hidden="true">›</i></button>
      ${items.map((o, index) => {
        const oldPrice = o.old_price_cents === null || o.old_price_cents === undefined ? null : Number(o.old_price_cents);
        const newPrice = o.current_price_cents === null || o.current_price_cents === undefined ? null : Number(o.current_price_cents);
        const saving = o.saving_cents === null || o.saving_cents === undefined
          ? (oldPrice !== null && newPrice !== null ? Math.max(0, oldPrice - newPrice) : null)
          : Number(o.saving_cents);
        const kindLabel = o.type === 'wholesale' ? 'Оптова' : 'Клубна';
        const showRule = o.type === 'wholesale' && o.discount_label;
        const wholesaleRules = o.type === 'wholesale' && Array.isArray(o.wholesale_tiers) && o.wholesale_tiers.length
          ? o.wholesale_tiers.map(t => `від ${safeHtml(t.qty)} шт — ${t.price_cents != null ? formatOfferMoney(t.price_cents) : safeHtml(t.mode==='percent' ? `−${t.value}%` : 'за умовами пропозиції')}`).join('<br>')
          : '';
        const multiplier = Number(o.stars_multiplier || 0);
        const scope = String(o.store_id || 'all') === 'all' ? 'Усі магазини' : (o.store_name || o.store_id);
        const fallbackImage = /вода|water|молоко/i.test(o.target_name || o.name || '') ? '/assets/water.svg' : /кава|раф|coffee/i.test(o.target_name || o.name || '') ? '/assets/coffee.svg' : /хліб|випіч|круасан/i.test(o.target_name || o.name || '') ? '/assets/croissant.svg' : '/assets/starclub-bag.svg';
        return `<article class="card promo-feed-card offer-compact-card">
          ${multiplier > 1 ? `<span class="offer-multiplier">x${safeHtml(multiplier)}★</span>` : ''}
          <div class="promo-feed-card__body">
            <div class="offer-compact-meta"><span>${kindLabel}</span><small>${safeHtml(scope)}</small></div>
            <h3>${safeHtml(o.target_name || o.name)}</h3>
            <p class="promo-feed-description">${safeHtml(o.description || '')}</p>
            <div class="offer-compact-prices">${newPrice !== null ? `<strong>${o.price_from ? 'від ' : ''}${formatOfferMoney(newPrice)}</strong>` : `<strong>${safeHtml(o.discount_label || 'Star Club')}</strong>`}${oldPrice !== null ? `<s>${o.price_from ? 'від ' : ''}${formatOfferMoney(oldPrice)}</s>` : ''}${saving !== null && saving > 0 ? `<span>−${formatOfferMoney(saving)}</span>` : ''}</div>
            ${wholesaleRules ? `<p class="offer-compact-rule offer-tier-list">${wholesaleRules}</p>` : (showRule ? `<p class="offer-compact-rule">${safeHtml(o.discount_label)}</p>` : '')}
            ${o.type==='club' && Number(o.max_club_qty_per_receipt)>0 ? `<p class="offer-club-limit">До ${safeHtml(o.max_club_qty_per_receipt)} шт за клубною ціною в одному чеку</p>`:''}
          </div>
          <div class="promo-feed-card__media">
            ${o.type === 'wholesale' ? `<svg class="wholesale-discount-tag" viewBox="0 0 36 42" aria-hidden="true"><path d="M19 1h12a4 4 0 0 1 4 4v13L15 40 1 26Z" fill="#efc565"/><circle cx="28" cy="8" r="2.5" fill="#45330d"/><path d="m11 25 11-10" stroke="#16140e" stroke-width="2.4" stroke-linecap="round"/><circle cx="11" cy="18" r="2" fill="none" stroke="#16140e" stroke-width="1.8"/><circle cx="22" cy="25" r="2" fill="none" stroke="#16140e" stroke-width="1.8"/></svg>` : ''}
            <img loading="lazy" decoding="async" src="${safeHtml(o.image_url || fallbackImage)}" alt="${safeHtml(o.target_name || o.name || '')}" onerror="this.onerror=null;this.src='/assets/star.svg'">
            ${o.type === 'wholesale' ? `<p class="wholesale-media-caption">${index % 2 === 0 ? 'Вигідна ціна<br>для оптових покупок' : 'Більше покупок —<br>більше вигоди'}</p>` : ''}
          </div>
        </article>`;
      }).join('') || '<div class="card empty">Активних пропозицій для цього магазину поки немає</div>'}
    </div></section>`;
}

function progressScreen() {
  const p = state.data.progress || { stamps: [], challenges: [] };
  const progressSteps = (value, required, iconName) => {
    const total = Math.max(1, Math.min(10, Number(required || 1)));
    const filled = Math.min(total, Math.round((Number(value || 0) / Math.max(1, Number(required || 1))) * total));
    return Array.from({ length: total }, (_, index) => `<span class="program-step ${index < filled ? 'filled' : ''}">${appIcon(iconName)}</span>`).join('');
  };
  return `
    <div class="progress-design">
      <header class="progress-ref-heading">
        <button type="button" class="progress-ref-back" data-route="more">${appIcon('arrow-left')}<span>Назад</span></button>
        <div class="progress-ref-heading-copy"><h2>Прогрес і активність</h2><p>Купуйте більше — отримуйте більше!</p></div>
        ${notificationButton()}
      </header>
      <section class="progress-ref-hero">
        <span>${appIcon('award')}</span>
        <div><p class="eyebrow">STAR CLUB</p><h2>Ваші цілі та винагороди</h2><p>Виконуйте завдання — прогрес<br>оновлюється автоматично<br>після покупок.</p></div>
      </section>
      <details class="progress-ref-group" open><summary class="progress-ref-section"><span>${appIcon('trophy')}</span><div><h3>Активні челенджі</h3><p>Виконуйте завдання та отримуйте зірки</p></div><i aria-hidden="true">›</i></summary><div class="progress-ref-list">
      ${p.challenges.map((c) => `
        <section class="card challenge-card ${/дн|день|days/i.test(c.name || '') ? 'challenge-calendar' : 'challenge-bag'}">
          <div class="challenge-card-head"><span>${appIcon(/дн|день|days/i.test(c.name || '') ? 'calendar-days' : 'shopping-cart')}</span><div><b>${safeHtml(c.name)}</b><p>${safeHtml(c.description || '')}</p></div><strong>${c.progress}/${c.required_visits}</strong></div>
          <div class="progressbar"><span style="width:${Math.max(0, Math.min(100, (Number(c.progress) || 0) / Math.max(1, Number(c.required_visits) || 1) * 100))}%"></span></div>
          <p class="challenge-reward">Залишилось ${Math.max(0, c.required_visits - c.progress)} · винагорода <b>${fmtStars(c.reward_stars)} ★</b></p>
        </section>
      `).join('') || '<div class="empty">Активних челенджів поки немає</div>'}
      </div></details>
      <details class="progress-ref-group"><summary class="progress-ref-section"><span>${appIcon('coins')}</span><div><h3>Накопичувальні програми</h3><p>Збирайте покупки до безкоштовного коду</p></div><i aria-hidden="true">›</i></summary><div class="progress-ref-list">
      ${p.stamps.map((s) => `
        <section class="card stamp-program-card">
          <div class="stamp-program-head"><div><p class="eyebrow">ПРОГРАМА ЛОЯЛЬНОСТІ</p><h3>${safeHtml(s.name)}</h3></div><strong>${s.progress}/${s.required_qty}</strong></div>
          <div class="program-steps">${progressSteps(s.progress, s.required_qty, /кав|coffee/i.test(s.name || '') ? 'coffee' : 'shopping-bag')}</div>
          <div class="progressbar"><span style="width:${Math.min(100, s.progress / Math.max(1, s.required_qty) * 100)}%"></span></div>
          <div class="program-hint">${appIcon('gift')}<span>Ще <b>${Math.max(0, s.required_qty - s.progress)}</b> до безкоштовного коду. Винагорода зʼявиться автоматично.</span></div>
        </section>
      `).join('') || '<div class="empty">Накопичувальних програм поки немає</div>'}
      </div></details>
    </div>
  `;
}

async function showReceiptModal(receiptId) {
  let receipt = (state.data.receipts || []).find((r) => String(r.id) === String(receiptId));
  try {
    const detail = await api(`/api/client/receipts/${encodeURIComponent(receiptId)}`);
    receipt = detail.receipt;
  } catch (error) {
    if (!receipt) return toast('Чек не знайдено');
  }
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  const items = receipt.items || [];
  wrap.innerHTML = `
    <div class="modal receipt-modal">
      <div class="modal-heading"><div><p class="eyebrow">STAR CLUB RECEIPT</p><h2>${receipt.is_reward_purchase ? 'Покупка за зірки' : 'Чек покупки'}</h2></div><button class="icon-btn compact" data-close-modal>×</button></div>
      <p class="small">${receipt.store_name || receipt.display_title || 'Магазин Star'} · ${new Date(receipt.purchased_at).toLocaleDateString('uk-UA')} ${fmtTime(receipt.purchased_at)}</p>
      ${receipt.return_status_label ? `<p class="receipt-return-status">${safeHtml(receipt.return_status_label)}</p>` : ''}
      <div class="receipt-summary-grid">
        <div>
  <span>Сума</span>
  <b>${Number(receipt.total_uah || 0).toFixed(2).replace('.', ',')} грн</b>
</div>
        <div>
  <span>Нараховано за інші товари</span>
  <b>+${fmtStars(receipt.stars_accrued || 0)} ★</b>
</div>
      </div>
      <div class="receipt-items">
        ${items.length ? items.map((item) => `
          <div class="receipt-item">
            <div class="receipt-item-main"><b>${item.name || 'Товар'}</b><p class="small">${item.external_product_id || item.product_id || 'Без коду'}</p></div>
            <div class="receipt-item-right"><span>${Number(item.qty || 1)} × ${(Math.round(Number(item.price_cents || 0)) / 100).toFixed(2)} грн</span><b>${(Math.round(Number(item.line_total_cents || 0)) / 100).toFixed(2)} грн</b></div>
          </div>
        `).join('') : '<div class="empty">1С не передала товарні позиції цього чека. Перевірте масив items у відправці чека.</div>'}
      </div>
      <div class="receipt-total">
  <span>${receipt.is_reward_purchase ? 'Нараховано за інші товари' : 'Разом'}</span>
  <b>${receipt.is_reward_purchase
    ? `+${fmtStars(receipt.stars_accrued || 0)} ★`
    : `${receipt.total_uah} грн`}</b>
</div>
    </div>`;
  document.body.appendChild(wrap);
  wrap.querySelectorAll('[data-close-modal]').forEach((b) => b.onclick = () => wrap.remove());
}

function historyScreen() {
  const ledger = state.data.ledger || [];
  const receipts = state.data.receipts || [];
  const filter = state.data.historyFilter || 'receipts';
  const filteredLedger = ledger.filter((item) => filter === 'income' ? Number(item.amount) > 0 : filter === 'expense' ? Number(item.amount) < 0 : false);
  let previousDay = '';
  const ledgerRows = filteredLedger.map((item) => {
    const day = new Date(item.created_at).toLocaleDateString('uk-UA');
    const dayLabel = day !== previousDay ? `<div class="history-day-label">${day}</div>` : ''; previousDay = day;
    const positive = Number(item.amount) > 0;
    return `${dayLabel}<div class="history-event"><span class="history-event-icon ${positive?'income':'expense'}">${appIcon(positive?'plus':'minus')}</span><div><b>${safeHtml(item.description||item.type)}</b><p>${fmtTime(item.created_at)}</p></div><strong class="${positive?'plus':'minus'}">${positive?'+':''}${fmtStars(item.amount)} ★</strong></div>`;
  }).join('');
  const receiptRows = receipts.map((r) => `
  <button
    class="receipt-history-row"
    type="button"
    data-open-receipt="${r.id}"
  >
    <span>${appIcon(r.is_reward_purchase ? 'gift' : 'receipt-text')}</span>

    <div>
      <b>
        ${r.is_reward_purchase
          ? 'Покупка за зірки'
          : safeHtml(r.store_name || r.display_title || 'Магазин Star')}
      </b>

      <p>
        ${new Date(r.purchased_at).toLocaleDateString('uk-UA')}
        · ${(r.items || []).length} товарів
        ${r.return_status_label ? ` · <span class="receipt-return-status">${safeHtml(r.return_status_label)}</span>` : ''}
      </p>
    </div>

    <strong class="${Number(r.stars_accrued || 0) > 0 ? 'plus' : ''}">
      ${r.is_reward_purchase
        ? `+${fmtStars(r.stars_accrued || 0)} ★`
        : `${r.total_uah} грн`}
    </strong>
  </button>
`).join('');
  return `${header('Історія', true)}<div class="stack"><section class="history-balance-card"><div><p>Ваш баланс</p><div>${fmtStars(state.client.stars_balance)} <span>★</span></div></div><i>${appIcon('circle-star')}</i></section><div class="history-filters">${[['receipts','Чеки'],['income','Нарахування'],['expense','Списання']].map(([v,l])=>`<button type="button" class="${filter===v?'active':''}" data-history-filter="${v}">${l}</button>`).join('')}</div><section class="card history-list-card">${filter==='receipts'?`<div class="section-heading compact"><span>${appIcon('receipt-text')}</span><div><h3>Чеки</h3></div></div><div class="timeline">${receiptRows||'<div class="empty">Чеків ще немає</div>'}</div>`:`<div class="section-heading compact"><span>${appIcon('history')}</span><div><h3>${filter==='income'?'Нарахування':'Списання'}</h3></div></div><div class="history-events">${ledgerRows||'<div class="empty">Операцій немає</div>'}</div>`}</section></div>`;
}

function storesScreen() {
  return `
    ${header('Магазини', false)}
    <div class="stack">
      ${(state.stores || []).length ? (state.stores || []).map((s) => `
        <section class="card gold-border store">
          ${s.image_url ? `<img class="store-image" src="${s.image_url}" alt="${s.name}" onerror="this.style.display='none'">` : ''}
          <h3>${s.name}</h3>
          <p class="small">${s.address || ''}</p>
          <div class="progress-row small"><span>Графік</span><b>${s.work_hours || '08:00–22:00'}</b></div>
          <div class="progress-row small"><span>Телефон</span><b>${s.phone || '—'}</b></div>
          ${state.client.favorite_store === s.id ? '<span class="gold">★ Улюблений магазин</span>' : ''}
        </section>
      `).join('') : '<div class="empty">Магазини ще не додані адміністратором</div>'}
    </div>
  `;
}

function moreScreen() {
  const items = [
    ['stores', 'store', 'Магазини', 'Адреси, графік, контакти'],
    ['priceCheck', 'barcode', 'Дізнатись ціну', 'Скануйте штрих-код<br>товару'],
    ['rewardCodes', 'qr-code', 'Мої QR-коди', 'Активні коди<br>та історія використання'],
    ['progress', 'trophy', 'Прогрес', 'Ваші цілі та досягнення'],
    ['history', 'history', 'Історія', 'Ваші покупки<br>та нараховані зірки'],
    ['news', 'newspaper', 'Новини', 'Акції, новинки<br>та спеціальні пропозиції'],
    ['profile', 'user-round', 'Профіль', 'Ваші дані та налаштування'],
    ['support', 'message-circle', 'Підтримка', 'Ми завжди на зв’язку']
  ];
  return `
    <section class="more-reference">
      <header class="more-reference-heading">
        <span class="more-reference-mark" aria-hidden="true">${appIcon('circle-star')}</span>
        <div><h2>Ще</h2><p>Зручні функції в одному місці</p></div>
        ${notificationButton()}
      </header>
      <div class="more-reference-grid">
        ${items.map(([route, icon, title, description]) => `
          <button class="more-reference-tile" type="button" ${route ? `data-route="${route}"` : 'data-price-unavailable'}>
            <span class="more-reference-icon">${appIcon(icon)}</span>
            <span class="more-reference-title">${title}</span>
            <span class="more-reference-description">${description}</span>
            <svg class="more-reference-chevron" viewBox="0 0 12 20" fill="none" aria-hidden="true"><path d="m3 3 6 7-6 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>`).join('')}
      </div>
    </section>`;
}

function scannerSvg(name) {
  const paths = {
    flash: '<path d="m13 2-8 11h6l-1 9 9-12h-6z"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m21 15-5-5L5 20"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 10v6"/><path d="M12 7h.01"/>',
    check: '<circle cx="12" cy="12" r="9" fill="currentColor" stroke="none"/><path d="m8 12 2.5 2.5L16 9" stroke="#06130b" stroke-width="2.2"/>',
    heart: '<path d="M20.8 4.6a5.4 5.4 0 0 0-7.6 0L12 5.8l-1.2-1.2a5.4 5.4 0 0 0-7.6 7.6l1.2 1.2L12 21l7.6-7.6 1.2-1.2a5.4 5.4 0 0 0 0-7.6z"/>'
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${paths[name] || ''}</svg>`;
}

function priceCheckScreen() {
  return `
    <section class="price-check-screen">
      <div class="price-check-title-row">
        <span class="price-check-title-icon">${appIcon('barcode')}</span>
        <div>
          <h1>Сканування штрих-коду</h1>
          <p>Наведіть камеру на штрих-код товару</p>
        </div>
        <button class="price-check-flash" type="button" data-price-check-flash aria-pressed="false">
          ${scannerSvg('flash')}<span>Спалах</span>
        </button>
      </div>

      <section class="price-check-camera" data-price-check-camera>
        <video data-price-check-video playsinline muted autoplay></video>
        <div class="price-check-camera-fallback" data-price-check-camera-fallback>
          <span>${appIcon('barcode')}</span>
          <b>Відкриваємо камеру…</b>
          <small>Дозвольте доступ до камери, щоб сканувати штрих-код.</small>
        </div>
        <div class="price-check-dim"></div>
        <div class="price-check-frame" aria-hidden="true"><i></i><i></i><i></i><i></i><span></span></div>
        <button class="price-check-manual" type="button" data-price-check-manual>${scannerSvg('image')}<span>Ввести штрих-код вручну</span></button>
      </section>

      <div class="price-check-result-slot" data-price-check-result></div>

      <section class="price-check-tip">
        <span>${scannerSvg('info')}</span>
        <div><b>Порада</b><p>Скануйте чітко та з відстані 10–15 см.<br>Переконайтесь, що штрих-код добре освітлений.</p></div>
      </section>
    </section>`;
}

function formatProductPrice(cents) {
  if (cents === null || cents === undefined || Number(cents) <= 0) return 'Ціну не вказано';
  return `${(Number(cents) / 100).toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} грн`;
}

function stopPriceScanner() {
  const scanner = state.priceScanner;
  if (!scanner) return;
  scanner.active = false;
  try { cancelAnimationFrame(scanner.raf || 0); } catch {}
  try { clearTimeout(scanner.refocusTimer || 0); clearTimeout(scanner.focusIndicatorTimer || 0); } catch {}
  scanner.pendingFocusPoint = null;
  scanner.focusIndicator?.remove();
  try { scanner.stream?.getTracks?.().forEach((track) => track.stop()); } catch {}
  if (scanner.cameraElement && scanner.focusHandler) scanner.cameraElement.removeEventListener('pointerup', scanner.focusHandler);
  document.querySelector('[data-price-camera-dialog]')?.remove();
  document.querySelector('[data-price-focus-panel]')?.remove();
  state.priceScanner = null;
}

function setPriceScannerMessage(message, detail = '') {
  const fallback = document.querySelector('[data-price-check-camera-fallback]');
  if (!fallback) return;
  fallback.classList.add('show');
  fallback.querySelector('b').textContent = message;
  fallback.querySelector('small').textContent = detail || '';
}

function renderPriceCheckResult(data, barcode, debug = null) {
  const slot = document.querySelector('[data-price-check-result]');
  const screen = document.querySelector('.price-check-screen');
  if (!slot) return;
  const product = data?.product;
  const storeName = data?.store?.name || 'Star';
  if (!product) {
    slot.innerHTML = `
      <article class="price-check-product-card not-found">
        <div class="price-check-not-found-icon">${appIcon('barcode')}</div>
        <div class="price-check-not-found-copy"><b>Товар не знайдено</b><p>Штрих-код ${safeHtml(barcode)}</p></div>
        <button type="button" class="price-check-next compact" data-price-check-next>Сканувати ще раз</button>
      </article>`;
    slot.classList.add('visible');
    screen?.classList.add('has-result');
    bindPriceCheckResultActions();
    return;
  }
  const image = product.image_url ? safeHtml(product.image_url) : '/assets/star.svg';
  slot.innerHTML = `
    <article class="price-check-product-card">
      <img class="price-check-product-image" src="${image}" alt="${safeHtml(product.name)}" onerror="this.onerror=null;this.src='/assets/star.svg'">
      <div class="price-check-product-info">
        <div class="price-check-found">${scannerSvg('check')}<span>Товар знайдено</span></div>
        <h2>${safeHtml(product.name)}</h2>
        ${product.category ? `<p class="price-check-category">${safeHtml(product.category)}</p>` : ''}
        ${product.club_price_applied ? `<div class="price-check-club-tag">★ Клубна ціна${product.max_club_qty_per_receipt ? ` · до ${safeHtml(product.max_club_qty_per_receipt)} шт у чеку` : ''}</div>` : ''}
        <div class="price-check-price ${product.price_cents == null || Number(product.price_cents) <= 0 ? 'price-unavailable' : ''}">${formatProductPrice(product.price_cents)}</div>
        ${product.club_price_applied && product.regular_price_cents ? `<div class="price-check-regular"><s>${formatProductPrice(product.regular_price_cents)}</s> · Звичайна ціна 1С</div>` : ''}
        <div class="price-check-store">${appIcon('store')}<span>Ціна у магазині <b>${safeHtml(storeName)}</b></span></div>
      </div>
      <div class="price-check-actions">
        <button type="button" class="price-check-next" data-price-check-next>${appIcon('barcode')}<span>Сканувати наступний</span></button>
      </div>
    </article>`;
  slot.classList.add('visible');
  screen?.classList.add('has-result');
  bindPriceCheckResultActions();
}

function resetPriceCheckScanner() {
  const scanner = state.priceScanner;
  const slot = document.querySelector('[data-price-check-result]');
  if (slot) { slot.innerHTML = ''; slot.classList.remove('visible'); }
  document.querySelector('.price-check-screen')?.classList.remove('has-result');
  if (!scanner) { startPriceScanner(); return; }
  scanner.paused = false;
  scanner.lastValue = '';
  scanner.lastValueAt = 0;
  scanner.candidateValue = '';
  scanner.candidateCount = 0;
  scanner.candidateFirstAt = 0;
}

function bindPriceCheckResultActions() {
  document.querySelectorAll('[data-price-check-next]').forEach((el) => el.onclick = resetPriceCheckScanner);

}

async function lookupProductByBarcode(rawValue) {
  const barcode = String(rawValue || '').trim().replace(/[^0-9A-Za-z]/g, '').toUpperCase();
  if (!barcode) return toast('Введіть штрих-код');
  const scanner = state.priceScanner;
  if (scanner) scanner.paused = true;
  try {
    const data = await api(`/api/client/price-check?barcode=${encodeURIComponent(barcode)}`);
    try { tg?.HapticFeedback?.notificationOccurred?.('success'); } catch {}
    renderPriceCheckResult(data, barcode);
  } catch (error) {
    if (error.code === 'PRODUCT_NOT_FOUND' || error.status === 404) {
      try { tg?.HapticFeedback?.notificationOccurred?.('warning'); } catch {}
      renderPriceCheckResult(null, barcode, error.data?.debug || null);
      return;
    }
    if (scanner) scanner.paused = false;
    toast(error.message);
  }
}

function showManualBarcodeDialog() {
  if (document.querySelector('.price-check-manual-modal')) return;
  const wrap = document.createElement('div');
  wrap.className = 'price-check-manual-modal';
  wrap.innerHTML = `
    <form class="price-check-manual-box">
      <h3>Ввести штрих-код</h3>
      <p>Введіть цифри зі штрих-коду товару.</p>
      <input name="barcode" inputmode="numeric" autocomplete="off" placeholder="Наприклад, 4823065120018" autofocus required>
      <div><button type="button" data-manual-cancel>Скасувати</button><button type="submit">Перевірити</button></div>
    </form>`;
  document.body.appendChild(wrap);
  const input = wrap.querySelector('input');
  setTimeout(() => input?.focus(), 40);
  wrap.querySelector('[data-manual-cancel]').onclick = () => wrap.remove();
  wrap.onclick = (event) => { if (event.target === wrap) wrap.remove(); };
  wrap.querySelector('form').onsubmit = async (event) => {
    event.preventDefault();
    const value = new FormData(event.currentTarget).get('barcode');
    wrap.remove();
    await lookupProductByBarcode(value);
  };
}

async function togglePriceScannerFlash() {
  const scanner = state.priceScanner;
  const button = document.querySelector('[data-price-check-flash]');
  const track = scanner?.stream?.getVideoTracks?.()[0];
  if (!track || !button) return toast('Спалах на цьому пристрої недоступний');
  const capabilities = track.getCapabilities?.() || {};
  if (!capabilities.torch) return toast('Спалах на цьому пристрої недоступний');
  scanner.flash = !scanner.flash;
  try {
    if (isAndroidPriceScanner()) {
      await applyPriceScannerConstraints(scanner, { torch: scanner.flash });
    } else {
      await track.applyConstraints({ advanced: [{ torch: scanner.flash }] });
    }
    button.classList.toggle('active', scanner.flash);
    button.setAttribute('aria-pressed', scanner.flash ? 'true' : 'false');
  } catch {
    scanner.flash = false;
    button.classList.remove('active');
    button.setAttribute('aria-pressed', 'false');
    toast('Не вдалося увімкнути спалах');
  }
}

const PRICE_BARCODE_PATTERNS = (() => {
  const bits = {
    L: ['0001101','0011001','0010011','0111101','0100011','0110001','0101111','0111011','0110111','0001011'],
    G: ['0100111','0110011','0011011','0100001','0011101','0111001','0000101','0010001','0001001','0010111'],
    R: ['1110010','1100110','1101100','1000010','1011100','1001110','1010000','1000100','1001000','1110100']
  };
  const toRuns = (pattern) => {
    const out = [];
    let current = pattern[0];
    let count = 1;
    for (let i = 1; i < pattern.length; i++) {
      if (pattern[i] === current) count++;
      else { out.push(count); current = pattern[i]; count = 1; }
    }
    out.push(count);
    return out;
  };
  return {
    L: bits.L.map(toRuns),
    G: bits.G.map(toRuns),
    R: bits.R.map(toRuns),
    parity: ['LLLLLL','LLGLGG','LLGGLG','LLGGGL','LGLLGG','LGGLLG','LGGGLL','LGLGLG','LGLGGL','LGGLGL']
  };
})();

function barcodeChecksumValid(code) {
  if (!/^\d+$/.test(code) || code.length < 2) return false;
  const digits = [...code].map(Number);
  const check = digits.pop();
  let sum = 0;
  let weight = 3;
  for (let i = digits.length - 1; i >= 0; i--) {
    sum += digits[i] * weight;
    weight = weight === 3 ? 1 : 3;
  }
  return ((10 - (sum % 10)) % 10) === check;
}

function barcodeGuardScore(runs, start, count) {
  if (start < 0 || start + count > runs.length) return Infinity;
  const lengths = runs.slice(start, start + count).map((r) => r.length);
  const total = lengths.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return Infinity;
  const unit = total / count;
  return lengths.reduce((score, length) => score + Math.abs(length / unit - 1), 0);
}

function barcodeDigitMatch(lengths, families) {
  const total = lengths.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return null;
  let best = null;
  for (const family of families) {
    const patterns = PRICE_BARCODE_PATTERNS[family];
    for (let digit = 0; digit <= 9; digit++) {
      const expected = patterns[digit];
      const scale = 7 / total;
      let score = 0;
      for (let i = 0; i < 4; i++) score += Math.abs(lengths[i] * scale - expected[i]);
      if (!best || score < best.score) best = { digit, family, score };
    }
  }
  return best && best.score <= 2.45 ? best : null;
}

function decodeEan13Runs(runs, start) {
  if (start + 59 > runs.length || runs[start]?.color !== 1) return null;
  const startScore = barcodeGuardScore(runs, start, 3);
  const middleScore = barcodeGuardScore(runs, start + 27, 5);
  const endScore = barcodeGuardScore(runs, start + 56, 3);
  if (startScore > 1.45 || middleScore > 2.2 || endScore > 1.45) return null;

  let leftDigits = '';
  let parity = '';
  let score = startScore + middleScore + endScore;
  for (let i = 0; i < 6; i++) {
    const pos = start + 3 + i * 4;
    const match = barcodeDigitMatch(runs.slice(pos, pos + 4).map((r) => r.length), ['L', 'G']);
    if (!match) return null;
    leftDigits += match.digit;
    parity += match.family;
    score += match.score;
  }
  const firstDigit = PRICE_BARCODE_PATTERNS.parity.indexOf(parity);
  if (firstDigit < 0) return null;

  let rightDigits = '';
  for (let i = 0; i < 6; i++) {
    const pos = start + 32 + i * 4;
    const match = barcodeDigitMatch(runs.slice(pos, pos + 4).map((r) => r.length), ['R']);
    if (!match) return null;
    rightDigits += match.digit;
    score += match.score;
  }
  const code = `${firstDigit}${leftDigits}${rightDigits}`;
  if (!barcodeChecksumValid(code)) return null;
  return { code, score };
}

function decodeEan8Runs(runs, start) {
  if (start + 43 > runs.length || runs[start]?.color !== 1) return null;
  const startScore = barcodeGuardScore(runs, start, 3);
  const middleScore = barcodeGuardScore(runs, start + 19, 5);
  const endScore = barcodeGuardScore(runs, start + 40, 3);
  if (startScore > 1.45 || middleScore > 2.2 || endScore > 1.45) return null;

  let code = '';
  let score = startScore + middleScore + endScore;
  for (let i = 0; i < 4; i++) {
    const pos = start + 3 + i * 4;
    const match = barcodeDigitMatch(runs.slice(pos, pos + 4).map((r) => r.length), ['L']);
    if (!match) return null;
    code += match.digit;
    score += match.score;
  }
  for (let i = 0; i < 4; i++) {
    const pos = start + 24 + i * 4;
    const match = barcodeDigitMatch(runs.slice(pos, pos + 4).map((r) => r.length), ['R']);
    if (!match) return null;
    code += match.digit;
    score += match.score;
  }
  if (!barcodeChecksumValid(code)) return null;
  return { code, score };
}

function barcodeRunsFromLuma(luma, threshold, denoise = !isAndroidPriceScanner()) {
  const runs = [];
  let color = luma[0] < threshold ? 1 : 0;
  let length = 1;
  for (let i = 1; i < luma.length; i++) {
    const next = luma[i] < threshold ? 1 : 0;
    if (next === color) length++;
    else { runs.push({ color, length }); color = next; length = 1; }
  }
  runs.push({ color, length });

  // Прибираємо одиночні шумові пікселі, але не чіпаємо реальні вузькі модулі штрих-коду.
  for (let i = 1; i < runs.length - 1; i++) {
    if (denoise && runs[i].length <= 1 && runs[i - 1].color === runs[i + 1].color) {
      runs[i - 1].length += runs[i].length + runs[i + 1].length;
      runs.splice(i, 2);
      i = Math.max(0, i - 2);
    }
  }
  return runs;
}

function decodeRetailBarcodeLuma(luma, denoise = !isAndroidPriceScanner()) {
  if (!luma || luma.length < 120) return null;
  let min = 255, max = 0;
  for (const value of luma) { if (value < min) min = value; if (value > max) max = value; }
  if (max - min < 48) return null;
  const middle = (min + max) / 2;
  const thresholds = [middle, middle - 13, middle + 13];
  let best = null;
  for (const threshold of thresholds) {
    const runs = barcodeRunsFromLuma(luma, threshold, denoise);
    for (let i = 0; i < runs.length; i++) {
      if (runs[i].color !== 1) continue;
      const candidate13 = decodeEan13Runs(runs, i);
      if (candidate13 && (!best || candidate13.score < best.score)) best = candidate13;
      const candidate8 = decodeEan8Runs(runs, i);
      if (candidate8 && (!best || candidate8.score < best.score)) best = candidate8;
    }
  }
  return best?.code || null;
}

function detectRetailBarcodeFallback(video, scanner) {
  if (!video?.videoWidth || !video?.videoHeight) return null;
  scanner.fallbackPass = (scanner.fallbackPass || 0) + 1;
  if (scanner.fallbackPass % 2 === 1) return detectRetailBarcodeFast(video, scanner);
  if (!scanner.canvas) {
    scanner.canvas = document.createElement('canvas');
    scanner.context = scanner.canvas.getContext('2d', { willReadFrequently: true });
  }
  return detectAndroidRetailBarcode(video, scanner);
}

function detectRetailBarcodeFast(video, scanner) {
  if (!video?.videoWidth || !video?.videoHeight) return null;
  if (!scanner.canvas) {
    scanner.canvas = document.createElement('canvas');
    scanner.context = scanner.canvas.getContext('2d', { willReadFrequently: true });
  }
  const maxWidth = 960;
  const width = Math.min(maxWidth, Math.max(480, video.videoWidth));
  const height = Math.max(270, Math.round(width * video.videoHeight / video.videoWidth));
  if (scanner.canvas.width !== width || scanner.canvas.height !== height) {
    scanner.canvas.width = width;
    scanner.canvas.height = height;
  }
  const ctx = scanner.context;
  if (!ctx) return null;
  scanner.decodeFrame = { decoder: 'reference fast EAN', source: { width: video.videoWidth, height: video.videoHeight }, canvas: { width, height }, scale: width / video.videoWidth };
  ctx.drawImage(video, 0, 0, width, height);
  let pixels;
  try { pixels = ctx.getImageData(0, 0, width, height).data; } catch { return null; }

  const rows = [0.5, 0.435, 0.565, 0.37, 0.63, 0.1, 0.25, 0.75, 0.9];
  const slopes = [-0.055, 0, 0.055];
  const left = 0;
  const right = width;
  const luma = new Array(right - left);
  for (const row of rows) {
    for (const slope of slopes) {
      for (let x = left; x < right; x++) {
        const y = Math.max(0, Math.min(height - 1, Math.round(height * row + (x - width / 2) * slope)));
        const index = (y * width + x) * 4;
        luma[x - left] = Math.round(pixels[index] * 0.299 + pixels[index + 1] * 0.587 + pixels[index + 2] * 0.114);
      }
      const code = decodeRetailBarcodeLuma(luma, true) || decodeRetailBarcodeLuma(luma.reverse(), true);
      if (code) return code;
    }
  }
  return null;
}

// Convert object-fit: cover coordinates to source pixels (also used for tap focus).
function priceScannerSourceRect(video, rect) {
  const view = video.getBoundingClientRect();
  if (!view.width || !view.height || !video.videoWidth || !video.videoHeight) return null;
  const scale = Math.max(view.width / video.videoWidth, view.height / video.videoHeight);
  const cropX = (video.videoWidth * scale - view.width) / 2;
  const cropY = (video.videoHeight * scale - view.height) / 2;
  const x = Math.max(0, Math.min(video.videoWidth - 1, (rect.left - view.left + cropX) / scale));
  const y = Math.max(0, Math.min(video.videoHeight - 1, (rect.top - view.top + cropY) / scale));
  return { x: Math.floor(x), y: Math.floor(y),
    width: Math.max(1, Math.min(video.videoWidth - Math.floor(x), Math.ceil(rect.width / scale))),
    height: Math.max(1, Math.min(video.videoHeight - Math.floor(y), Math.ceil(rect.height / scale))) };
}

function detectAndroidRetailBarcode(video, scanner) {
  const ctx = scanner.context;
  if (!ctx) return null;
  // Alternate horizontal/vertical sweeps and interlace their rows. The decorative
  // frame does not crop input; a complete barcode may be anywhere in the video.
  const pass = scanner.fullFramePass = (scanner.fullFramePass || 0) + 1;
  const vertical = pass % 2 === 0;
  const phase = Math.floor((pass - 1) / 2) % 4;
  const width = vertical ? video.videoHeight : video.videoWidth;
  const crossSize = vertical ? video.videoWidth : video.videoHeight;
  const stripHeight = Math.min(crossSize, Math.ceil(width * 0.035) + 4);
  if (scanner.canvas.width !== width) scanner.canvas.width = width;
  if (scanner.canvas.height !== stripHeight) scanner.canvas.height = stripHeight;
  ctx.imageSmoothingEnabled = false;
  const rows = [0.01, ...Array.from({ length: 10 }, (_, i) => Math.min(0.99, (i + 0.25 + phase * 0.25) / 10)), 0.99];
  const slopes = [0, -0.035, 0.035];
  scanner.decodeFrame = { source: { width: video.videoWidth, height: video.videoHeight },
    roi: { x: 0, y: 0, width: video.videoWidth, height: video.videoHeight },
    canvas: { width, height: stripHeight }, scale: 1, direction: vertical ? 'vertical' : 'horizontal',
    decoder: 'full-frame EAN scanlines', phase };
  const hits = new Map();
  for (const row of rows) {
    const top = Math.max(0, Math.min(crossSize - stripHeight, Math.round(crossSize * row - stripHeight / 2)));
    if (vertical) {
      ctx.save();
      ctx.translate(0, stripHeight);
      ctx.rotate(-Math.PI / 2);
      ctx.drawImage(video, top, 0, stripHeight, width, 0, 0, stripHeight, width);
      ctx.restore();
    } else ctx.drawImage(video, 0, top, width, stripHeight, 0, 0, width, stripHeight);
    const pixels = ctx.getImageData(0, 0, width, stripHeight).data;
    for (const slope of slopes) {
      const luma = new Array(width);
      for (let x = 0; x < width; x++) {
        const y = Math.max(0, Math.min(stripHeight - 1, Math.round(stripHeight / 2 + (x - width / 2) * slope)));
        const index = (y * width + x) * 4;
        luma[x] = Math.round(pixels[index] * 0.299 + pixels[index + 1] * 0.587 + pixels[index + 2] * 0.114);
      }
      const code = decodeRetailBarcodeLuma(luma, false) || decodeRetailBarcodeLuma(luma.reverse(), false);
      if (code) {
        const count = (hits.get(code) || 0) + 1;
        hits.set(code, count);
        if (count >= 2) return code;
      }
    }
  }
  return null;
}

// Diagnostics are local and contain no Telegram auth data or camera images.
function priceScannerTrackData(track, method) {
  try { return track?.[method]?.() || {}; } catch (error) { return { error: error.name }; }
}
function priceScannerEvent(scanner, action, data = {}) {
  if (!scanner) return;
  scanner.events = [...(scanner.events || []), { at: new Date().toISOString(), action, ...data }].slice(-40);
}
async function priceScannerDevices(scanner) {
  try {
    scanner.devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput')
      .map((d) => ({ deviceId: d.deviceId, groupId: d.groupId, label: d.label }));
  } catch (error) { priceScannerEvent(scanner, 'enumerateDevices failed', { error: error.name }); }
}
function priceScannerReport() {
  const scanner = state.priceScanner;
  const track = scanner?.stream?.getVideoTracks?.()[0];
  const video = document.querySelector('[data-price-check-video]');
  const capabilities = priceScannerTrackData(track, 'getCapabilities');
  const settings = priceScannerTrackData(track, 'getSettings');
  return { build: 'reference-scanner-v6', timestamp: new Date().toISOString(), userAgent: navigator.userAgent, platform: tg?.platform,
    active: !!scanner?.active, requestedDeviceId: scanner?.requestedDeviceId || 'automatic rear',
    devices: scanner?.devices || [], track: { label: track?.label, readyState: track?.readyState },
    requestedFocus: scanner?.requestedFocus || null,
    capabilities, settings, constraints: priceScannerTrackData(track, 'getConstraints'),
    supportedConstraints: navigator.mediaDevices?.getSupportedConstraints?.() || {},
    autofocus: { continuousAvailable: priceScannerFocusModes(capabilities).continuous, actualMode: settings.focusMode || 'not reported' },
    video: { width: video?.videoWidth, height: video?.videoHeight, readyState: video?.readyState },
    nativeDecoder: scanner?.detector ? 'BarcodeDetector receives video directly' : 'unavailable',
    fallback: scanner?.decodeFrame || null, events: scanner?.events || [],
    physicalModule: 'WebView deviceId/label identifies an exposed device, not necessarily a physical lens. Verify on the phone.' };
}
window.starClubCameraDebug = { report: priceScannerReport, refresh: async () => {
  if (state.priceScanner) await priceScannerDevices(state.priceScanner);
  return priceScannerReport();
} };

async function showPriceCameraSettings() {
  const scanner = state.priceScanner;
  const focusPanel = document.querySelector('[data-price-focus-panel]');
  if (focusPanel) { focusPanel.querySelector('[data-focus-done]')?.click(); if (document.querySelector('[data-price-focus-panel]')) return; }
  if (!scanner || document.querySelector('[data-price-camera-dialog]')) return;
  await priceScannerDevices(scanner);
  if (state.priceScanner !== scanner) return;
  const wasPaused = scanner.paused;
  scanner.paused = true;
  const wrap = document.createElement('div');
  wrap.className = 'price-check-manual-modal';
  wrap.setAttribute('data-price-camera-dialog', '');
  wrap.innerHTML = `<section class="price-check-manual-box" role="dialog" aria-modal="true" aria-label="Камера та діагностика" style="max-height:80vh;overflow:auto;display:grid;gap:8px">
    <h3>Камера та діагностика</h3>
    <p>Виберіть камеру та перевірте різкість. Назви модулів визначає Telegram; основна камера не завжди позначена.</p>
    <select aria-label="Камера" style="width:100%;padding:12px"><option value="">Автоматично: задня камера</option></select>
    <button type="button" data-camera-apply>Застосувати камеру</button>
    <button type="button" data-camera-focus>Налаштувати фокус вручну</button>
    <button type="button" data-camera-copy>Оновити й скопіювати звіт</button>
    <textarea readonly aria-label="Звіт камери" style="width:100%;min-height:160px;font-size:11px"></textarea>
    <button type="button" data-camera-close>Закрити</button></section>`;
  const select = wrap.querySelector('select');
  (scanner.devices || []).forEach((device, index) => {
    if (!device.deviceId) return;
    const option = document.createElement('option');
    option.value = device.deviceId;
    option.textContent = device.label || `Камера ${index + 1}`;
    select.appendChild(option);
  });
  select.value = scanner.requestedDeviceId || priceScannerTrackData(scanner.stream?.getVideoTracks?.()[0], 'getSettings').deviceId || '';
  const output = wrap.querySelector('textarea');
  output.value = JSON.stringify(priceScannerReport(), null, 2);
  const close = () => { wrap.remove(); if (state.priceScanner === scanner) scanner.paused = wasPaused; };
  const focusButton = wrap.querySelector('[data-camera-focus]');
  focusButton.disabled = !priceScannerManualRange(scanner);
  if (focusButton.disabled) focusButton.textContent = 'Ручний фокус недоступний';
  focusButton.onclick = () => { close(); showPriceManualFocus(scanner); };
  wrap.querySelector('[data-camera-close]').onclick = close;
  wrap.onclick = (event) => { if (event.target === wrap) close(); };
  wrap.querySelector('[data-camera-apply]').onclick = () => {
    const deviceId = select.value;
    try { localStorage.setItem('starclub_price_camera_android', deviceId); } catch {}
    close();
    startPriceScanner(deviceId);
  };
  wrap.querySelector('[data-camera-copy]').onclick = async () => {
    await priceScannerDevices(scanner);
    output.value = JSON.stringify(priceScannerReport(), null, 2);
    try { await navigator.clipboard.writeText(output.value); toast('Звіт скопійовано'); }
    catch { output.focus(); output.select(); toast('Виділіть і скопіюйте звіт вручну'); }
  };
  document.body.appendChild(wrap);
}

function priceScannerManualRange(scanner) {
  const caps = priceScannerTrackData(scanner?.stream?.getVideoTracks?.()[0], 'getCapabilities');
  const range = caps.focusDistance;
  if (!caps.focusMode?.includes('manual') || !range || !Number.isFinite(range.min)
    || !Number.isFinite(range.max) || range.max <= range.min) return null;
  return { min: range.min, max: range.max,
    step: Number.isFinite(range.step) && range.step > 0 ? range.step : (range.max - range.min) / 100 };
}

function showPriceManualFocus(scanner) {
  const range = priceScannerManualRange(scanner);
  const camera = document.querySelector('[data-price-check-camera]');
  if (!range || !camera || !scanner.active || state.priceScanner !== scanner) return;
  document.querySelector('[data-price-focus-panel]')?.remove();
  const wasPaused = scanner.paused;
  scanner.paused = true;
  const panel = document.createElement('section');
  panel.setAttribute('data-price-focus-panel', '');
  panel.style.cssText = 'position:absolute;top:58px;left:12px;right:12px;z-index:6;padding:10px;border-radius:12px;background:#111e;color:#fff;display:grid;gap:7px;font-size:13px';
  panel.innerHTML = `<label>Ручний фокус <output></output></label>
    <input type="range" aria-label="Ручний фокус" style="width:100%;min-height:36px">
    <span data-focus-status aria-live="polite">Рухайте повзунок і перевіряйте різкість штрихкоду.</span>
    <div style="display:flex;gap:8px"><button type="button" data-focus-auto style="flex:1;padding:10px">Автофокус</button>
    <button type="button" data-focus-done style="flex:1;padding:10px">Готово</button></div>`;
  const slider = panel.querySelector('input');
  slider.min = range.min; slider.max = range.max; slider.step = range.step;
  const settings = priceScannerTrackData(scanner.stream.getVideoTracks()[0], 'getSettings');
  const initial = scanner.requestedFocus?.focusDistance ?? settings.focusDistance;
  slider.value = Number.isFinite(initial) && initial >= range.min && initial <= range.max ? initial : range.min;
  const status = panel.querySelector('[data-focus-status]');
  const output = panel.querySelector('output');
  output.textContent = Number(slider.value).toFixed(2);
  // Use the device's range without presenting it as a calibrated distance.
  slider.oninput = () => { output.textContent = Number(slider.value).toFixed(2); };
  const apply = async (patch) => {
    slider.disabled = true;
    panel.querySelector('[data-focus-auto]').disabled = true;
    panel.querySelector('[data-focus-done]').disabled = true;
    status.textContent = 'Застосовуємо…';
    clearTimeout(scanner.refocusTimer);
    scanner.manualFocus = patch.focusMode === 'manual';
    try {
      const actual = await applyPriceScannerConstraints(scanner, patch);
      if (!actual) return;
      const modeMatches = actual.focusMode === patch.focusMode;
      const distanceMatches = patch.focusDistance === undefined || (Number.isFinite(actual.focusDistance)
        && Math.abs(actual.focusDistance - patch.focusDistance) <= range.step + 1e-6);
      status.textContent = modeMatches && distanceMatches
        ? (scanner.manualFocus ? 'Ручний режим підтверджено. Перевірте різкість і натисніть «Готово».' : 'Автофокус підтверджено камерою.')
        : 'Камера не підтвердила налаштування. Перевірте зображення та скопіюйте звіт.';
    } catch { status.textContent = 'Не вдалося застосувати фокус. Спробуйте автофокус або перезапустіть камеру.'; }
    finally {
      slider.disabled = false;
      panel.querySelector('[data-focus-auto]').disabled = false;
      panel.querySelector('[data-focus-done]').disabled = false;
    }
  };
  slider.onchange = () => apply({ focusMode: 'manual', focusDistance: Number(slider.value) });
  panel.querySelector('[data-focus-auto]').onclick = () => {
    const modes = priceScannerFocusModes(priceScannerTrackData(scanner.stream?.getVideoTracks?.()[0], 'getCapabilities'));
    if (!modes.continuous && !modes.singleShot) { status.textContent = 'Автофокус не заявлений камерою.'; return; }
    return apply({ focusMode: modes.continuous ? 'continuous' : 'single-shot' });
  };
  panel.querySelector('[data-focus-done]').onclick = () => {
    panel.remove();
    if (state.priceScanner === scanner) scanner.paused = wasPaused;
  };
  // Inputs must not trigger tap-to-focus on the video underneath.
  panel.addEventListener('pointerup', (event) => event.stopPropagation());
  camera.appendChild(panel);
}

function applyPriceScannerConstraints(scanner, patch, options = {}) {
  // Serialize camera settings so a tap, manual focus and torch cannot race.
  const run = async () => {
    const track = scanner.stream?.getVideoTracks?.()[0];
    if (!scanner.active || state.priceScanner !== scanner || !track || track.readyState === 'ended') return;
    if (options.focusVersion !== undefined && options.focusVersion !== scanner.focusTapVersion) return;
    if (scanner.focusPriority && patch.focusMode && options.focusVersion === undefined) return;
    if (scanner.manualFocus && patch.focusMode && patch.focusMode !== 'manual' && options.focusVersion === undefined) return;
    const current = { ...priceScannerTrackData(track, 'getConstraints'), ...scanner.captureConstraints };
    const keys = new Set(Object.keys(patch));
    if (patch.focusMode) ['focusMode', 'focusDistance', 'pointsOfInterest'].forEach((key) => keys.add(key));
    const previousAdvanced = scanner.cameraAdvanced || current.advanced || [];
    const advanced = previousAdvanced.map((item) => Object.fromEntries(Object.entries(item).filter(([key]) => !keys.has(key))))
      .filter((item) => Object.keys(item).length);
    for (const key of keys) delete current[key];
    const constraints = { ...current, advanced: [...advanced, patch] };
    try {
      await track.applyConstraints(constraints);
      scanner.cameraAdvanced = constraints.advanced;
      if (patch.focusMode) scanner.requestedFocus = { ...patch };
      // Immediate settings may still describe the previous camera request.
      if (patch.focusMode) await new Promise((resolve) => setTimeout(resolve, options.settleMs ?? 300));
      if (!scanner.active || state.priceScanner !== scanner || track.readyState === 'ended') return;
      const settings = priceScannerTrackData(track, 'getSettings');
      priceScannerEvent(scanner, 'applyConstraints', { requested: patch, settings,
        focusModeConfirmed: patch.focusMode ? settings.focusMode === patch.focusMode : null });
      return settings;
    } catch (error) {
      priceScannerEvent(scanner, 'applyConstraints failed', { requested: patch, error: error.name, message: error.message });
      throw error;
    }
  };
  const result = (scanner.constraintQueue || Promise.resolve()).catch(() => {}).then(run);
  scanner.constraintQueue = result.catch(() => {});
  return result;
}

async function configureAndroidPriceResolution(scanner) {
  const track = scanner.stream.getVideoTracks()[0];
  for (const request of [
    { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 }, resizeMode: 'none' },
    { width: { ideal: 1920 }, height: { ideal: 1080 } }
  ]) {
    if (!scanner.active || state.priceScanner !== scanner) return;
    try {
      await track.applyConstraints({ ...priceScannerTrackData(track, 'getConstraints'), ...request });
      scanner.captureConstraints = { ...request };
      priceScannerEvent(scanner, 'resolution', { requested: request, settings: priceScannerTrackData(track, 'getSettings') });
      break;
    } catch (error) { priceScannerEvent(scanner, 'resolution failed', { requested: request, error: error.name }); }
  }
}

function scannerDetectionInsideFrame(detection, video) {
  const box = detection?.boundingBox;
  const frame = document.querySelector('.price-check-frame');
  if (!box || !frame || !video?.videoWidth || !video?.videoHeight) return true;
  const videoRect = video.getBoundingClientRect();
  const frameRect = frame.getBoundingClientRect();
  if (!videoRect.width || !videoRect.height) return true;

  // video має object-fit: cover, тому переводимо координати BarcodeDetector у координати екрана.
  const scale = Math.max(videoRect.width / video.videoWidth, videoRect.height / video.videoHeight);
  const renderedWidth = video.videoWidth * scale;
  const renderedHeight = video.videoHeight * scale;
  const cropX = (renderedWidth - videoRect.width) / 2;
  const cropY = (renderedHeight - videoRect.height) / 2;
  const centerX = videoRect.left + (box.x + box.width / 2) * scale - cropX;
  const centerY = videoRect.top + (box.y + box.height / 2) * scale - cropY;
  const inside = centerX >= frameRect.left && centerX <= frameRect.right
    && centerY >= frameRect.top && centerY <= frameRect.bottom;
  if (!inside) return false;

  // Для одновимірного товарного штрих-коду очікуємо витягнуту область, а не блок звичайного тексту.
  const displayWidth = Math.abs(box.width * scale);
  const displayHeight = Math.abs(box.height * scale);
  if (displayWidth > 0 && displayHeight > 0 && Math.max(displayWidth, displayHeight) / Math.min(displayWidth, displayHeight) < 1.25) return false;
  return true;
}

function scannerValueIsPlausible(rawValue, format = '', source = 'native') {
  const value = String(rawValue || '').trim().replace(/\s+/g, '');
  if (!value || value.length > 80) return false;
  if (source === 'fallback') return /^\d{8}$|^\d{13}$/.test(value) && barcodeChecksumValid(value);

  const normalizedFormat = String(format || '').toLowerCase();
  // Нативному BarcodeDetector довіряємо тип формату, але перевіряємо довжину/склад.
  // Контрольну цифру тут навмисно не вимагаємо: у 1С можуть бути внутрішні Code128/вагові коди.
  if (normalizedFormat === 'ean_13') return /^\d{13}$/.test(value);
  if (normalizedFormat === 'ean_8') return /^\d{8}$/.test(value);
  if (normalizedFormat === 'upc_a') return /^\d{12}$/.test(value);
  if (normalizedFormat === 'upc_e') return /^\d{6,8}$/.test(value);
  // Code128/ITF/Code39 можуть бути не лише цифровими — їх приймаємо тільки після повторного підтвердження нижче.
  return ['code_128', 'code_39', 'codabar', 'itf'].includes(normalizedFormat) && /^[0-9A-Z.$/+%\-]+$/i.test(value);
}


function isAndroidPriceScanner() {
  return !isAppleMobile && (tg?.platform === 'android' || /Android/i.test(navigator.userAgent));
}

function priceScannerFocusModes(capabilities = {}) {
  const modes = Array.isArray(capabilities.focusMode) ? capabilities.focusMode : [];
  return {
    continuous: modes.includes('continuous'),
    singleShot: modes.includes('single-shot')
  };
}

async function configurePriceScannerFocus(scanner) {
  if (!scanner?.active) return;
  const track = scanner.stream?.getVideoTracks?.()[0];
  if (!track?.applyConstraints || track.readyState === 'ended') return;
  let capabilities;
  try { capabilities = track.getCapabilities?.() || {}; } catch { return; }
  const modes = priceScannerFocusModes(capabilities);
  if (priceScannerTrackData(track, 'getSettings').focusMode === 'continuous') return;
  const focusMode = modes.continuous ? 'continuous' : modes.singleShot ? 'single-shot' : null;
  if (!focusMode) return;
  try {
    // Continuous autofocus helps both Android and iPhone keep small barcodes sharp
    // while the user changes the distance to the package.
    if (isAndroidPriceScanner()) await applyPriceScannerConstraints(scanner, { focusMode });
    else await track.applyConstraints({ advanced: [{ focusMode }] });
  } catch {
    // Some Telegram/Safari WebViews expose a capability but reject it.
  }
}

function showPriceFocusIndicator(scanner, clientX, clientY) {
  const camera = document.querySelector('[data-price-check-camera]');
  if (!camera) return;
  const rect = camera.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  clearTimeout(scanner.focusIndicatorTimer);
  scanner.focusIndicator?.remove();
  const indicator = document.createElement('span');
  const size = Math.min(72, rect.width, rect.height);
  const x = Math.max(size / 2, Math.min(rect.width - size / 2, clientX - rect.left));
  const y = Math.max(size / 2, Math.min(rect.height - size / 2, clientY - rect.top));
  indicator.setAttribute('aria-hidden', 'true');
  indicator.setAttribute('data-price-focus-indicator', '');
  indicator.style.cssText = `position:absolute;pointer-events:none;z-index:5;width:${size}px;height:${size}px;left:${x - size / 2}px;top:${y - size / 2}px;color:#f6d543;`;
  indicator.innerHTML = '<svg viewBox="0 0 72 72" width="100%" height="100%" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"><rect x="1" y="1" width="70" height="70"/><path d="M36 1v6M36 65v6M1 36h6M65 36h6"/></svg>';
  camera.appendChild(indicator);
  scanner.focusIndicator = indicator;
  const status = document.createElement('span');
  status.style.cssText = 'position:absolute;top:76px;left:-34px;width:140px;text-align:center;font-size:12px;color:#f6d543;text-shadow:0 1px 3px #000;';
  indicator.appendChild(status);
  scanner.focusStatus = status;
  indicator.animate?.([{ transform: 'scale(1.15)' }, { transform: 'scale(1)' }], { duration: 180, easing: 'ease-out' });
  scanner.focusIndicatorTimer = setTimeout(() => indicator.remove(), 12000);
}

function finishPriceFocusIndicator(scanner, message) {
  if (scanner.focusStatus) scanner.focusStatus.textContent = message;
  clearTimeout(scanner.focusIndicatorTimer);
  const indicator = scanner.focusIndicator;
  scanner.focusIndicatorTimer = setTimeout(() => {
    indicator?.remove();
    if (scanner.focusIndicator === indicator) scanner.focusIndicator = null;
  }, 2000);
}

async function restorePriceAutoFocus(scanner, version) {
  if (!scanner.active || state.priceScanner !== scanner || scanner.focusTapVersion !== version) return;
  scanner.manualFocus = false;
  scanner.focusPriority = false;
  const modes = priceScannerFocusModes(priceScannerTrackData(scanner.stream?.getVideoTracks?.()[0], 'getCapabilities'));
  if (modes.continuous) {
    try { await applyPriceScannerConstraints(scanner, { focusMode: 'continuous' }, { focusVersion: version }); } catch {}
  }
}

async function focusPriceScannerAt(clientX, clientY) {
  const scanner = state.priceScanner;
  const video = document.querySelector('[data-price-check-video]');
  const track = scanner?.stream?.getVideoTracks?.()[0];
  if (!scanner?.active || scanner.paused || !video || !track || track.readyState === 'ended') return;
  const source = priceScannerSourceRect(video, { left: clientX, top: clientY, width: 1, height: 1 });
  if (!source) return;
  showPriceFocusIndicator(scanner, clientX, clientY);
  clearTimeout(scanner.refocusTimer);
  scanner.focusTapVersion = (scanner.focusTapVersion || 0) + 1;
  scanner.focusPriority = true;
  scanner.manualFocus = false;
  scanner.pendingFocusPoint = { x: source.x / video.videoWidth, y: source.y / video.videoHeight };
  if (scanner.tapFocusBusy) return;
  scanner.tapFocusBusy = true;
  const alive = () => scanner.active && state.priceScanner === scanner && track.readyState !== 'ended';
  try {
    while (alive() && scanner.pendingFocusPoint) {
      const point = scanner.pendingFocusPoint;
      scanner.pendingFocusPoint = null;
      const version = scanner.focusTapVersion;
      const caps = priceScannerTrackData(track, 'getCapabilities');
      const modes = priceScannerFocusModes(caps);
      const supported = navigator.mediaDevices?.getSupportedConstraints?.() || {};
      const supportsPoint = supported.pointsOfInterest || Object.prototype.hasOwnProperty.call(caps, 'pointsOfInterest');
      if (supportsPoint && track.applyConstraints) {
        try {
          // Keep continuous AF running and update its region in one request.
          // Never sweep focusDistance, reset to infinity, or pause decoding.
          const request = { pointsOfInterest: [point], ...(modes.continuous ? { focusMode: 'continuous' } : {}) };
          await applyPriceScannerConstraints(scanner, request, { focusVersion: version, settleMs: 0 });
          if (!alive() || scanner.focusTapVersion !== version) continue;
          finishPriceFocusIndicator(scanner, '');
          scanner.refocusTimer = setTimeout(() => restorePriceAutoFocus(scanner, version), 8000);
        } catch {
          if (!alive() || scanner.focusTapVersion !== version) continue;
          scanner.focusPriority = false;
          finishPriceFocusIndicator(scanner, 'Лише автофокус');
        }
      } else {
        if (!alive() || scanner.focusTapVersion !== version) continue;
        scanner.focusPriority = false;
        finishPriceFocusIndicator(scanner, 'Лише автофокус');
      }
    }
  } finally { scanner.tapFocusBusy = false; }
}

async function startPriceScanner(selectedDeviceId) {
  const video = document.querySelector('[data-price-check-video]');
  if (!video || state.route !== 'priceCheck') return;
  stopPriceScanner();
  const scanner = {
    active: true, paused: false, flash: false, stream: null, detector: null,
    detecting: false, fallbackDetecting: false, canvas: null, context: null,
    raf: 0, lastFrameAt: 0, lastFallbackAt: 0, lastValue: '', lastValueAt: 0,
    candidateValue: '', candidateCount: 0, candidateFirstAt: 0, refocusTimer: 0
  };
  state.priceScanner = scanner;
  const flashButton = document.querySelector('[data-price-check-flash]');
  flashButton?.classList.remove('active');
  flashButton?.setAttribute('aria-pressed', 'false');

  if (!navigator.mediaDevices?.getUserMedia) {
    setPriceScannerMessage('Камера недоступна', 'На цьому пристрої немає доступу до камери браузера.');
    return;
  }

  // Match the working reference: negotiate 720p once, without a second forced
  // resolution switch after startup. The browser may return another supported size.
  scanner.requestedDeviceId = typeof selectedDeviceId === 'string' ? selectedDeviceId : '';
  const selection = scanner.requestedDeviceId ? { deviceId: { exact: scanner.requestedDeviceId } } : { facingMode: { ideal: 'environment' } };
  const cameraRequests = [
    { video: { ...selection, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
    { video: selection, audio: false }
  ];
  let cameraError = null;
  for (const constraints of cameraRequests) {
    if (!scanner.active || state.priceScanner !== scanner || state.route !== 'priceCheck') return;
    try {
      scanner.stream = await navigator.mediaDevices.getUserMedia(constraints);
      priceScannerEvent(scanner, 'getUserMedia', { requested: constraints, settings: priceScannerTrackData(scanner.stream?.getVideoTracks?.()[0], 'getSettings') });
      if (scanner.stream) break;
    } catch (error) {
      cameraError = error;
      priceScannerEvent(scanner, 'getUserMedia failed', { requested: constraints, error: error.name, message: error.message });
      if (['NotAllowedError', 'SecurityError'].includes(error.name)) break;
    }
  }
  if (!scanner.active || state.priceScanner !== scanner || state.route !== 'priceCheck') {
    scanner.stream?.getTracks().forEach((track) => track.stop());
    return;
  }
  if (!scanner.stream) {
    console.warn('StarClub price scanner camera error', cameraError);
    setPriceScannerMessage('Немає доступу до камери', scanner.requestedDeviceId ? 'Вибрана камера недоступна. Закрийте та знову відкрийте сканер.' : 'Надайте дозвіл на камеру в налаштуваннях Telegram або браузера.');
    return;
  }

  if (!scanner.active || state.route !== 'priceCheck') {
    scanner.stream.getTracks().forEach((track) => track.stop());
    return;
  }
  if (isAndroidPriceScanner()) {
    await priceScannerDevices(scanner);
  }
  if (!scanner.active || state.priceScanner !== scanner) return;
  video.srcObject = scanner.stream;
  video.setAttribute('playsinline', '');
  video.muted = true;
  try { await video.play(); } catch {}
  await configurePriceScannerFocus(scanner);
  const camera = document.querySelector('[data-price-check-camera]');
  if (camera) {
    scanner.cameraElement = camera;
    scanner.focusHandler = (event) => {
      if (event.target.closest('button')) return;
      focusPriceScannerAt(event.clientX, event.clientY);
    };
    camera.addEventListener('pointerup', scanner.focusHandler);
  }
  if (!scanner.active || state.priceScanner !== scanner || state.route !== 'priceCheck') return;
  document.querySelector('[data-price-check-camera-fallback]')?.classList.remove('show');

  // На Android/Chrome використовуємо нативний BarcodeDetector, а на iPhone/Safari/Telegram WebView
  // автоматично переходить на власний EAN-13/EAN-8 сканер через Canvas — без ручного вводу.
  if ('BarcodeDetector' in window) {
    try {
      const wanted = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'codabar', 'itf'];
      const supported = BarcodeDetector.getSupportedFormats ? await BarcodeDetector.getSupportedFormats() : wanted;
      const formats = wanted.filter((item) => supported.includes(item));
      scanner.detector = new BarcodeDetector(formats.length ? { formats } : undefined);
    } catch {
      try { scanner.detector = new BarcodeDetector(); } catch {}
    }
  }

  const acceptValue = async (rawValue, { source = 'native', format = '' } = {}) => {
    const value = String(rawValue || '').trim().replace(/\s+/g, '');
    if (!scanner.active || state.priceScanner !== scanner || !value || scanner.paused || !scannerValueIsPlausible(value, format, source)) return false;
    const now = Date.now();

    // The working reference accepts the first decoded result. Native results
    // are format-validated below; our EAN fallback also verifies the checksum.
    if (value === scanner.lastValue && now - scanner.lastValueAt <= 2200) return false;

    scanner.lastValue = value;
    scanner.lastValueAt = now;
    scanner.candidateValue = '';
    scanner.candidateCount = 0;
    scanner.candidateFirstAt = 0;
    scanner.paused = true;
    await lookupProductByBarcode(value);
    return true;
  };

  const detectLoop = async (timestamp = 0) => {
    if (!scanner.active || state.priceScanner !== scanner || state.route !== 'priceCheck') return;
    if (!scanner.paused && video.readyState >= 2) {
      let found = false;
      if (scanner.detector && !scanner.detecting && timestamp - scanner.lastFrameAt >= 150) {
        scanner.lastFrameAt = timestamp;
        scanner.detecting = true;
        try {
          const codes = await scanner.detector.detect(video);
          const validCodes = (codes || []).filter((code) => scannerValueIsPlausible(code.rawValue, code.format, 'native'));
          const validCode = validCodes.find((code) => String(code.rawValue || '').replace(/\s+/g, '') === scanner.candidateValue) || validCodes[0];
          if (validCode) found = await acceptValue(validCode.rawValue, { source: 'native', format: validCode.format });
        } catch {}
        scanner.detecting = false;
      }
      if (!found && !scanner.fallbackDetecting && timestamp - scanner.lastFallbackAt >= 190) {
        scanner.lastFallbackAt = timestamp;
        scanner.fallbackDetecting = true;
        try {
          const value = detectRetailBarcodeFallback(video, scanner);
          if (value) await acceptValue(value, { source: 'fallback', format: value.length === 13 ? 'ean_13' : 'ean_8' });
        } catch (error) {
          console.warn('StarClub fallback barcode scan error', error);
        }
        scanner.fallbackDetecting = false;
      }
    }
    if (scanner.active && state.priceScanner === scanner) scanner.raf = requestAnimationFrame(detectLoop);
  };
  scanner.raf = requestAnimationFrame(detectLoop);
}

function supportScreen() {
  const tickets = state.data.supportTickets || [];
  return `
    ${header('Підтримка', true)}
    <div class="stack">
      <section class="card gold-border support-intro"><p class="eyebrow">STAR CLUB SUPPORT</p><h3>Ми поруч</h3><p class="small">Опишіть питання, і невдовзі ми дамо вам відповідь.</p></section>
      <form id="supportForm" class="card stack compact-stack">
        <input class="input" name="subject" placeholder="Тема звернення" required>
        <textarea class="input textarea" name="message" placeholder="Опишіть проблему або запитання" required></textarea>
        <button class="btn" type="submit">Створити звернення</button>
      </form>
      <section class="stack">
        ${tickets.length ? tickets.map((t) => `
          <article class="card support-ticket">
            <div class="progress-row"><div><b>#${t.id} · ${t.subject}</b><p class="small">Оновлено ${fmtDate(t.updated_at)} ${fmtTime(t.updated_at)}</p></div><span class="pill">${t.status === 'open' ? 'відкрите' : t.status === 'answered' ? 'є відповідь' : 'закрите'}</span></div>
            <div class="support-thread">${(t.messages || []).map((m) => `<div class="support-message ${m.sender_type}"><b>${m.sender_type === 'client' ? 'Ви' : 'Підтримка'}</b><p>${m.message}</p><span>${fmtTime(m.created_at)}</span></div>`).join('')}</div>
            ${t.status !== 'closed' ? `<form class="supportReplyForm" data-ticket-id="${t.id}"><textarea class="input textarea" name="message" placeholder="Ваша відповідь" required></textarea><button class="btn secondary" type="submit">Надіслати</button></form>` : ''}
          </article>`).join('') : '<div class="empty">Звернень поки немає</div>'}
      </section>
    </div>`;
}

function newsScreen() {
  const news = state.data.news || [];
  return `
    ${header('Новини', true)}
    <div class="stack">
      ${news.map((n) => `
        <section class="card promo-feed-card news-feed-card">
          <div class="promo-feed-card__body">
            <p class="promo-feed-kicker">${safeHtml(n.tag || 'STAR CLUB')}</p>
            <h3>${safeHtml(n.title)}</h3>
            <p class="promo-feed-description">${safeHtml(n.text)}</p>
          </div>
          <div class="promo-feed-card__media"><img src="${safeHtml(n.image_url || '/assets/star.svg')}" alt="${safeHtml(n.title)}" onerror="this.onerror=null;this.src='/assets/star.svg'"></div>
        </section>
      `).join('')}
    </div>
  `;
}

function profileScreen() {
  const c = state.client;
  return `
    ${header('Профіль', true)}
    <div class="stack">
      <section class="card gold-border">
        <b>${c.name || 'Клієнт Star Club'}</b>
        <p class="small">${c.phone || 'Номер не вказано'}</p>
        <div class="progressbar"><span style="width:${c.profile_progress.percent}%"></span></div>
        <p class="small">Заповнено ${c.profile_progress.completed} з ${c.profile_progress.total} полів</p>
      </section>
      <button class="btn" data-route="register">Редагувати профіль</button>
      <button class="btn secondary" data-logout>Вийти з акаунта</button>
    </div>
  `;
}

function showCashierModal(cardNumber) {
  if (document.querySelector('.star-cashier-overlay')) return;
  const clean = String(cardNumber || '').replaceAll(' ', '');
  const displayNumber = safeHtml(String(cardNumber || ''));
  const clientName = safeHtml(state.client?.name || 'Клієнт Star Club');
  const wrap = document.createElement('div');
  wrap.className = 'star-cashier-overlay';
  wrap.innerHTML = `
    <div class="star-cashier-scroll">
      <header class="star-card-heading star-cashier-heading">
        <button class="star-card-back" type="button" data-close-cashier>${appIcon('arrow-left')}<span>Назад</span></button>
        <div class="star-card-heading-copy">
          <h2>Моя карта</h2>
          <p>Ваш Star Club завжди з вами</p>
        </div>
        <span aria-hidden="true"></span>
      </header>

      <section class="star-member-card star-member-card-cashier">
        <img class="star-member-art star-member-art-cashier" src="/assets/design/card/barcode-card-art.png" alt="" aria-hidden="true">
        <div class="star-cashier-brand">
          <div class="star-club-emblem"><span class="star-club-emblem-star">★</span></div>
          <div class="star-club-wordmark">STAR CLUB</div>
        </div>
        <div class="star-cashier-member-copy">
          <div class="star-member-name">${clientName}</div>
          <div class="star-member-number-label">№ картки</div>
          <div class="star-member-number">${displayNumber}</div>
        </div>
        <button class="star-mini-qr" type="button" aria-label="QR код">${appIcon('qr-code')}</button>
      </section>

      <section class="star-barcode-sheet">
        <div class="star-sheet-handle" aria-hidden="true"></div>
        <h2>Штрихкод картки</h2>
        <p>Покажіть цей штрихкод касиру</p>
        <div class="star-barcode-box">
          <img src="/api/svg/barcode?text=${encodeURIComponent(clean)}" alt="Штрихкод картки">
        </div>
        <div class="star-card-number-box">
          <button class="star-copy-button" type="button" data-copy-card="${safeHtml(clean)}" aria-label="Скопіювати номер картки">${appIcon('copy')}</button>
          <div><span>Номер картки</span><strong>${safeHtml(clean)}</strong></div>
          <button class="star-copy-button" type="button" data-copy-card="${safeHtml(clean)}" aria-label="Скопіювати номер картки">${appIcon('copy')}</button>
        </div>
        <button class="star-done-button" type="button" data-close-cashier>Готово</button>
      </section>
    </div>`;

  const savedScrollY = window.scrollY;
  document.body.style.setProperty('--cashier-scroll-top', `${-savedScrollY}px`);
  document.body.classList.add('cashier-open');
  document.documentElement.classList.add('cashier-open');
  document.body.appendChild(wrap);
  const content = wrap.querySelector('.star-cashier-scroll');
  const fitCard = () => {
    const navHeight = $nav.getBoundingClientRect().height;
    wrap.style.bottom = `${navHeight}px`;
    const scale = Math.min(1, wrap.clientHeight / Math.max(1, content.scrollHeight));
    content.style.transform = `scale(${scale})`;
  };
  const resizeObserver = new ResizeObserver(fitCard);
  resizeObserver.observe(wrap);
  resizeObserver.observe(content);
  fitCard();
  const onNavClick = () => close();
  const close = () => {
    $nav.removeEventListener('click', onNavClick, true);
    resizeObserver.disconnect();
    document.body.classList.remove('cashier-open');
    document.documentElement.classList.remove('cashier-open');
    document.body.style.removeProperty('--cashier-scroll-top');
    wrap.remove();
    window.scrollTo(0, savedScrollY);
  };
  wrap.querySelectorAll('[data-close-cashier]').forEach((el) => el.onclick = close);
  wrap.querySelectorAll('[data-copy-card]').forEach((el) => el.onclick = async () => {
    try { await navigator.clipboard.writeText(clean); toast('Номер картки скопійовано'); }
    catch { toast(clean); }
  });
  $nav.addEventListener('click', onNavClick, { once: true, capture: true });
}

function showPersonalCouponModal(button) {
  const code = String(button?.dataset?.showPersonalCoupon || '').trim();
  if (!code) return;
  const expiry = button.dataset.couponExpiry ? new Date(button.dataset.couponExpiry).toLocaleDateString('uk-UA') : '';
  const maxUnits = Math.max(1, Number(button.dataset.couponMaxUnits || 1));
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `<div class="modal personal-coupon-modal personal-coupon-modal-simple">
    <button class="icon-btn compact personal-coupon-close" data-close-modal>×</button>
    <div class="barcode barcode-large"><img src="/api/svg/barcode?text=${encodeURIComponent(code)}" alt="Код персональної знижки"></div>
    <div class="manual-code"><span>Код для касира</span><b>${safeHtml(code)}</b><button type="button" class="mini-copy" data-copy-code="${safeHtml(code)}">Скопіювати</button></div>
    <p class="small coupon-use-note">Код одноразовий${expiry ? ` · діє до ${expiry}` : ''} · максимум ${maxUnits} шт.</p>
    <div class="modal-actions"><button class="btn" type="button" data-close-modal>Готово</button></div>
  </div>`;
  document.body.appendChild(wrap);
  wrap.querySelectorAll('[data-close-modal]').forEach(el=>el.onclick=()=>wrap.remove());
  wrap.querySelector('[data-copy-code]')?.addEventListener('click', async()=>{ try{await navigator.clipboard.writeText(code);toast('Код скопійовано');}catch{toast(code);} });
}

function showRewardModal(qr) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  const manualCode = qr.manual_code || qr.token;
  wrap.innerHTML = `
    <div class="modal">
      <h2>${qr.is_free_stamp_reward ? 'Безкоштовний код' : 'Код товару за зірки'}</h2>
      <p class="small">${qr.reward.name} · ${qr.is_free_stamp_reward ? 'накопичувальна програма' : `${fmtStars(qr.reward.stars_price)} ★`}</p>
      <div class="qrbox"><img src="/api/svg/qr?text=${encodeURIComponent(qr.token)}" alt="QR"></div>
      <div class="manual-code">
        <span>Ручний код для касира</span>
        <b>${manualCode}</b>
        <button type="button" class="mini-copy" data-copy-code="${manualCode}">Скопіювати</button>
      </div>
      <p class="small">Код діє до ${fmtTime(qr.expires_at)} ${fmtDate(qr.expires_at)}. Його можна використати тільки один раз.</p>
      <div class="modal-actions">
        <button class="btn secondary" type="button" data-cancel-reward-code="${manualCode}">Скасувати код</button>
        <button class="btn" type="button" data-close-modal>Готово</button>
      </div>
    </div>
  `;
  document.body.appendChild(wrap);
  wrap.querySelector('[data-close-modal]').onclick = async () => {
    wrap.remove();
    await refreshVisibleData({ forceRender: true });
    await checkClientActivity({ initialize: true });
  };
  wrap.querySelector('[data-copy-code]').onclick = async () => { try { await navigator.clipboard.writeText(manualCode); toast('Код скопійовано'); } catch { toast(manualCode); } };
  wrap.querySelector('[data-cancel-reward-code]').onclick = async () => {
    try {
      await api('/api/client/reward-qr/cancel', { method: 'POST', body: JSON.stringify({ token: manualCode }) });
      toast('Код скасовано, зірки знову доступні');
      wrap.remove();
      await refreshClient();
      await loadRewards();
      await checkClientActivity({ initialize: true });
      if (state.route === 'rewards' || state.route === 'rewardCodes') render();
    } catch (e) { toast(e.message); }
  };
}

let renderRevision = 0;
let moreViewportObserver;
function syncMoreViewport() {
  const navTop = $nav.getBoundingClientRect().top;
  if (!(navTop > 0)) return;
  if (compactDesktopMobile && ['card', 'progress'].includes(state.route)) {
    const screenTop = $app.getBoundingClientRect().top + window.scrollY;
    $app.style.setProperty('--content-above-nav', `${Math.max(0, navTop - screenTop)}px`);
    $app.style.setProperty('--actual-nav-height', `${$nav.getBoundingClientRect().height}px`);
    const card = $app.querySelector('.star-card-screen');
    if (state.route === 'card' && card) {
      const banner = card.querySelector('.star-member-card-main');
      const style = getComputedStyle($app);
      const gap = parseFloat(getComputedStyle(card).rowGap) || 0;
      const rest = [...card.children].filter((child) => child !== banner)
        .reduce((height, child) => height + child.getBoundingClientRect().height, 0);
      const room = navTop - screenTop - rest - gap * (card.children.length - 1)
        - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) - 4;
      $app.style.setProperty('--member-banner-height', `${Math.max(164, Math.min(190, room))}px`);
    }
  }
  if (document.body.classList.contains('more-route')) {
    $app.style.setProperty('--more-content-height', `${navTop}px`);
  }
  if (document.body.classList.contains('priceCheck-route')) {
    $app.style.setProperty('--price-content-height', `${navTop}px`);
  }
}
function commitScreen(html) {
  $app.innerHTML = html;
  renderNav();
  for (const route of ['home', 'offers', 'rewards', 'card', 'more', 'progress', 'priceCheck']) {
    document.body.classList.toggle(`${route}-route`, state.route === route && Boolean(state.client?.registered));
  }
  if (!moreViewportObserver) {
    moreViewportObserver = new ResizeObserver(syncMoreViewport);
    moreViewportObserver.observe($nav);
    window.addEventListener('resize', syncMoreViewport);
    window.visualViewport?.addEventListener('resize', syncMoreViewport);
    tg?.onEvent?.('viewportChanged', syncMoreViewport);
  }
  syncMoreViewport();
  bindEvents();
}
async function render({ reuseLoaded = false } = {}) {
  const revision = ++renderRevision;
  const route = state.route;
  let html;
  if (!state.client?.registered && !['register', 'login', 'telegramPassword', 'privacy'].includes(state.route)) {
    commitScreen(startScreen());
    return;
  }
  try {
    if (route === 'card') html = await cardScreen();
    else if (route === 'rewards') { if (!reuseLoaded) await loadRewards(); html = rewardsScreen(); }
    else if (route === 'offers') { if (!reuseLoaded) await loadOffers(); html = offersScreen(); }
    else if (route === 'progress') { if (!reuseLoaded) await loadProgress(); html = progressScreen(); }
    else if (route === 'history') { if (!reuseLoaded) await loadHistory(); html = historyScreen(); }
    else if (route === 'stores') html = storesScreen();
    else if (route === 'more') html = moreScreen();
    else if (route === 'priceCheck') html = priceCheckScreen();
    else if (route === 'news') { if (!reuseLoaded) await loadNews(); html = newsScreen(); }
    else if (route === 'support') { if (!reuseLoaded) await loadSupport(); html = supportScreen(); }
    else if (route === 'profile') html = profileScreen();
    else if (route === 'rewardCodes') { if (!reuseLoaded) await loadRewardQrs(); html = rewardCodesScreen(); }
    else if (route === 'telegramPassword') html = telegramPasswordScreen();
    else if (route === 'privacy') html = privacyScreen();
    else if (route === 'register') html = registerScreen();
    else if (route === 'login') html = loginScreen();
    else { if (!reuseLoaded) await Promise.all([loadProgress(), loadBanners()]); html = homeScreen(); }
  } catch (e) {
    if (revision !== renderRevision) return;
    if (e.code === 'CLIENT_UNAUTHORIZED' || e.message === 'CLIENT_UNAUTHORIZED') {
      localStorage.removeItem('starclub_session');
      state.token = '';
      state.client = null;
      state.route = 'login';
      localStorage.setItem('starclub_route', 'login');
      html = loginScreen();
    } else {
      html = `<div class="empty">${e.message}</div>`;
    }
  }
  if (revision !== renderRevision) return;
  commitScreen(html);
}

function normalizeClientPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (/^380\d{9}$/.test(digits)) return `+${digits}`;
  if (/^0\d{9}$/.test(digits)) return `+38${digits}`;
  return null;
}

function validateRegisterForm(form) {
  const fd = new FormData(form);
  const phone = normalizeClientPhone(fd.get('phone'));
  if (!phone) return 'Введіть правильний номер телефону у форматі +380XXXXXXXXX або 0XXXXXXXXX';
  if (String(fd.get('name') || '').trim().length < 2) return 'Вкажіть імʼя мінімум з 2 символів';
  if (!fd.get('birth_date')) return 'Вкажіть дату народження';
  if (!fd.get('favorite_store')) return 'Оберіть улюблений магазин';
  const password = String(fd.get('password') || '');
  const confirm = String(fd.get('password_confirm') || '');
  if (!state.client?.password_set || password.length || confirm.length) {
    if (password.length < 6) return 'Пароль має містити мінімум 6 символів';
    if (password !== confirm) return 'Паролі не співпадають';
  }
  if (!fd.has('agree_privacy')) return 'Потрібно погодитися з правилами конфіденційності';
  return null;
}

function bindNotificationEvents() {
  document.querySelectorAll('[data-toggle-notifications]').forEach((el) => el.onclick = (event) => {
    event.stopPropagation();
    state.notificationPanelOpen = !state.notificationPanelOpen;
    render();
  });
  document.querySelectorAll('[data-open-notification]').forEach((el) => el.onclick = (event) => {
    event.stopPropagation();
    ensureNotificationsLoaded();
    const n = state.notifications.find((item) => item.id === el.dataset.openNotification);
    if (!n) return;
    n.read = true;
    saveNotifications();
    state.notificationPanelOpen = false;
    if (n.route) setRoute(n.route);
    else render();
  });
  document.querySelectorAll('[data-clear-notifications]').forEach((el) => el.onclick = (event) => {
    event.stopPropagation();
    state.notifications = [];
    saveNotifications();
    state.notificationPanelOpen = false;
    render();
  });
}

function bindEvents() {
  document.querySelectorAll('[data-price-unavailable]').forEach((el) => el.onclick = () => toast('Функція поки недоступна.'));
  document.querySelectorAll('[data-price-check-back]').forEach((el) => el.onclick = () => setRoute('more'));
  document.querySelectorAll('[data-price-check-manual]').forEach((el) => el.onclick = showManualBarcodeDialog);
  document.querySelectorAll('[data-price-check-flash]').forEach((el) => el.onclick = togglePriceScannerFlash);
  bindPriceCheckResultActions();
  if (state.route === 'priceCheck') startPriceScanner();
  const rewardSearch = document.querySelector('[data-rewards-search]');
  if (rewardSearch) rewardSearch.oninput = () => {
    state.data.rewardSearch = rewardSearch.value;
    const query = rewardSearch.value.trim().toLocaleLowerCase('uk');
    let visibleCount = 0;
    document.querySelectorAll('[data-reward-search-text]').forEach((card) => {
      const matches = card.dataset.rewardSearchText.includes(query);
      card.classList.toggle('hidden', !matches);
      if (matches) visibleCount++;
    });
    document.querySelector('[data-rewards-empty]')?.classList.toggle('hidden', visibleCount > 0);
  }

  bindHomeBannerCarousel();
  bindNotificationEvents();
  document.querySelectorAll('[data-route]').forEach((el) => {
    if ($nav.contains(el)) return;
    el.onclick = (event) => {
      event?.preventDefault?.();
      setRoute(el.dataset.route);
    };
  });
  document.querySelectorAll('[data-back="1"]').forEach((el) => el.onclick = () => setRoute(state.client?.registered ? 'home' : 'start'));
  document.querySelectorAll('[data-offer-tab]').forEach((el) => el.onclick = () => { state.data.offerTab = el.dataset.offerTab; render({ reuseLoaded: true }); });
  document.querySelectorAll('[data-history-filter]').forEach((el) => el.onclick = () => { state.data.historyFilter = el.dataset.historyFilter; render({ reuseLoaded: true }); });
  document.querySelectorAll('[data-logout]').forEach((el) => el.onclick = () => { localStorage.removeItem('starclub_session'); localStorage.removeItem('starclub_route'); location.reload(); });
  document.querySelectorAll('[data-show-cashier]').forEach((el) => el.onclick = () => showCashierModal(el.dataset.cardNumber));
  document.querySelectorAll('[data-close-modal]').forEach((el) => el.onclick = () => el.closest('.modal-backdrop')?.remove());
  document.querySelectorAll('[data-copy-code]').forEach((el) => el.onclick = async () => { try { await navigator.clipboard.writeText(el.dataset.copyCode); toast('Код скопійовано'); } catch { toast(el.dataset.copyCode); } });
  document.querySelectorAll('[data-cancel-reward-code]').forEach((el) => el.onclick = async () => {
    try {
      await api('/api/client/reward-qr/cancel', { method: 'POST', body: JSON.stringify({ token: el.dataset.cancelRewardCode }) });
      toast('Код скасовано, зірки знову доступні');
      el.closest('.modal-backdrop')?.remove();
      await loadRewards();
      const me = await api('/api/client/me');
      state.client = me.client;
      renderNav();
      await checkClientActivity({ initialize: true });
      if (state.route === 'rewards' || state.route === 'rewardCodes') render();
    } catch (e) { toast(e.message); }
  });
  document.querySelectorAll('[data-open-receipt]').forEach((el) => el.onclick = () => showReceiptModal(el.dataset.openReceipt));
  document.querySelectorAll('[data-show-personal-coupon]').forEach((el) => el.onclick = () => showPersonalCouponModal(el));

  const supportForm = document.querySelector('#supportForm');
  if (supportForm) supportForm.onsubmit = async (ev) => {
    ev.preventDefault();
    const fd = new FormData(supportForm);
    try {
      await api('/api/client/support/tickets', { method: 'POST', body: JSON.stringify({ subject: fd.get('subject'), message: fd.get('message') }) });
      toast('Звернення створено');
      await loadSupport();
      render();
    } catch (e) { toast(e.message); }
  };
  document.querySelectorAll('.supportReplyForm').forEach((form) => form.onsubmit = async (ev) => {
    ev.preventDefault();
    const fd = new FormData(form);
    try {
      await api(`/api/client/support/tickets/${form.dataset.ticketId}/messages`, { method: 'POST', body: JSON.stringify({ message: fd.get('message') }) });
      await loadSupport();
      toast('Повідомлення надіслано');
      render();
    } catch (e) { toast(e.message); }
  });

  document.querySelectorAll('[data-open-reward-code]').forEach((el) => el.onclick = async () => {
    const qrs = state.data.rewards?.qrs || state.data.rewardQrs || (await api('/api/client/reward-qrs')).qrs || [];
    const qr = qrs.find((item) => item.token === el.dataset.openRewardCode || item.manual_code === el.dataset.openRewardCode);
    if (qr) showRewardModal(qr);
    else toast('Код не знайдено або вже неактивний');
  });

  document.querySelectorAll('[data-create-reward]').forEach((el) => el.onclick = async () => {
    try {
      el.disabled = true;
      const data = await api(`/api/client/rewards/${el.dataset.createReward}/create-qr`, { method: 'POST', body: '{}' });
      showRewardModal(data.qr);
      syncPersonalQrNotifications(data.qr ? [data.qr] : []);
      await refreshClient();
      await loadRewards();
      await checkClientActivity({ initialize: true });
      if (state.route === 'rewards') render();
    } catch (e) {
      el.disabled = false;
      toast(e.message);
    }
  });

  document.querySelectorAll('[data-auth-telegram]').forEach((el) => el.onclick = async () => {
    try {
      const data = await api('/api/auth/telegram', {
        method: 'POST',
        body: JSON.stringify({
          initData: tg?.initData || '',
          devUser: { id: '111111111', first_name: 'Андрій', last_name: '', phone_number: '+380635594256' }
        })
      });
      state.token = data.session.token;
      localStorage.setItem('starclub_session', state.token);
      state.client = data.client;
      if (!state.client.password_set || data.needs_password) {
        toast('Telegram підтверджено. Створіть пароль.');
        setRoute('telegramPassword');
      } else {
        toast('Вхід через Telegram виконано');
        setRoute(state.client?.registered ? 'home' : 'register');
      }
    } catch (e) {
      toast(e.message);
    }
  });
  const telegramPasswordForm = document.querySelector('#telegramPasswordForm');
  if (telegramPasswordForm) {
    telegramPasswordForm.onsubmit = async (ev) => {
      ev.preventDefault();
      const fd = new FormData(telegramPasswordForm);
      const password = String(fd.get('password') || '');
      const password_confirm = String(fd.get('password_confirm') || '');
      if (password.length < 6) return toast('Пароль має містити мінімум 6 символів');
      if (password !== password_confirm) return toast('Паролі не співпадають');
      try {
        const data = await api('/api/client/set-password', { method: 'POST', body: JSON.stringify({ password, password_confirm }) });
        state.client = data.client;
        toast('Пароль збережено. Завершіть профіль.');
        setRoute(state.client?.registered ? 'home' : 'register');
      } catch (e) { toast(e.message); }
    };
  }

  const loginForm = document.querySelector('#loginForm');
  if (loginForm) {
    loginForm.onsubmit = async (ev) => {
      ev.preventDefault();
      const fd = new FormData(loginForm);
      const phone = normalizeClientPhone(fd.get('phone'));
      const password = String(fd.get('password') || '');
      if (!phone) return toast('Введіть правильний номер телефону');
      if (password.length < 6) return toast('Введіть пароль мінімум 6 символів');
      try {
        const data = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ phone, password }) });
        state.token = data.session.token;
        localStorage.setItem('starclub_session', state.token);
        state.client = data.client;
        toast('Вхід виконано');
        setRoute('home');
      } catch (e) {
        toast(e.code === 'INVALID_CREDENTIALS' || e.message === 'INVALID_CREDENTIALS' ? 'Невірний номер або пароль' : e.message);
      }
    };
  }

  const form = document.querySelector('#registerForm');
  if (form) {
    form.onsubmit = async (ev) => {
      ev.preventDefault();
      const validationError = validateRegisterForm(form);
      if (validationError) {
        toast(validationError);
        return;
      }
      const fd = new FormData(form);
      const body = Object.fromEntries(fd.entries());
      body.phone = normalizeClientPhone(body.phone);
      body.name = String(body.name || '').trim();
      const agreedPrivacy = fd.has('agree_privacy');
      body.agree_rules = agreedPrivacy;
      body.agree_personal_data = agreedPrivacy;
      body.agree_phone_processing = agreedPrivacy;
      body.consent_version = '2026-07-13';
      // Маркетингове налаштування не показуємо під час реєстрації і не змінюємо без окремої дії користувача.
      body.marketing_allowed = state.client?.marketing_allowed !== false;
      try {
        const data = await api('/api/client/register', { method: 'POST', body: JSON.stringify(body) });
        if (data.session?.token) {
          state.token = data.session.token;
          localStorage.setItem('starclub_session', state.token);
        }
        state.client = data.client;
        toast(data.client?.profile_bonus_awarded ? 'Профіль збережено. Бонус активний.' : 'Профіль збережено');
        setRoute('home');
      } catch (e) {
        if (e.message === 'CLIENT_UNAUTHORIZED') {
          toast('Сесія не активна. Увійдіть або відкрийте додаток через Telegram');
          setRoute('login');
        } else {
          toast(e.message);
        }
      }
    };
  }
}



// Делегований обробник не губиться, навіть коли renderNav() перебудовує кнопки.
$nav.addEventListener('click', (event) => {
  const button = event.target.closest('[data-route]');
  if (!button || !$nav.contains(button)) return;
  event.preventDefault();
  event.stopPropagation();
  if (button.disabled) return;
  setRoute(button.dataset.route);
});

function setupMobileKeyboardUX() {
  const editableSelector = 'input, textarea, select';
  document.addEventListener('focusin', (event) => {
    if (!event.target.matches(editableSelector)) return;
    document.body.classList.add('keyboard-open');
    setTimeout(() => event.target.scrollIntoView({ block: 'center', behavior: 'smooth' }), 180);
  });
  document.addEventListener('focusout', () => {
    setTimeout(() => {
      if (!document.activeElement?.matches?.(editableSelector)) document.body.classList.remove('keyboard-open');
    }, 80);
  });
  window.Telegram?.WebApp?.expand?.();
}

setupMobileKeyboardUX();
startLiveRefresh();
bootstrap();
