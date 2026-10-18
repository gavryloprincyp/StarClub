const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const content = $('#content');
const title = $('#title');
const keyInput = $('#apiKey');
const loginOverlay = $('#adminLogin');
const tg = window.Telegram?.WebApp;
try {
  tg?.ready();
  tg?.expand();
  tg?.setHeaderColor?.('#0b0d11');
  tg?.setBackgroundColor?.('#0b0d11');
} catch {}
let tab = 'dashboard';
let admin = null;
let adminToken = localStorage.getItem('starclub_admin_session') || '';
if (keyInput) keyInput.value = localStorage.getItem('starclub_admin_key') || '';
if ($('#mobileApiKey')) $('#mobileApiKey').value = keyInput.value;

function key(){ return localStorage.getItem('starclub_admin_key') || keyInput?.value || ''; }
function showLogin(){ loginOverlay?.classList.remove('hidden'); }
function hideLogin(){ loginOverlay?.classList.add('hidden'); }
async function api(path, options={}){
  const headers={
    'Content-Type':'application/json',
    ...(options.headers||{})
  };
  if(adminToken) headers.Authorization=`Bearer ${adminToken}`;
  else if(key()) headers['x-admin-key']=key();
  const res = await fetch(path,{...options,headers});
  const data = await res.json().catch(()=>({}));
  if(!res.ok||data.ok===false){
    const message=data.message||data.error||'Admin API error';
    const err=new Error(message); err.status=res.status; err.code=data.error;
    console.error('STARCLUB ADMIN API ERROR', {path, status:res.status, data});
    if(options.silentError!==true) alert(`Star Club API: ${res.status}\n${message}`);
    throw err;
  }
  const method=String(options.method||'GET').toUpperCase();
  if(['POST','PATCH'].includes(method) && (path==='/api/admin/catalog/offers' || path==='/api/admin/catalog/pricing/bulk' || path.startsWith('/api/admin/catalog/offers/'))){
    const count=data.pricing_rules_count;
    alert(`Цінове правило збережено.${count!==undefined?`\nПравил у базі: ${count}`:''}`);
  }
  return data;
}

function esc(v){return String(v ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
function num(n){return new Intl.NumberFormat('uk-UA').format(Number(n||0));}
function money(n){return `${num(n)} грн`;}
function dt(s){return s?new Date(s).toLocaleString('uk-UA'):'—';}
function val(form, name){return new FormData(form).get(name);}
function check(form, name){return new FormData(form).has(name);}
function uahToCents(v){return v === '' || v == null ? null : Math.round(Number(v)*100);}
function centsToUah(v){return v ? Number(v)/100 : '';}
function activeText(v){return Number(v) ? 'активний' : 'вимкнений';}
function btn(label, attrs=''){ return `<button type="button" ${attrs}>${label}</button>`; }

const liveState = { signature: '', busy: false, interval: null };
const clientListState = { q: '', sort: 'newest', store_id: 'all', date_from: '', date_to: '' };
let clientDetailState = null;
let offerAdminSection = 'pricing';
function hasFocusedEditor(){ return Boolean(document.activeElement?.matches?.('input,textarea,select,[contenteditable="true"]')); }
function routeCanAutoRefresh(){ return ['dashboard','clients','qrs','support','audit'].includes(tab) || Boolean(clientDetailState?.id); }
function compactClient(c, metric='newest'){
  const metrics = {
    receipt_count: `<span class="client-card-metric"><small>Кількість чеків</small><b>${num(c.receipts_count)} чеків</b></span>`,
    receipt_total: `<span class="client-card-metric"><small>Сума чеків</small><b>${money(c.receipts_total_uah)}</b></span>`,
    average_receipt: `<span class="client-card-metric"><small>Середня сума чека</small><b>${money(c.average_receipt_uah)}</b></span>`
  };
  return `<div class="client-card-main"><div class="client-card-identity"><b>${esc(c.name||'Без імені')}</b><p class="small">${esc(c.phone||'Телефон не вказано')}</p>${metrics[metric]||''}</div><button type="button" data-client="${c.id}">Детально</button></div>`;
}
function receiptItemsHtml(receipt){
  const items = receipt.items || [];
  if(!items.length) return '<div class="small">Товари у цьому чеку не передані з 1С.</div>';
  return `<div class="receipt-items">${items.map(i=>`<div><span>${esc(i.name||i.product_external_id||'Товар')}</span><b>${num(i.qty||1)} × ${num((i.line_total_cents||0)/100)} грн</b></div>`).join('')}</div>`;
}
function receiptCard(r){
  return `<article class="receipt-admin-card"><div class="receipt-head"><div><b>Чек #${esc(r.id)}</b><p class="small">${dt(r.purchased_at)} · ${esc(r.store_id||'магазин не вказано')}</p></div><span class="pill">${num((r.total_cents||0)/100)} грн</span></div>${receiptItemsHtml(r)}<div class="small">Нараховано: ${num(r.stars_accrued||0)} ★</div></article>`;
}
function ledgerRow(l){ return `<tr><td>${dt(l.created_at)}</td><td>${esc(l.description||l.type)}</td><td>${l.amount>0?'+':''}${num(l.amount)} ★</td></tr>`; }
function couponCard(c){ return `<article class="coupon-card" data-coupon-id="${c.id}"><div><b>${esc(c.code)}</b><p class="small">${esc(c.product_name||c.product_external_id||'товар')} · ${num(c.discount_percent)}% · до ${dt(c.expires_at)}</p></div><div class="coupon-actions"><button type="button" data-coupon-banner="${c.id}">${Number(c.show_as_banner)?'Редагувати банер':'Додати в банер'}</button><button type="button" data-delete-coupon="${c.id}">Видалити код</button></div></article>`; }
async function refreshIfChanged(){
  if(liveState.busy || !adminToken && !key() || !routeCanAutoRefresh() || hasFocusedEditor()) return;
  liveState.busy = true;
  try{
    const current = JSON.stringify({tab, detail: clientDetailState?.id || null, q: clientListState.q});
    const probe = await api(tab === 'dashboard' ? '/api/admin/summary' : tab === 'support' ? '/api/admin/support/tickets' : tab === 'qrs' ? '/api/admin/reward-qrs' : tab === 'audit' ? '/api/admin/audit' : clientDetailState?.id ? `/api/admin/clients/${clientDetailState.id}` : `/api/admin/clients?q=${encodeURIComponent(clientListState.q||'')}`);
    const sig = JSON.stringify([current, probe]);
    if(liveState.signature && liveState.signature !== sig) await render();
    liveState.signature = sig;
  } catch {}
  finally { liveState.busy = false; }
}
function startAdminLiveRefresh(){
  if(liveState.interval) clearInterval(liveState.interval);
  liveState.interval = setInterval(refreshIfChanged, 10000);
  document.addEventListener('visibilitychange',()=>{ if(!document.hidden) refreshIfChanged(); });
}

async function adminAction(action, successText='Готово'){
  try { await action(); if(successText) console.info(successText); }
  catch(error){ alert(error.message || 'Не вдалося виконати дію'); throw error; }
}
function scrollAdminFormIntoView(){
  requestAnimationFrame(()=>document.querySelector('.edit-panel, .editor-card')?.scrollIntoView({behavior:'smooth',block:'start'}));
}

async function dashboard(){
  title.textContent='Аналітика';
  const today=new Date().toISOString().slice(0,10);
  const saved=window.__analyticsFilters||{
    date_from:today.slice(0,8)+'01',
    date_to:today,
    balance_mode:'date',
    balance_date:today,
    store_id:'all',
    top_product_sort:'qty',
    top_product_tobacco:'all',
    top_product_alcohol:'all',
    top_product_min_qty:'',
    top_product_min_total:'',
    top_product_min_receipts:'',
    top_product_limit:'5',
    top_product_search:''
  };
  const params=new URLSearchParams(saved);
  const {summary,stores,filters}=await api('/api/admin/summary?'+params.toString());
  const oneCStores=stores.filter(x=>x.source==='1c');
  const storeOptions=['<option value="all">Усі магазини</option>',...oneCStores.map(x=>`<option value="${esc(x.id)}" ${String(filters.store_id)===String(x.id)?'selected':''}>${esc(x.name)}</option>`)].join('');
  const mode=filters.balance_mode||'date';
  const productTypeLabel=(x)=>{
    const labels=[];
    if(Number(x.is_tobacco||0)) labels.push('сигарети');
    if(Number(x.is_alcohol||0)) labels.push('алкоголь');
    return labels.length?`<small>${labels.join(' · ')}</small>`:'';
  };
  content.innerHTML=`
    <form id="analyticsFilters" class="card analytics-filters">
      <label>Магазин<select name="store_id">${storeOptions}</select></label>
      <label>Чеки від<input type="date" name="date_from" value="${esc(filters.date_from)}"></label>
      <label>Чеки до<input type="date" name="date_to" value="${esc(filters.date_to)}"></label>
      <label>Баланс<select name="balance_mode" id="balanceMode"><option value="date" ${mode==='date'?'selected':''}>На конкретну дату</option><option value="all" ${mode==='all'?'selected':''}>За весь час</option></select></label>
      <label data-balance-date>Дата<input type="date" name="balance_date" value="${esc(filters.balance_date||today)}"></label>
      <button class="primary">Застосувати</button>
    </form>

    <div class="grid analytics-grid">
      <div class="card metric"><span>Клієнти</span><b>${num(summary.clients)}</b></div>
      <div class="card metric"><span>Активні клієнти</span><b>${num(summary.active)}</b></div>
      <div class="card metric"><span>Баланс зірок</span><b>${num(summary.stars)} ★</b></div>
      <div class="card metric"><span>Нараховано за покупки</span><b>${num(summary.stars_accrued)} ★</b></div>
      <div class="card metric"><span>Нараховано «з решти»/поповнення</span><b>${num(summary.cash_change_stars)} ★</b></div>
      <div class="card metric"><span>Використано зірок</span><b>${num(summary.stars_spent)} ★</b></div>
      <div class="card metric"><span>Сума чеків</span><b>${money(summary.total_sales_uah)}</b></div>
      <div class="card metric"><span>Середній чек</span><b>${money(summary.average_receipt_uah)}</b></div>
      <div class="card metric"><span>Кількість чеків</span><b>${num(summary.receipts)}</b></div>
      <div class="card metric"><span>Використано QR</span><b>${num(summary.rewards_used)}</b></div>
    </div>

    <div class="analytics-lists">
      <section class="card">
        <h3>Топ магазинів</h3>
        ${summary.top_stores.map(x=>`<div class="analytics-row"><span>${esc(x.name)}</span><b>${num(x.receipts)} чеків · ${money(x.total_uah)}</b></div>`).join('')||'<p class="small">Немає даних</p>'}
      </section>

      <section class="card top-products-panel">
        <div class="top-products-heading">
          <div><h3>Топ товарів</h3><p class="small">Сортування та фільтри застосовуються до вибраного магазину й періоду чеків.</p></div>
        </div>
        <div class="top-products-filters">
          <label>Сортувати за<select name="top_product_sort" form="analyticsFilters"><option value="qty" ${filters.top_product_sort==='qty'?'selected':''}>Кількістю, шт</option><option value="sum" ${filters.top_product_sort==='sum'?'selected':''}>Сумою продажів</option></select></label>
          <label>Сигарети<select name="top_product_tobacco" form="analyticsFilters"><option value="all" ${filters.top_product_tobacco==='all'?'selected':''}>Без фільтра</option><option value="with" ${filters.top_product_tobacco==='with'?'selected':''}>Тільки сигарети</option><option value="without" ${filters.top_product_tobacco==='without'?'selected':''}>Без сигарет</option></select></label>
          <label>Алкоголь<select name="top_product_alcohol" form="analyticsFilters"><option value="all" ${filters.top_product_alcohol==='all'?'selected':''}>Без фільтра</option><option value="with" ${filters.top_product_alcohol==='with'?'selected':''}>Тільки алкоголь</option><option value="without" ${filters.top_product_alcohol==='without'?'selected':''}>Без алкоголю</option></select></label>
          <label>Мін. кількість, шт<input name="top_product_min_qty" form="analyticsFilters" type="number" min="0" step="1" value="${esc(filters.top_product_min_qty||'')}" placeholder="Без фільтра"></label>
          <label>Продажі від, грн<input name="top_product_min_total" form="analyticsFilters" type="number" min="0" step="0.01" value="${esc(filters.top_product_min_total||'')}" placeholder="Без фільтра"></label>
          <label>Мін. чеків<input name="top_product_min_receipts" form="analyticsFilters" type="number" min="0" step="1" value="${esc(filters.top_product_min_receipts||'')}" placeholder="Без фільтра"></label>
          <label>Пошук товару<input name="top_product_search" form="analyticsFilters" value="${esc(filters.top_product_search||'')}" placeholder="Назва або категорія"></label>
          <label>Показувати<select name="top_product_limit" form="analyticsFilters"><option value="5" ${Number(filters.top_product_limit)===5?'selected':''}>5 товарів</option><option value="10" ${Number(filters.top_product_limit)===10?'selected':''}>10 товарів</option><option value="20" ${Number(filters.top_product_limit)===20?'selected':''}>20 товарів</option><option value="50" ${Number(filters.top_product_limit)===50?'selected':''}>50 товарів</option><option value="100" ${Number(filters.top_product_limit)===100?'selected':''}>100 товарів</option></select></label>
          <button type="submit" form="analyticsFilters" class="primary top-products-apply">Застосувати до топу</button>
          <button type="button" id="resetTopProductFilters">Без фільтрів</button>
        </div>
        <div class="top-products-list">
          ${summary.top_products.map((x,index)=>`<div class="analytics-row top-product-row"><span><i>${index+1}</i><span><b>${esc(x.name)}</b>${x.category?`<small>${esc(x.category)}</small>`:''}${productTypeLabel(x)}</span></span><b>${num(x.qty)} шт · ${num(x.receipts_count)} чеків · ${money(x.total_uah)}</b></div>`).join('')||'<p class="small">За вибраними фільтрами товарів немає.</p>'}
        </div>
      </section>
    </div>`;

  const form=$('#analyticsFilters'),modeSelect=$('#balanceMode');
  const toggle=()=>{document.querySelectorAll('[data-balance-date]').forEach(x=>x.hidden=modeSelect.value!=='date');};
  modeSelect.onchange=toggle;
  toggle();
  form.onsubmit=async e=>{e.preventDefault();window.__analyticsFilters=Object.fromEntries(new FormData(e.currentTarget));await dashboard();};
  $('#resetTopProductFilters').onclick=async()=>{
    window.__analyticsFilters={
      ...Object.fromEntries(new FormData(form)),
      top_product_sort:'qty',
      top_product_tobacco:'all',
      top_product_alcohol:'all',
      top_product_min_qty:'',
      top_product_min_total:'',
      top_product_min_receipts:'',
      top_product_limit:'5',
      top_product_search:''
    };
    await dashboard();
  };
}

async function clients(){
  clientDetailState = null;
  title.textContent='Клієнти';
  const state = clientListState;
  const params = new URLSearchParams();
  if(state.q) params.set('q', state.q);
  params.set('sort', state.sort || 'newest');
  if(state.store_id && state.store_id !== 'all') params.set('store_id', state.store_id);
  if(state.date_from) params.set('date_from', state.date_from);
  if(state.date_to) params.set('date_to', state.date_to);
  const data=await api(`/api/admin/clients?${params.toString()}`);
  const clientItems=data.clients||[];
  const filters=data.filters||state;
  const storeOptions=['<option value="all">Усі магазини</option>',...(data.stores||[]).map(store=>`<option value="${esc(store.id)}" ${String(filters.store_id||'all')===String(store.id)?'selected':''}>${esc(store.name)}</option>`)].join('');
  content.innerHTML=`<div class="card client-search-card">
      <form id="clientSearchForm" class="client-search-form client-filter-form">
        <label class="client-filter-search"><span>Пошук</span><input name="q" placeholder="Імʼя, телефон або номер картки" value="${esc(filters.q||'')}"></label>
        <label><span>Сортування</span><select name="sort"><option value="newest" ${filters.sort==='newest'?'selected':''}>Нові клієнти</option><option value="receipt_count" ${filters.sort==='receipt_count'?'selected':''}>Топ за кількістю чеків</option><option value="receipt_total" ${filters.sort==='receipt_total'?'selected':''}>Топ за сумою чеків</option><option value="average_receipt" ${filters.sort==='average_receipt'?'selected':''}>Топ за середньою сумою чека</option></select></label>
        <label><span>Магазин</span><select name="store_id">${storeOptions}</select></label>
        <label><span>Період від</span><input type="date" name="date_from" value="${esc(filters.date_from||'')}"></label>
        <label><span>Період до</span><input type="date" name="date_to" value="${esc(filters.date_to||'')}"></label>
        <button class="primary">Застосувати</button>
        <button type="button" id="clearClientSearch">Скинути</button>
      </form>
    </div>
    <div class="client-list-grid">
      ${clientItems.map(c=>compactClient(c,filters.sort)).join('') || '<div class="card">Клієнтів не знайдено</div>'}
    </div>`;
  $('#clientSearchForm').onsubmit=async e=>{e.preventDefault();const fd=new FormData(e.currentTarget);clientListState.q=String(fd.get('q')||'').trim();clientListState.sort=String(fd.get('sort')||'newest');clientListState.store_id=String(fd.get('store_id')||'all');clientListState.date_from=String(fd.get('date_from')||'');clientListState.date_to=String(fd.get('date_to')||'');await clients();};
  $('#clearClientSearch').onclick=async()=>{Object.assign(clientListState,{q:'',sort:'newest',store_id:'all',date_from:'',date_to:''});await clients();};
  $$('[data-client]').forEach(b=>b.onclick=()=>clientDetails(b.dataset.client));
}
async function clientDetails(id, opts={}){
  const reset = opts.reset !== false;
  const data=await api(`/api/admin/clients/${id}`);
  const c=data.client;
  clientDetailState = {
    id,
    ledger: reset ? data.ledger : (clientDetailState?.ledger || data.ledger),
    receipts: reset ? data.receipts : (clientDetailState?.receipts || data.receipts),
    ledgerTotal: data.counts?.ledger || data.ledger.length,
    receiptTotal: data.counts?.receipts || data.receipts.length
  };
  const topProducts = data.analytics?.top_products || [];
  content.innerHTML=`<div class="card client-profile-card">
    <div class="client-profile-head"><div><h2>${esc(c.name||'Клієнт')} · ${num(c.stars_balance)} ★</h2><p class="small">${esc(c.phone||'')} · картка ${esc(c.card_number)} · профіль ${c.profile_progress?.percent||0}%</p></div><button id="backClients">Назад</button></div>
    <div class="actions"><button id="plus100">+100 ★</button><button id="minus100">-100 ★</button></div>
  </div>
  <div class="card">
    <h3>Аналітика клієнта</h3>
    <p class="small">Топ-3 товари, які цей клієнт купує найчастіше. По кожному можна одразу створити персональний штрих/QR-код на знижку.</p>
    <div class="top-products-grid">${topProducts.map(p=>`<article class="top-product-card"><b>${esc(p.name||p.product_key)}</b><p class="small">${num(p.total_qty)} шт · ${num(p.receipts_count)} чеків · ${num(p.total_uah)} грн</p><form class="couponForm" data-product-id="${esc(p.product_external_id||p.product_key||'')}" data-product-name="${esc(p.name||'')}"><label><span>% знижки</span><input name="discount_percent" type="number" min="1" max="99" value="10"></label><label><span>Строк дії, днів</span><input name="valid_days" type="number" min="1" max="365" value="7"></label><label><span>Максимум одиниць товару</span><input name="max_units" type="number" min="1" max="999" value="1" required></label><button class="primary">Дати знижку</button></form></article>`).join('')||'<div class="muted-box">Покупок ще недостатньо для аналітики.</div>'}</div>
  </div>
  <div class="card"><h3>Персональні коди на знижку</h3><div id="couponList" class="coupon-list">${(data.personal_coupons||[]).map(couponCard).join('')||'<div class="small">Кодів ще немає.</div>'}</div></div>
  <div class="card"><div class="section-head"><h3>Історія зірок</h3><span class="small">Показано <b id="ledgerShown">${clientDetailState.ledger.length}</b> з ${num(clientDetailState.ledgerTotal)}</span></div><table><tbody id="ledgerRows">${clientDetailState.ledger.map(ledgerRow).join('') || '<tr><td colspan="3">Поки немає операцій</td></tr>'}</tbody></table><div class="actions detail-actions"><button id="moreLedger" ${clientDetailState.ledger.length>=clientDetailState.ledgerTotal?'disabled':''}>Детальніше +10</button><button id="hideLedger">Приховати</button></div></div>
  <div class="card"><div class="section-head"><h3>Чеки з товарами</h3><span class="small">Показано <b id="receiptsShown">${clientDetailState.receipts.length}</b> з ${num(clientDetailState.receiptTotal)}</span></div><div id="receiptRows" class="receipt-list">${clientDetailState.receipts.map(receiptCard).join('') || '<div class="small">Поки немає чеків</div>'}</div><div class="actions detail-actions"><button id="moreReceipts" ${clientDetailState.receipts.length>=clientDetailState.receiptTotal?'disabled':''}>Детальніше +10</button><button id="hideReceipts">Приховати</button></div></div>
  <div class="card"><h3>Накопичувальні програми</h3><table><tbody>${(data.progress||[]).map(p=>`<tr><td>${esc(p.name)}</td><td>${num(p.progress)} / ${num(p.required_qty)}</td><td>${num(p.completed_count)} отримано</td></tr>`).join('') || '<tr><td colspan="3">Активних програм немає</td></tr>'}</tbody></table></div>`;
  $('#backClients').onclick=clients;
  $('#plus100').onclick=async()=>{await api(`/api/admin/clients/${id}/adjust-stars`,{method:'POST',body:JSON.stringify({amount:100,description:'Ручне коригування +100 ★'})});clientDetails(id)};
  $('#minus100').onclick=async()=>{await api(`/api/admin/clients/${id}/adjust-stars`,{method:'POST',body:JSON.stringify({amount:-100,description:'Ручне коригування -100 ★'})});clientDetails(id)};
  $('#moreLedger').onclick=async()=>{const d=await api(`/api/admin/clients/${id}/ledger?offset=${clientDetailState.ledger.length}&limit=10`);clientDetailState.ledger.push(...d.items);clientDetailState.ledgerTotal=d.total;$('#ledgerRows').innerHTML=clientDetailState.ledger.map(ledgerRow).join('');$('#ledgerShown').textContent=clientDetailState.ledger.length;$('#moreLedger').disabled=clientDetailState.ledger.length>=clientDetailState.ledgerTotal;};
  $('#hideLedger').onclick=()=>{clientDetailState.ledger=clientDetailState.ledger.slice(0,3);$('#ledgerRows').innerHTML=clientDetailState.ledger.map(ledgerRow).join('');$('#ledgerShown').textContent=clientDetailState.ledger.length;$('#moreLedger').disabled=clientDetailState.ledger.length>=clientDetailState.ledgerTotal;};
  $('#moreReceipts').onclick=async()=>{const d=await api(`/api/admin/clients/${id}/receipts?offset=${clientDetailState.receipts.length}&limit=10`);clientDetailState.receipts.push(...d.receipts);clientDetailState.receiptTotal=d.total;$('#receiptRows').innerHTML=clientDetailState.receipts.map(receiptCard).join('');$('#receiptsShown').textContent=clientDetailState.receipts.length;$('#moreReceipts').disabled=clientDetailState.receipts.length>=clientDetailState.receiptTotal;};
  $('#hideReceipts').onclick=()=>{clientDetailState.receipts=clientDetailState.receipts.slice(0,3);$('#receiptRows').innerHTML=clientDetailState.receipts.map(receiptCard).join('');$('#receiptsShown').textContent=clientDetailState.receipts.length;$('#moreReceipts').disabled=clientDetailState.receipts.length>=clientDetailState.receiptTotal;};
  $$('.couponForm').forEach(form=>form.onsubmit=async e=>{e.preventDefault();const fd=new FormData(form);const coupon=await api(`/api/admin/clients/${id}/personal-coupons`,{method:'POST',body:JSON.stringify({product_external_id:form.dataset.productId,product_name:form.dataset.productName,discount_percent:Number(fd.get('discount_percent')),valid_days:Number(fd.get('valid_days')),max_units:Number(fd.get('max_units'))})});alert(`Код створено: ${coupon.coupon.code}`);clientDetails(id);});
  $$('[data-delete-coupon]').forEach(b=>b.onclick=async()=>{if(confirm('Видалити цей код на знижку?')){await api(`/api/admin/clients/${id}/personal-coupons/${b.dataset.deleteCoupon}`,{method:'DELETE'});clientDetails(id);}});
  $$('[data-coupon-banner]').forEach(b=>b.onclick=()=>{const c=(data.personal_coupons||[]).find(x=>String(x.id)===String(b.dataset.couponBanner));openCouponBannerEditor(id,c,()=>clientDetails(id));});
}

function openCouponBannerEditor(clientId,coupon,onSaved){
  const wrap=document.createElement('div');wrap.className='admin-modal-backdrop';
  const defaultTitle=coupon?.banner_title||`Персональна знижка −${coupon?.discount_percent||10}%`;
  const defaultText=coupon?.banner_text||`На ${coupon?.product_name||'обраний товар'}`;
  const defaultImage=coupon?.banner_image_url||'/assets/star.svg';
  wrap.innerHTML=`<div class="admin-modal coupon-banner-modal"><div class="section-title-row"><div><span class="pill">Персональний банер</span><h2>Налаштувати банер знижки</h2></div><button type="button" data-close-admin-modal>×</button></div><form id="couponBannerEditor" class="form-grid"><label class="admin-field"><span>Заголовок</span><input name="banner_title" value="${esc(defaultTitle)}" required></label><label class="admin-field"><span>Опис</span><textarea name="banner_text">${esc(defaultText)}</textarea></label><label class="admin-field"><span>Фото URL</span><input name="banner_image_url" value="${esc(defaultImage)}"></label><label class="checkline"><input type="checkbox" name="show_as_banner" ${Number(coupon?.show_as_banner)?'checked':'checked'}> Показувати на головній клієнта</label><div class="banner-admin-preview"><img id="couponBannerPreviewImage" src="${esc(previewImageUrl(defaultImage))}" alt=""><div><b id="couponBannerPreviewTitle">${esc(defaultTitle)}</b><p id="couponBannerPreviewText">${esc(defaultText)}</p></div></div><div class="form-actions"><button class="primary">Зберегти</button><button type="button" data-close-admin-modal>Скасувати</button></div></form></div>`;
  document.body.appendChild(wrap);const form=wrap.querySelector('#couponBannerEditor');const refresh=()=>{wrap.querySelector('#couponBannerPreviewTitle').textContent=val(form,'banner_title');wrap.querySelector('#couponBannerPreviewText').textContent=val(form,'banner_text');wrap.querySelector('#couponBannerPreviewImage').src=previewImageUrl(val(form,'banner_image_url'));};['banner_title','banner_text','banner_image_url'].forEach(n=>form.elements[n].addEventListener('input',refresh));wrap.querySelectorAll('[data-close-admin-modal]').forEach(x=>x.onclick=()=>wrap.remove());form.onsubmit=async e=>{e.preventDefault();await api(`/api/admin/clients/${clientId}/personal-coupons/${coupon.id}/banner`,{method:'PATCH',body:JSON.stringify({banner_title:val(form,'banner_title'),banner_text:val(form,'banner_text'),banner_image_url:val(form,'banner_image_url')||'/assets/star.svg',show_as_banner:check(form,'show_as_banner')})});wrap.remove();onSaved?.();};
}

function rewardForm(r={},stores=[]){
  return `<form id="rewardForm" class="form-grid">
    <label class="admin-field"><span>Код товару з 1С</span><input name="product_external_id" placeholder="Наприклад, ЦБ000008264" value="${esc(r.product_external_id||'')}" autocomplete="off"></label>
    <label class="admin-field"><span>Назва товару</span><input name="name" placeholder="Підтягнеться автоматично з 1С" value="${esc(r.name||'')}" required><small id="rewardProductLookupStatus" class="small"></small></label>
    <input name="stars_price" type="number" placeholder="Ціна у зірках" value="${esc(r.stars_price||'')}" required>
    <label class="admin-field"><span>Фото з 1С або власне зображення</span><input name="image_url" placeholder="Підтягнеться з 1С або введіть URL" value="${esc(r.image_url||'')}"></label>
    <label class="admin-field"><span>Завантажити фото з комп’ютера</span><input id="rewardImageFile" type="file" accept="image/jpeg,image/png,image/webp,image/gif"></label>
    <div class="promo-image-preview"><img id="rewardImagePreview" src="${esc(previewImageUrl(r.image_url||'/assets/star.svg'))}" alt="Фото товару"><div><b>Фото товару</b><p class="small">Якщо власного фото немає, використовується фото з номенклатури 1С.</p></div></div>
    <label class="admin-field"><span>Магазин з 1С</span><select name="store_id">${pricingStoreOptions(stores,r.store_id||'all',true)}</select></label>
    <input name="per_client_limit" type="number" placeholder="Ліміт на клієнта" value="${esc(r.per_client_limit||1)}">
    <label class="checkline"><input type="checkbox" name="is_active" ${r.id ? (Number(r.is_active)?'checked':'') : 'checked'}> Активний</label>
    <textarea name="conditions" placeholder="Умови отримання">${esc(r.conditions||'')}</textarea>
    <button>${r.id?'Зберегти':'Додати'}</button>${r.id?'<button type="button" id="cancelEdit">Скасувати</button>':''}
  </form>`;
}

async function rewards(editId=null){
  title.textContent='Товари за зірки';
  const [{items=[]},{stores=[]}]=await Promise.all([api('/api/admin/catalog/rewards'),api('/api/admin/stores')]);
  const oneCStores=stores.filter(x=>x.source==='1c'&&Number(x.is_active));
  const edit=editId?items.find(x=>String(x.id)===String(editId)):null;
  content.innerHTML=`<div class="card"><h3>${edit?'Редагувати товар':'Додати товар за зірки'}</h3>${rewardForm(edit||{},oneCStores)}</div><div class="card"><table><thead><tr><th>Назва</th><th>Зірки</th><th>1С товар</th><th>Магазин</th><th>Статус</th><th>Дії</th></tr></thead><tbody>${items.map(r=>`<tr><td>${esc(r.name)}</td><td>${num(r.stars_price)} ★</td><td>${esc(r.product_external_id||'—')}</td><td>${esc(r.store_id||'all')}</td><td>${activeText(r.is_active)}</td><td class="actions">${btn('Редагувати',`data-edit-reward="${r.id}"`)}${btn('Видалити',`data-delete-reward="${r.id}"`)}</td></tr>`).join('')}</tbody></table></div>`;
  const form=$('#rewardForm');
  $('#rewardImageFile')?.addEventListener('change', async (ev) => {
    try { const dataUrl=await fileToDataUrl(ev.target.files?.[0]);
      if(dataUrl) {form.elements.image_url.value=dataUrl;$('#rewardImagePreview').src=dataUrl;}
    } catch(err) { alert(err.message);ev.target.value=''; }
  });
  form.elements.image_url?.addEventListener('input',()=>{$('#rewardImagePreview').src=previewImageUrl(form.elements.image_url.value);});
  const codeInput=form.elements.product_external_id;
  const nameInput=form.elements.name;
  const storeInput=form.elements.store_id;
  const lookupStatus=$('#rewardProductLookupStatus');
  let lookupTimer=null;
  let lastResolvedCode=normalizeAdminOneCCode(codeInput.value);

  const resolveRewardProductName=async({silent=false}={})=>{
    const code=normalizeAdminOneCCode(codeInput.value);
    if(!code){
      lastResolvedCode='';
      if(lookupStatus) lookupStatus.textContent='Введіть код товару з 1С — назва підтягнеться автоматично.';
      return null;
    }
    if(lookupStatus) lookupStatus.textContent='Шукаємо товар у синхронізації 1С…';
    try{
      const storeId=String(storeInput?.value||'').trim();
      const data=await api(`/api/admin/catalog/products?q=${encodeURIComponent(code)}${storeId&&storeId!=='all'?`&store_id=${encodeURIComponent(storeId)}`:''}`);
      const exact=(data.products||[]).find(product=>normalizeAdminOneCCode(product.external_id)===code);
      if(!exact){
        lastResolvedCode='';
        if(lookupStatus) lookupStatus.textContent='Товар з таким кодом не знайдено. Виконайте синхронізацію номенклатури з 1С.';
        if(!silent) nameInput.value='';
        return null;
      }
      nameInput.value=String(exact.name||'').trim();
      const imageInput=form.elements.image_url;
      if(exact.image_url && (!imageInput.value || imageInput.value==='/assets/star.svg')) {
        imageInput.value=exact.image_url;
        const preview=$('#rewardImagePreview'); if(preview)preview.src=previewImageUrl(exact.image_url);
      }
      lastResolvedCode=code;
      if(lookupStatus) lookupStatus.textContent=`Знайдено в 1С: ${exact.name||code}`;
      return exact;
    }catch(error){
      lastResolvedCode='';
      if(lookupStatus) lookupStatus.textContent='Не вдалося отримати назву товару з 1С.';
      if(!silent) throw error;
      return null;
    }
  };

  const scheduleRewardProductLookup=()=>{
    clearTimeout(lookupTimer);
    lookupTimer=setTimeout(()=>resolveRewardProductName({silent:true}),350);
  };
  codeInput.addEventListener('input',scheduleRewardProductLookup);
  codeInput.addEventListener('change',()=>resolveRewardProductName({silent:true}));
  storeInput?.addEventListener('change',()=>resolveRewardProductName({silent:true}));
  if(codeInput.value) resolveRewardProductName({silent:true});

  form.onsubmit=async ev=>{
    ev.preventDefault();
    const code=normalizeAdminOneCCode(codeInput.value);
    if(code&&lastResolvedCode!==code){
      const product=await resolveRewardProductName();
      if(!product){
        alert('Товар із таким кодом не знайдено у синхронізованій номенклатурі 1С.');
        codeInput.focus();
        return;
      }
    }
    const body={name:val(form,'name'),stars_price:Number(val(form,'stars_price')),product_external_id:code,image_url:val(form,'image_url')||'/assets/star.svg',store_id:val(form,'store_id')||'all',per_client_limit:Number(val(form,'per_client_limit')||1),conditions:val(form,'conditions'),is_active:check(form,'is_active')};
    await api(edit?`/api/admin/catalog/rewards/${edit.id}`:'/api/admin/catalog/rewards',{method:edit?'PATCH':'POST',body:JSON.stringify(body)});
    rewards();
  };
  $('#cancelEdit')?.addEventListener('click',()=>rewards());$$('[data-edit-reward]').forEach(b=>b.onclick=()=>rewards(b.dataset.editReward));$$('[data-delete-reward]').forEach(b=>b.onclick=async()=>{if(confirm('Видалити товар за зірки?')){await api(`/api/admin/catalog/rewards/${b.dataset.deleteReward}`,{method:'DELETE'});rewards();}});
}

async function stores(editId=null){
  title.textContent='Магазини';
  const {stores: storeItems}=await api('/api/admin/stores');
  const hasOneCStores=storeItems.some(store=>store.source==='1c');
  const visibleStores=hasOneCStores?storeItems.filter(store=>store.source==='1c'):storeItems.filter(store=>store.source!=='seed');
  const edit=editId?visibleStores.find(x=>String(x.id)===String(editId)):null;
  content.innerHTML=`
    <div class="card store-sync-intro">
      <div><span class="pill">Синхронізація 1С</span><h3>Магазини завантажуються автоматично</h3><p class="small">Код і назва надходять із 1С разом із номенклатурою. Тут можна дописати адресу, телефон, графік і фото — ці поля синхронізація не стирає.</p></div>
      <strong>${visibleStores.length} магазинів</strong>
    </div>
    ${edit?`<div class="card editor-card edit-panel">
      <div class="section-title-row"><div><h3>Редагувати магазин</h3><p class="small">Код 1С змінювати не можна. Назва оновлюється наступною синхронізацією.</p></div><span class="pill">${edit.source==='1c'?'1С':'ручний'}</span></div>
      <form id="storeForm" class="form-grid">
        <label class="admin-field"><span>Код магазину 1С</span><input name="id" value="${esc(edit.external_id||edit.id)}" readonly required></label>
        <label class="admin-field"><span>Назва з 1С</span><input name="name" value="${esc(edit.name||'')}" ${edit.source==='1c'?'readonly':''} required></label>
        <label class="admin-field"><span>Адреса</span><input name="address" value="${esc(edit.address||'')}" placeholder="вул. Центральна, 10"></label>
        <label class="admin-field"><span>Графік роботи</span><input name="work_hours" value="${esc(edit.work_hours||'')}" placeholder="08:00–22:00"></label>
        <label class="admin-field"><span>Телефон</span><input name="phone" value="${esc(edit.phone||'')}" placeholder="+380..."></label>
        <label class="admin-field"><span>Фото URL</span><input name="image_url" value="${esc(edit.image_url||'/assets/star.svg')}" placeholder="/assets/star.svg або https://..."></label>
        <label class="checkline"><input type="checkbox" name="is_active" ${Number(edit.is_active)?'checked':''}> Показувати магазин у реєстрації та застосунку</label>
        <div class="form-actions"><button class="primary">Зберегти інформацію</button><button type="button" id="cancelStoreEdit">Скасувати</button></div>
      </form>
    </div>`:''}
    <div class="store-admin-grid ${edit?'hide-while-editing':''}">
      ${visibleStores.map(store=>`<article class="card store-admin-card">
        <div class="store-admin-head">
          <div><span class="pill">${store.source==='1c'?'1С':'ручний'} · ${store.is_active?'активний':'вимкнений'}</span><h3>${esc(store.name)}</h3><p class="small">Код: ${esc(store.external_id||store.id)}</p></div>
          <img src="${esc(store.image_url||'/assets/star.svg')}" alt="" onerror="this.src='/assets/star.svg'">
        </div>
        <dl>
          <div><dt>Адреса</dt><dd>${esc(store.address||'—')}</dd></div>
          <div><dt>Графік</dt><dd>${esc(store.work_hours||'—')}</dd></div>
          <div><dt>Телефон</dt><dd>${esc(store.phone||'—')}</dd></div>
        </dl>
        <div class="actions">${btn('Доповнити інформацію',`data-edit-store="${store.id}"`)}${btn(store.is_active?'Вимкнути':'Увімкнути',`data-toggle-store="${store.id}" data-next-active="${store.is_active?'0':'1'}"`)}</div>
      </article>`).join('')||'<div class="card">Магазини ще не надійшли з 1С. Запустіть синхронізацію номенклатури.</div>'}
    </div>`;
  const form=$('#storeForm');
  if(form)form.onsubmit=async ev=>{
    ev.preventDefault();
    const body={name:val(form,'name'),address:val(form,'address'),work_hours:val(form,'work_hours'),phone:val(form,'phone'),image_url:val(form,'image_url')||'/assets/star.svg',is_active:check(form,'is_active')};
    await api(`/api/admin/stores/${encodeURIComponent(edit.id)}`,{method:'PATCH',body:JSON.stringify(body)});
    stores();
  };
  $('#cancelStoreEdit')?.addEventListener('click',()=>stores());
  $$('[data-edit-store]').forEach(b=>b.onclick=async()=>{await stores(b.dataset.editStore);scrollAdminFormIntoView();});
  $$('[data-toggle-store]').forEach(b=>b.onclick=async()=>{await api(`/api/admin/stores/${encodeURIComponent(b.dataset.toggleStore)}`,{method:'PATCH',body:JSON.stringify({is_active:b.dataset.nextActive==='1'})});stores();});
}

function normalizeAdminOneCCode(value){
  return String(value||'').normalize('NFKC').trim().toUpperCase().replace(/\s+/g,'');
}
function previewImageUrl(value){
  const raw=String(value||'').trim();
  if(!raw)return '/assets/star.svg';
  if(raw.startsWith('/'))return raw;
  try{
    const url=new URL(raw);
    if(url.hostname==='drive.google.com'){
      const match=url.pathname.match(/\/file\/d\/([^/]+)/);
      const id=match?.[1]||url.searchParams.get('id');
      if(id)return `https://drive.google.com/thumbnail?id=${encodeURIComponent(id)}&sz=w1600`;
    }
    if(url.hostname.endsWith('dropbox.com')){url.searchParams.delete('dl');url.searchParams.set('raw','1');return url.toString();}
    return url.toString();
  }catch{return '/assets/star.svg';}
}

async function fileToDataUrl(file){
  if(!file)return '';
  if(!/^image\/(png|jpeg|webp|gif)$/i.test(file.type))throw new Error('Виберіть PNG, JPG, WEBP або GIF');
  if(file.size>15*1024*1024)throw new Error('Фото має бути не більше 15 МБ');
  const readOriginal=()=>new Promise((resolve,reject)=>{
    const reader=new FileReader();reader.onload=()=>resolve(String(reader.result||''));
    reader.onerror=()=>reject(new Error('Не вдалося прочитати фото'));
    reader.readAsDataURL(file);
  });
  if(file.size<1_050_000)return readOriginal();
  // Convert large local photos to a compact persistent image, not an object URL.
  const bitmap=await createImageBitmap(file).catch(()=>null);
  if(!bitmap)throw new Error('Не вдалося прочитати зображення');
  const scale=Math.min(1,1400/Math.max(bitmap.width,bitmap.height));
  const canvas=document.createElement('canvas');
  canvas.width=Math.max(1,Math.round(bitmap.width*scale));
  canvas.height=Math.max(1,Math.round(bitmap.height*scale));
  const ctx=canvas.getContext('2d');
  if(!ctx)throw new Error('Обробка фото недоступна у браузері');
  ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
  bitmap.close?.();
  for(const quality of [0.87,0.74,0.6,0.45]){
    const encoded=canvas.toDataURL('image/jpeg',quality);
    if(encoded.length<1_400_000)return encoded;
  }
  throw new Error('Не вдалося стиснути фото. Виберіть менше зображення');
}
function roundPreviewCents(value,mode='kopeck'){
  const cents=Math.max(0,Number(value||0));
  if(mode==='10kop')return Math.round(cents/10)*10;
  if(mode==='50kop')return Math.round(cents/50)*50;
  if(mode==='1uah')return Math.round(cents/100)*100;
  if(mode==='down_1uah')return Math.floor(cents/100)*100;
  return Math.round(cents);
}
function calculatePreviewPrice(baseCents,mode,value,rounding='kopeck'){
  const base=Math.max(0,Number(baseCents||0));
  const n=Number(value||0);
  let result=base;
  if(mode==='percent')result=base*(1-n/100);
  else if(mode==='amount')result=base-n*100;
  else if(mode==='fixed')result=n*100;
  return roundPreviewCents(Math.max(0,Math.min(base,result)),rounding);
}

function offerAdminTabs(){
  return `<div class="offer-admin-tabs">
    <button type="button" data-offer-section="pricing" class="${offerAdminSection==='pricing'?'active':''}">Цінові правила і вітрина</button>
    <button type="button" data-offer-section="multiplier" class="${offerAdminSection==='multiplier'?'active':''}">Множник зірок</button>
  </div>`;
}
function bindOfferAdminTabs(){
  $$('[data-offer-section]').forEach(btn=>btn.onclick=()=>offers(null,btn.dataset.offerSection));
}

function promoOfferForm(o={},stores=[]){
  return `<form id="promoOfferForm" class="form-grid promo-offer-editor">
    <label class="admin-field"><span>Тип картки</span><select name="type"><option value="club" ${o.type==='club'||!o.type?'selected':''}>Клубна пропозиція</option><option value="wholesale" ${o.type==='wholesale'?'selected':''}>Оптова пропозиція</option></select></label>
    <label class="admin-field"><span>Назва</span><input name="name" value="${esc(o.name||'')}" placeholder="Наприклад: Яйця за клубною ціною" required></label>
    <label class="admin-field promo-description-field"><span>Опис</span><textarea name="description" placeholder="Короткий рекламний опис">${esc(o.description||'')}</textarea></label>
    <label class="admin-field"><span>Нова ціна, грн</span><input name="current_price_uah" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(centsToUah(o.current_price_cents))}" placeholder="45.90" required></label>
    <label class="admin-field"><span>Стара ціна, грн</span><input name="old_price_uah" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(centsToUah(o.old_price_cents))}" placeholder="53.00"></label>
    <label class="admin-field"><span>Плашка</span><input name="badge" value="${esc(o.badge||'')}" placeholder="КЛУБНА ЦІНА"></label>
    <label class="admin-field promo-image-field"><span>Картинка: локальна або URL</span><input id="promoImageUrl" name="image_url" value="${esc(o.image_url||'/assets/star.svg')}" placeholder="/assets/item.jpg або https://... або Google Drive"></label>
    <div class="promo-image-preview"><img id="promoImagePreview" src="${esc(previewImageUrl(o.image_url||'/assets/star.svg'))}" alt="Попередній перегляд"><div><b>Попередній перегляд</b><p class="small">Підтримуються локальні шляхи, прямі HTTPS-посилання, Google Drive та Dropbox.</p></div></div>
    <label class="admin-field"><span>Магазини з 1С</span><select name="store_id">${pricingStoreOptions(stores,o.store_id||'all',true)}</select></label>
    <label class="checkline"><input type="checkbox" name="is_active" ${o.id?(Number(o.is_active)?'checked':''):'checked'}> Активна</label>
    <div class="form-actions"><button class="primary">${o.id?'Зберегти':'Створити картку'}</button>${o.id?'<button type="button" id="cancelPromoEdit">Скасувати</button>':''}</div>
  </form>`;
}
async function promoOffers(editId=null){
  offerAdminSection='promo';
  title.textContent='Пропозиції та ціни';
  const [{items=[]},{stores=[]}]=await Promise.all([api('/api/admin/catalog/promo-offers'),api('/api/admin/stores')]);
  const edit=editId?items.find(x=>String(x.id)===String(editId)):null;
  content.innerHTML=`${offerAdminTabs()}
    <div class="card editor-card ${edit?'edit-panel':''}"><div class="section-title-row"><div><h3>${edit?'Редагувати рекламну картку':'Створити статичну пропозицію'}</h3><p class="small">Це лише вітрина в Mini App. Вона не змінює ціну в 1С.</p></div><span class="pill">Реклама</span></div>${promoOfferForm(edit||{},stores)}</div>
    <div class="promo-admin-grid">${items.map(o=>`<article class="promo-admin-card"><img src="${esc(previewImageUrl(o.image_url))}" alt="${esc(o.name)}"><div class="promo-admin-card-body"><div class="offer-card-head"><div><span class="pill">${o.type==='wholesale'?'Оптова':'Клубна'}</span><h3>${esc(o.name)}</h3></div><span>${activeText(o.is_active)}</span></div><p class="small">${esc(o.description||'')}</p><div class="promo-price-line"><b>${num((o.current_price_cents||0)/100)} грн</b>${o.old_price_cents?`<s>${num(o.old_price_cents/100)} грн</s>`:''}</div><div class="actions">${btn('Редагувати',`data-edit-promo="${o.id}"`)}${btn('Видалити',`data-delete-promo="${o.id}" class="danger"`)}</div></div></article>`).join('')||'<div class="card">Статичних пропозицій поки немає</div>'}</div>`;
  bindOfferAdminTabs();
  const form=$('#promoOfferForm');
  const imageInput=$('#promoImageUrl');
  imageInput?.addEventListener('input',()=>{$('#promoImagePreview').src=previewImageUrl(imageInput.value);});
  form.onsubmit=async ev=>{
    ev.preventDefault();
    const body={type:val(form,'type'),name:val(form,'name'),description:val(form,'description'),current_price_cents:uahToCents(val(form,'current_price_uah')),old_price_cents:uahToCents(val(form,'old_price_uah')),badge:val(form,'badge'),image_url:val(form,'image_url')||'/assets/star.svg',store_id:val(form,'store_id')||'all',is_active:check(form,'is_active')};
    await api(edit?`/api/admin/catalog/promo-offers/${edit.id}`:'/api/admin/catalog/promo-offers',{method:edit?'PATCH':'POST',body:JSON.stringify(body)});
    await promoOffers();
  };
  $('#cancelPromoEdit')?.addEventListener('click',()=>promoOffers());
  $$('[data-edit-promo]').forEach(b=>b.onclick=async()=>{await promoOffers(b.dataset.editPromo);scrollAdminFormIntoView();});
  $$('[data-delete-promo]').forEach(b=>b.onclick=async()=>{if(confirm('Видалити рекламну картку?')){await api(`/api/admin/catalog/promo-offers/${b.dataset.deletePromo}`,{method:'DELETE'});await promoOffers();}});
}

function offerPriceText(mode,value){
  if(mode==='percent')return `−${num(value)}%`;
  if(mode==='amount')return `−${num(Number(value||0)/100)} грн`;
  if(mode==='fixed')return `${num(Number(value||0)/100)} грн`;
  return '—';
}
function offerCondition(o){
  if(o.type==='wholesale'){
    const tiers=Array.isArray(o.tiers)?o.tiers:(()=>{try{return o.tiers_json?JSON.parse(o.tiers_json):[]}catch{return []}})();
    return tiers.map(t=>{const mode=t.mode||'fixed';const value=t.value??t.price??0;const txt=mode==='percent'?`−${num(value)}%`:mode==='amount'?`−${num(value)} грн`:`${num(value)} грн/шт`;return `від ${t.qty} шт — ${txt}`;}).join('; ')||'—';
  }
  if(o.type==='stars_multiplier'&&o.stars_multiplier)return `x${o.stars_multiplier} зірок`;
  if(o.type==='club'){
    if(o.price_mode)return offerPriceText(o.price_mode,o.price_value);
    if(o.club_price_cents!==null&&o.club_price_cents!==undefined)return `${num(o.club_price_cents/100)} грн`;
  }
  return '—';
}
function offerStoredPriceValue(o={}){
  if(!o.price_mode)return o.club_price_cents!==null&&o.club_price_cents!==undefined?Number(o.club_price_cents)/100:'';
  if(o.price_mode==='percent')return o.price_value??'';
  return o.price_value===null||o.price_value===undefined?'':Number(o.price_value)/100;
}
function wholesaleTierRows(tiers=[]){
  const normalized=(tiers.length?tiers:[{qty:'',mode:'fixed',value:''}]);
  return normalized.map(t=>{const mode=t.mode||'fixed';const value=t.value??t.price??'';return `<div class="tier-row pricing-tier-row" data-tier-row>
    <label class="admin-field"><span>Від кількості, шт</span><input data-tier-qty type="number" min="1" step="1" inputmode="numeric" value="${esc(t.qty??'')}"></label>
    <label class="admin-field"><span>Тип</span><select data-tier-mode><option value="fixed" ${mode==='fixed'?'selected':''}>Фіксована ціна</option><option value="percent" ${mode==='percent'?'selected':''}>Знижка %</option><option value="amount" ${mode==='amount'?'selected':''}>Знижка грн</option></select></label>
    <label class="admin-field"><span>Значення</span><input data-tier-value type="number" min="0" step="0.01" inputmode="decimal" value="${esc(value)}"></label>
    <button type="button" class="tier-remove" data-remove-tier>Видалити</button>
  </div>`;}).join('');
}
function overrideRows(){
  return `<div class="pricing-override-row" data-override-row>
    <label class="admin-field"><span>Код товару 1С</span><input data-override-product placeholder="ЦБ000004323"></label>
    <label class="admin-field"><span>Назва (необовʼязково)</span><input data-override-name placeholder="Назва товару"></label>
    <label class="admin-field"><span>Тип</span><select data-override-mode><option value="percent">Знижка %</option><option value="amount">Знижка грн</option><option value="fixed">Фіксована ціна</option></select></label>
    <label class="admin-field"><span>Значення</span><input data-override-value type="number" min="0" step="0.01" inputmode="decimal"></label>
    <button type="button" class="tier-remove" data-remove-override>Видалити</button>
  </div>`;
}
function pricingStoreOptions(stores=[],selected='',includeAll=false){
  const activeAll=stores.filter(s=>Number(s.is_active)!==0&&s.source!=='seed');
  const synced=activeAll.filter(s=>s.source==='1c');
  const active=synced.length?synced:activeAll;
  if(!active.length)return `${includeAll?'<option value="all">Усі магазини</option>':''}<option value="" disabled>Немає магазинів — запустіть синхронізацію в 1С</option>`;
  return `${includeAll?`<option value="all" ${!selected||String(selected)==='all'?'selected':''}>Усі магазини</option>`:''}${active.map(s=>`<option value="${esc(s.id)}" ${String(s.id)===String(selected)?'selected':''}>${esc(s.name)} · код ${esc(s.external_id||s.id)}${s.source==='1c'?' · 1С':''}</option>`).join('')}`;
}
function pricingEffectiveOld(o={}){
  if(Number(o.use_manual_old_price)&&o.manual_old_price_cents!==null&&o.manual_old_price_cents!==undefined)return Number(o.manual_old_price_cents);
  return o.calculated_old_price_cents??o.old_price_cents??null;
}
function pricingEffectiveNew(o={}){
  if(Number(o.use_manual_new_price)&&o.manual_new_price_cents!==null&&o.manual_new_price_cents!==undefined)return Number(o.manual_new_price_cents);
  return o.calculated_new_price_cents??null;
}
function pricingRuleForm(o={},stores=[]){
  let tiers=[];try{tiers=Array.isArray(o.tiers)?o.tiers:(o.tiers_json?JSON.parse(o.tiers_json):[])}catch{}
  const targetType=o.target_type||(o.product_external_id?'product':o.category?'group':'product');
  const targetValue=o.target_value||o.product_external_id||o.category||'';
  const priceMode=o.price_mode||(o.club_price_cents!==null&&o.club_price_cents!==undefined?'fixed':'percent');
  const selectedStore=o.store_id||'all';
  return `<form id="pricingRuleForm" class="form-grid offer-editor pricing-editor">
    <label class="admin-field"><span>Магазини з 1С</span><select name="store_id" id="pricingStoreId" required>${pricingStoreOptions(stores,selectedStore,true)}</select></label>
    <label class="admin-field"><span>Тип правила</span><select name="type" id="pricingRuleType"><option value="club" ${o.type==='club'||!o.type?'selected':''}>Клубна ціна</option><option value="wholesale" ${o.type==='wholesale'?'selected':''}>Оптова ціна</option></select></label>
    <label class="admin-field"><span>Назва для користувача</span><input name="name" value="${esc(o.name||'')}" placeholder="Наприклад: Клубна ціна на лате" required></label>
    <label class="admin-field"><span>Опис</span><textarea name="description" placeholder="Короткий опис пропозиції">${esc(o.description||'')}</textarea></label>
    <label class="admin-field"><span>Фото</span><input id="pricingImageUrl" name="image_url" value="${esc(o.image_url||'/assets/star.svg')}" placeholder="/assets/item.jpg або https://..."></label>
    <label class="admin-field"><span>Завантажити фото</span><input id="pricingImageFile" type="file" accept="image/png,image/jpeg,image/webp,image/gif"></label>
    <div class="promo-image-preview"><img id="pricingImagePreview" src="${esc(previewImageUrl(o.image_url||'/assets/star.svg'))}" alt="Попередній перегляд"><div><b>Картка в Mini App</b><p class="small">Для кожного вибраного товару створюється окрема пропозиція.</p></div></div>

    <div class="pricing-target-box">
      <div class="pricing-section-head"><div><b>Товар або група з 1С</b><div class="small">Ціни завантажуються для вибраного магазину.</div></div><span class="pill" id="selectedTargetsCount">0 вибрано</span></div>
      <div class="fixed-price-single-hint" id="fixedPriceSingleHint" hidden><b>Фіксована ціна — один товар</b><span>У цьому режимі можна вибрати тільки одну товарну позицію. Вибір групи вимкнено.</span></div>
      <label class="admin-field"><span>Тип вибору</span><select name="target_type" id="pricingTargetType"><option value="product" ${targetType==='product'?'selected':''}>Окремі товари</option><option value="group" ${targetType==='group'||targetType==='category'?'selected':''}>Групи товарів</option></select></label>
      <label class="admin-field"><span>Пошук</span><input id="pricingTargetSearch" placeholder="Назва або код 1С"></label>
      <div id="pricingTargetPicker" class="pricing-target-picker" data-current-target="${esc(targetValue)}"><div class="small">Завантаження…</div></div>
    </div>

    <div class="offer-type-fields" data-pricing-field="club">
      <div class="pricing-mode-heading"><b>Налаштування клубної ціни</b><span>Оберіть один спосіб розрахунку клубної вартості.</span></div>
      <label class="admin-field"><span>Спосіб ціни</span><select name="price_mode" id="clubPriceMode"><option value="percent" ${priceMode==='percent'?'selected':''}>Знижка у %</option><option value="amount" ${priceMode==='amount'?'selected':''}>Знижка у грн</option><option value="fixed" ${priceMode==='fixed'?'selected':''}>Фіксована нова ціна</option></select></label>
      <label class="admin-field"><span>Значення</span><input id="clubPriceValue" name="price_value" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(offerStoredPriceValue(o))}"></label>
      <label class="admin-field"><span>Максимум одиниць у чеку за клубною ціною (0 — без обмеження)</span><input name="max_club_qty_per_receipt" type="number" min="0" step="1" value="${esc(o.max_club_qty_per_receipt||0)}" placeholder="Наприклад, 5"></label>
      <label class="admin-field"><span>Округлення</span><select name="rounding_mode" id="pricingRounding"><option value="kopeck" ${o.rounding_mode==='kopeck'||!o.rounding_mode?'selected':''}>До копійки</option><option value="10kop" ${o.rounding_mode==='10kop'?'selected':''}>До 10 коп.</option><option value="50kop" ${o.rounding_mode==='50kop'?'selected':''}>До 50 коп.</option><option value="1uah" ${o.rounding_mode==='1uah'?'selected':''}>До 1 грн</option></select></label>
    </div>
    <div class="offer-type-fields wholesale-builder" data-pricing-field="wholesale">
      <div class="pricing-mode-heading"><b>Налаштування оптової ціни</b><span>Клубні поля приховані. Додайте лише рівні, що залежать від кількості.</span></div>
      <div class="wholesale-head"><div><b>Рівні оптових цін</b><div class="small">Від кількості — %, грн або фіксована ціна.</div></div><button type="button" id="addWholesaleTier" class="secondary">+ Додати рівень</button></div>
      <div id="wholesaleTiers" class="tier-list">${wholesaleTierRows(tiers)}</div>
    </div>

    <div class="pricing-preview-card">
      <div><span class="small">Стара ціна</span><b id="pricingOldPrice">—</b></div>
      <div><span class="small">Нова ціна</span><b id="pricingNewPrice">—</b></div>
      <div><span class="small">Економія</span><b id="pricingSaving">—</b></div>
      <p class="small" id="pricingPreviewHint">Оберіть магазин і товар.</p>
    </div>
    <div class="pricing-manual-grid">
      <label class="checkline"><input type="checkbox" name="use_manual_old_price" id="useManualOld" ${Number(o.use_manual_old_price)?'checked':''}> Вказати стару ціну вручну</label>
      <label class="admin-field"><span>Стара ціна вручну, грн</span><input name="manual_old_price_uah" id="manualOldPrice" type="number" min="0" step="0.01" value="${esc(centsToUah(o.manual_old_price_cents))}"></label>
      <label class="checkline"><input type="checkbox" name="use_manual_new_price" id="useManualNew" ${Number(o.use_manual_new_price)?'checked':''}> Вказати нову ціну вручну</label>
      <label class="admin-field"><span>Нова ціна вручну, грн</span><input name="manual_new_price_uah" id="manualNewPrice" type="number" min="0" step="0.01" value="${esc(centsToUah(o.manual_new_price_cents))}"></label>
    </div>
    <label class="checkline"><input type="checkbox" name="visible_in_app" ${o.id?(Number(o.visible_in_app)?'checked':''):'checked'}> Показувати користувачам</label>
    <label class="checkline"><input type="checkbox" name="is_active" ${o.id?(Number(o.is_active)?'checked':''):'checked'}> Активне правило в 1С</label>
    <div class="form-actions"><button class="primary">${o.id?'Зберегти':'Створити окремі пропозиції'}</button>${o.id?'<button type="button" id="cancelPricingEdit">Скасувати</button>':''}</div>
  </form>`;
}

async function pricingRules(editId=null){
  offerAdminSection='pricing';title.textContent='Пропозиції та ціни';
  const [{offers:all=[]},{stores=[]}]=await Promise.all([api('/api/admin/catalog/offers'),api('/api/admin/stores')]);
  const rules=all.filter(o=>o.type==='club'||o.type==='wholesale');
  const edit=editId?rules.find(x=>String(x.id)===String(editId)):null;
  content.innerHTML=`${offerAdminTabs()}
    <div class="card editor-card ${edit?'edit-panel':''}"><div class="section-title-row"><div><h3>${edit?'Редагувати пропозицію':'Створити пропозиції'}</h3><p class="small">Фіксована ціна — тільки один товар. Для кількох товарів система створює окрему картку на кожен.</p></div><span class="pill">1С + Mini App</span></div>${pricingRuleForm(edit||{},stores)}</div>
    <div class="offer-list">${rules.map(o=>{const oldPrice=pricingEffectiveOld(o),newPrice=pricingEffectiveNew(o),saving=oldPrice!==null&&newPrice!==null?Math.max(0,oldPrice-newPrice):null;return `<article class="offer-mobile-card"><div class="offer-card-head"><div><span class="pill">${o.type==='wholesale'?'Оптова':'Клубна'}</span><h3>${esc(o.name)}</h3></div><span>${activeText(o.is_active)}</span></div>${o.image_url?`<img class="pricing-list-image" src="${esc(previewImageUrl(o.image_url))}" alt="${esc(o.name)}">`:''}<p class="small">${esc(o.description||'')}</p><dl><div><dt>Магазин</dt><dd>${esc(o.store_name||o.store_id||'—')}</dd></div><div><dt>Товар</dt><dd><code>${esc(o.target_value||'—')}</code></dd></div><div><dt>Ціна</dt><dd>${oldPrice!==null?`<s>${num(oldPrice/100)} грн</s>`:'—'} → ${newPrice!==null?`<b>${num(newPrice/100)} грн</b>`:'—'}${saving!==null?` · економія ${num(saving/100)} грн`:''}</dd></div></dl><div class="actions">${btn('Редагувати',`data-edit-pricing="${o.id}"`)}${btn('Видалити',`data-delete-pricing="${o.id}" class="danger"`)}</div></article>`;}).join('')||'<div class="card">Цінових правил поки немає</div>'}</div>`;
  bindOfferAdminTabs();

  const form=$('#pricingRuleForm'),typeSelect=$('#pricingRuleType'),targetTypeSelect=$('#pricingTargetType'),storeSelect=$('#pricingStoreId'),targetPicker=$('#pricingTargetPicker'),targetSearch=$('#pricingTargetSearch');
  const selectedTargets=new Set(edit?[normalizeAdminOneCCode(edit.target_value)]:[]);let targetItems=[];
  const selectedItem=()=>targetItems.find(i=>selectedTargets.has(normalizeAdminOneCCode(i.external_id||i.id)));
  const suggestOneCPhoto=()=>{
    const item=selectedItem();const imageInput=$('#pricingImageUrl');
    if(!item?.image_url||!imageInput)return;
    if(!imageInput.value||imageInput.value==='/assets/star.svg') {
      imageInput.value=item.image_url;
      $('#pricingImagePreview').src=previewImageUrl(item.image_url);
    }
  };
  const calculatePreview=()=>{const item=selectedItem();let oldCents=item?Number(item.price_cents??item.min_price_cents??0):Number(edit?.calculated_old_price_cents||0);if($('#useManualOld')?.checked)oldCents=uahToCents($('#manualOldPrice')?.value);let newCents=null;if($('#useManualNew')?.checked)newCents=uahToCents($('#manualNewPrice')?.value);else if(typeSelect.value==='club'&&oldCents>0){const mode=$('#clubPriceMode').value,value=Number($('#clubPriceValue').value||0);newCents=mode==='percent'?Math.round(oldCents*(100-value)/100):mode==='amount'?Math.max(0,oldCents-uahToCents(value)):uahToCents(value);}else if(typeSelect.value==='wholesale'&&oldCents>0){const first=$$('[data-tier-row]')[0];if(first){const mode=first.querySelector('[data-tier-mode]').value,value=Number(first.querySelector('[data-tier-value]').value||0);newCents=mode==='percent'?Math.round(oldCents*(100-value)/100):mode==='amount'?Math.max(0,oldCents-uahToCents(value)):uahToCents(value);}}$('#pricingOldPrice').textContent=oldCents>0?`${num(oldCents/100)} грн`:'—';$('#pricingNewPrice').textContent=newCents!==null?`${num(newCents/100)} грн`:'—';$('#pricingSaving').textContent=oldCents>0&&newCents!==null?`${num(Math.max(0,oldCents-newCents)/100)} грн`:'—';$('#pricingPreviewHint').textContent=item?`${item.name} · ${storeSelect.options[storeSelect.selectedIndex]?.text||''}`:'Оберіть товар або групу.';};
  const renderPicker=()=>{
    const search=targetSearch.value.trim().toLowerCase();
    const fixed=typeSelect.value==='club'&&$('#clubPriceMode').value==='fixed';
    const visible=targetItems.filter(i=>!search||`${i.name} ${i.external_id||i.id}`.toLowerCase().includes(search)).slice(0,400);
    targetPicker.classList.toggle('single-target-mode',fixed);
    targetPicker.innerHTML=visible.map(item=>{
      const code=normalizeAdminOneCCode(item.external_id||item.id),checked=selectedTargets.has(code),price=item.price_cents??item.min_price_cents;
      return `<label class="pricing-target-item"><input type="${fixed?'radio':'checkbox'}" ${fixed?'name="fixedPricingTarget"':''} value="${esc(code)}" ${checked?'checked':''}><span><b>${esc(item.name||code)}</b><small>${esc(code)}${price?` · ${num(Number(price)/100)} грн`:''}</small></span></label>`;
    }).join('')||'<div class="small">Нічого не знайдено.</div>';
    targetPicker.querySelectorAll('input').forEach(input=>input.onchange=()=>{
      if(input.checked){
        if(fixed)selectedTargets.clear();
        selectedTargets.add(input.value);
      }else if(!fixed){
        selectedTargets.delete(input.value);
      }
      renderPicker();
      calculatePreview();
    });
    suggestOneCPhoto();
    $('#selectedTargetsCount').textContent=fixed?`${selectedTargets.size} з 1`:`${selectedTargets.size} вибрано`;
  };
  const loadTargets=async()=>{const storeId=storeSelect.value;if(!storeId){targetItems=[];renderPicker();return;}const type=targetTypeSelect.value;const data=await api(`/api/admin/catalog/${type==='group'?'product-groups':'products'}?store_id=${encodeURIComponent(storeId)}`);targetItems=type==='group'?(data.groups||[]):(data.products||[]);renderPicker();suggestOneCPhoto();calculatePreview();};
  const syncFields=async()=>{
    const wholesale=typeSelect.value==='wholesale';
    const fixed=!wholesale&&$('#clubPriceMode').value==='fixed';
    $$('[data-pricing-field="club"]').forEach(el=>{el.hidden=wholesale;el.querySelectorAll('input,select,button').forEach(control=>control.disabled=wholesale);});
    $$('[data-pricing-field="wholesale"]').forEach(el=>{el.hidden=!wholesale;el.querySelectorAll('input,select,button').forEach(control=>control.disabled=!wholesale);});
    $('#fixedPriceSingleHint').hidden=!fixed;
    targetTypeSelect.disabled=fixed;
    if(fixed){
      targetTypeSelect.value='product';
      if(selectedTargets.size>1){
        const first=[...selectedTargets][0];
        selectedTargets.clear();
        if(first)selectedTargets.add(first);
      }
    }
    await loadTargets();
  };
  const bindTierButtons=()=>{$$('[data-remove-tier]').forEach(btn=>btn.onclick=()=>{const row=btn.closest('[data-tier-row]');if($$('[data-tier-row]').length>1)row.remove();else{row.querySelector('[data-tier-qty]').value='';row.querySelector('[data-tier-value]').value='';}calculatePreview();});$$('[data-tier-row] input,[data-tier-row] select').forEach(el=>el.addEventListener('input',calculatePreview));};
  $('#addWholesaleTier')?.addEventListener('click',()=>{$('#wholesaleTiers').insertAdjacentHTML('beforeend',wholesaleTierRows([{qty:'',mode:'fixed',value:''}]));bindTierButtons();});typeSelect.addEventListener('change',syncFields);targetTypeSelect.addEventListener('change',()=>{selectedTargets.clear();loadTargets();});storeSelect.addEventListener('change',()=>{selectedTargets.clear();loadTargets();});targetSearch.addEventListener('input',renderPicker);$('#clubPriceMode').addEventListener('change',syncFields);$('#clubPriceValue').addEventListener('input',calculatePreview);['#useManualOld','#manualOldPrice','#useManualNew','#manualNewPrice'].forEach(sel=>$(sel)?.addEventListener('input',calculatePreview));const imageInput=$('#pricingImageUrl'),imageFile=$('#pricingImageFile');imageInput?.addEventListener('input',()=>{$('#pricingImagePreview').src=previewImageUrl(imageInput.value);});imageFile?.addEventListener('change',async()=>{const dataUrl=await fileToDataUrl(imageFile.files?.[0]);if(dataUrl){imageInput.value=dataUrl;$('#pricingImagePreview').src=dataUrl;}});bindTierButtons();await syncFields();
  form.onsubmit=async ev=>{ev.preventDefault();const type=typeSelect.value,targetType=targetTypeSelect.value,targets=[...selectedTargets];if(!storeSelect.value){alert('Оберіть магазин або «Усі магазини»');return;}if(!targets.length){alert('Оберіть товар або групу');return;}if(type==='club'&&$('#clubPriceMode').value==='fixed'&&(targetType!=='product'||targets.length!==1)){alert('Фіксовану ціну можна задати лише для одного товару');return;}const tiers=type==='wholesale'?$$('[data-tier-row]').map(row=>({qty:Number(row.querySelector('[data-tier-qty]').value),mode:row.querySelector('[data-tier-mode]').value,value:Number(row.querySelector('[data-tier-value]').value)})).filter(t=>t.qty>0&&Number.isFinite(t.value)):[];if(type==='wholesale'&&!tiers.length){alert('Додайте оптовий рівень');return;}const body={type,name:val(form,'name'),description:val(form,'description')||null,image_url:val(form,'image_url')||'/assets/star.svg',store_id:storeSelect.value,target_type:targetType,price_mode:type==='club'?$('#clubPriceMode').value:null,price_value:type==='club'?Number($('#clubPriceValue').value):null,rounding_mode:val(form,'rounding_mode')||'kopeck',max_club_qty_per_receipt:Number(val(form,'max_club_qty_per_receipt')||0),tiers,visible_in_app:check(form,'visible_in_app'),is_active:check(form,'is_active'),use_manual_old_price:check(form,'use_manual_old_price'),manual_old_price_cents:uahToCents(val(form,'manual_old_price_uah')),use_manual_new_price:check(form,'use_manual_new_price'),manual_new_price_cents:uahToCents(val(form,'manual_new_price_uah'))};if(edit)await api(`/api/admin/catalog/offers/${edit.id}`,{method:'PATCH',body:JSON.stringify({...body,target_value:targets[0]})});else if(targets.length>1)await api('/api/admin/catalog/pricing/bulk',{method:'POST',body:JSON.stringify({...body,target_values:targets})});else await api('/api/admin/catalog/offers',{method:'POST',body:JSON.stringify({...body,target_value:targets[0]})});await pricingRules();};
  $('#cancelPricingEdit')?.addEventListener('click',()=>pricingRules());$$('[data-edit-pricing]').forEach(b=>b.onclick=async()=>{await pricingRules(b.dataset.editPricing);scrollAdminFormIntoView();});$$('[data-delete-pricing]').forEach(b=>b.onclick=async()=>{if(confirm('Видалити цінове правило і картку?')){await api(`/api/admin/catalog/offers/${b.dataset.deletePricing}`,{method:'DELETE'});await pricingRules();}});
}

function multiplierForm(o={},stores=[]){
  return `<form id="multiplierForm" class="form-grid offer-editor">
    <label class="admin-field"><span>Назва для клієнта</span><input name="name" value="${esc(o.name||'')}" placeholder="Наприклад: Подвійні зірки на випічку" required></label>
    <label class="admin-field"><span>Опис</span><input name="description" value="${esc(o.description||'')}"></label>
    <label class="admin-field"><span>Фото (автоматично з 1С для вибраного товару)</span><input name="image_url" value="${esc(o.image_url||'/assets/star.svg')}" placeholder="Фото URL"></label>
    <label class="admin-field"><span>Завантажити власне фото</span><input id="multiplierImageFile" type="file" accept="image/jpeg,image/png,image/webp,image/gif"></label>
    <div class="promo-image-preview"><img id="multiplierImagePreview" src="${esc(previewImageUrl(o.image_url||'/assets/star.svg'))}" alt="Попередній перегляд"><div><b>Зображення множника</b><p class="small">Якщо поле фото не заповнене, Star Club використовує фото товару з 1С.</p></div></div>
    <label class="admin-field"><span>Код товару або групи з 1С</span><input name="target_ref" value="${esc(o.target_value||o.product_external_id||o.category||'')}" placeholder="ЦБ000004323" required></label>
    <label class="admin-field"><span>Множник зірок</span><input name="stars_multiplier" type="number" min="1" step="0.1" inputmode="decimal" value="${esc(o.stars_multiplier||'')}" placeholder="2" required></label>
    <label class="admin-field"><span>Магазин</span><select name="store_id"><option value="all" ${!o.store_id||o.store_id==='all'?'selected':''}>Усі магазини</option>${pricingStoreOptions(stores,o.store_id||'')}</select></label>
    <label class="checkline"><input type="checkbox" name="is_active" ${o.id?(Number(o.is_active)?'checked':''):'checked'}> Активний</label>
    <div class="form-actions"><button class="primary">${o.id?'Зберегти':'Створити множник'}</button>${o.id?'<button type="button" id="cancelMultiplierEdit">Скасувати</button>':''}</div>
  </form>`;
}
async function multipliers(editId=null){
  offerAdminSection='multiplier';title.textContent='Пропозиції та ціни';
  const [{offers:all=[]},{stores=[]}]=await Promise.all([api('/api/admin/catalog/offers'),api('/api/admin/stores')]);const items=all.filter(o=>o.type==='stars_multiplier');const edit=editId?items.find(x=>String(x.id)===String(editId)):null;
  content.innerHTML=`${offerAdminTabs()}<div class="card editor-card ${edit?'edit-panel':''}"><div class="section-title-row"><div><h3>${edit?'Редагувати множник':'Множник зірок'}</h3><p class="small">Логіку множника залишено окремою та без змін від початкової реалізації.</p></div><span class="pill">★</span></div>${multiplierForm(edit||{},stores)}</div><div class="offer-list">${items.map(o=>`<article class="offer-mobile-card">${o.image_url?`<img class="pricing-list-image" src="${esc(previewImageUrl(o.image_url))}" alt="${esc(o.name)}">`:''}<div class="offer-card-head"><div><span class="pill">Множник</span><h3>${esc(o.name)}</h3></div><span>${activeText(o.is_active)}</span></div><dl><div><dt>Умова</dt><dd>${esc(offerCondition(o))}</dd></div><div><dt>Код 1С</dt><dd><code>${esc(o.target_value||o.product_external_id||o.category||'—')}</code></dd></div><div><dt>Магазин</dt><dd>${esc(o.store_name||o.store_id||'all')}</dd></div></dl><div class="actions">${btn('Редагувати',`data-edit-multiplier="${o.id}"`)}${btn('Видалити',`data-delete-multiplier="${o.id}" class="danger"`)}</div></article>`).join('')||'<div class="card">Множників поки немає</div>'}</div>`;
  bindOfferAdminTabs();const form=$('#multiplierForm');
  const multiplierImageInput=form.elements.image_url;
  const multiplierPreview=$('#multiplierImagePreview');
  multiplierImageInput.addEventListener('input',()=>{multiplierPreview.src=previewImageUrl(multiplierImageInput.value);});
  $('#multiplierImageFile')?.addEventListener('change',async(event)=>{
    try{const dataUrl=await fileToDataUrl(event.target.files?.[0]);if(dataUrl){multiplierImageInput.value=dataUrl;multiplierPreview.src=dataUrl;}}
    catch(error){alert(error.message);event.target.value='';}
  });
  let photoSearchTimer=null;
  form.elements.target_ref?.addEventListener('input',()=>{
    clearTimeout(photoSearchTimer);
    photoSearchTimer=setTimeout(async()=>{
      const code=normalizeAdminOneCCode(val(form,'target_ref'));
      if(!code||multiplierImageInput.value && multiplierImageInput.value!='/assets/star.svg')return;
      try{
        const data=await api('/api/admin/catalog/products?q='+encodeURIComponent(code));
        const item=(data.products||[]).find(i=>normalizeAdminOneCCode(i.external_id)===code);
        if(item?.image_url){multiplierImageInput.value=item.image_url;multiplierPreview.src=previewImageUrl(item.image_url);}
      }catch{}
    },350);
  });
  form.onsubmit=async ev=>{ev.preventDefault();const multiplier=Number(val(form,'stars_multiplier'));if(multiplier<=1){alert('Вкажіть множник більше 1, наприклад 2');return;}const body={type:'stars_multiplier',name:val(form,'name'),description:val(form,'description'),image_url:val(form,'image_url')||'/assets/star.svg',target_ref:normalizeAdminOneCCode(val(form,'target_ref')),stars_multiplier:multiplier,store_id:val(form,'store_id')||'all',is_active:check(form,'is_active')};await api(edit?`/api/admin/catalog/offers/${edit.id}`:'/api/admin/catalog/offers',{method:edit?'PATCH':'POST',body:JSON.stringify(body)});await multipliers();};$('#cancelMultiplierEdit')?.addEventListener('click',()=>multipliers());$$('[data-edit-multiplier]').forEach(b=>b.onclick=async()=>{await multipliers(b.dataset.editMultiplier);scrollAdminFormIntoView();});$$('[data-delete-multiplier]').forEach(b=>b.onclick=async()=>{if(confirm('Видалити множник?')){await api(`/api/admin/catalog/offers/${b.dataset.deleteMultiplier}`,{method:'DELETE'});await multipliers();}});
}

async function offers(editId=null,section=null){
  if(section)offerAdminSection=section;
  if(offerAdminSection==='multiplier')return multipliers(editId);
  return pricingRules(editId);
}


async function starExclusions(){
  title.textContent='Не нараховувати зірки';
  const [{products=[]},{groups=[]},{excluded=[]},{groups:excludedGroups=[]}]=await Promise.all([api('/api/admin/catalog/products'),api('/api/admin/catalog/product-groups'),api('/api/admin/catalog/star-exclusions'),api('/api/admin/catalog/star-group-exclusions')]);
  let mode='product';const selectedProducts=new Set(excluded.map(i=>normalizeAdminOneCCode(i.product_external_id)));const selectedGroups=new Map(excludedGroups.map(g=>[normalizeAdminOneCCode(g.group_external_id),g.group_name||g.group_external_id]));
  content.innerHTML=`<div class="card star-exclusion-editor"><div class="section-title-row"><div><h3>Не нараховувати зірки</h3><p class="small">Оберіть окремі товари або цілі групи з синхронізації 1С.</p></div><span class="pill" id="starExclusionCount"></span></div><div class="offer-admin-tabs"><button type="button" data-exclusion-mode="product" class="active">Товари</button><button type="button" data-exclusion-mode="group">Групи</button></div><div class="star-exclusion-toolbar"><input id="starExclusionSearch" placeholder="Пошук за назвою або кодом 1С"><button type="button" id="starExclusionClear">Очистити поточний вибір</button></div><div id="starExclusionPicker" class="star-exclusion-picker"></div><div class="form-actions star-exclusion-actions"><button type="button" class="primary" id="saveStarExclusions">Зберегти</button></div></div>`;
  const picker=$('#starExclusionPicker'),search=$('#starExclusionSearch'),count=$('#starExclusionCount');
  const render=()=>{const q=String(search.value||'').toLowerCase();const list=mode==='product'?products:groups;picker.innerHTML=list.filter(x=>!q||String(`${x.name||''} ${x.external_id||x.id||''}`).toLowerCase().includes(q)).map(x=>{const code=normalizeAdminOneCCode(mode==='product'?(x.external_id||x.id):x.id);const selected=mode==='product'?selectedProducts.has(code):selectedGroups.has(code);return `<label class="star-exclusion-item ${selected?'selected':''}"><input type="checkbox" value="${esc(code)}" ${selected?'checked':''}><span><b>${esc(x.name||code)}</b><small><code>${esc(code)}</code>${mode==='group'&&x.products_count!==undefined?` · ${num(x.products_count)} товарів`:''}</small></span></label>`;}).join('')||'<div class="small">Даних немає. Виконайте синхронізацію з 1С.</div>';picker.querySelectorAll('input').forEach(inp=>inp.onchange=()=>{const code=normalizeAdminOneCCode(inp.value);if(mode==='product'){inp.checked?selectedProducts.add(code):selectedProducts.delete(code);}else{if(inp.checked){const item=groups.find(g=>normalizeAdminOneCCode(g.id)===code);selectedGroups.set(code,item?.name||code);}else selectedGroups.delete(code);}renderCount();inp.closest('label').classList.toggle('selected',inp.checked);});};
  const renderCount=()=>count.textContent=`Товарів: ${selectedProducts.size} · груп: ${selectedGroups.size}`;$$('[data-exclusion-mode]').forEach(b=>b.onclick=()=>{mode=b.dataset.exclusionMode;$$('[data-exclusion-mode]').forEach(x=>x.classList.toggle('active',x===b));render();});search.oninput=render;$('#starExclusionClear').onclick=()=>{mode==='product'?selectedProducts.clear():selectedGroups.clear();renderCount();render();};$('#saveStarExclusions').onclick=async()=>{await Promise.all([api('/api/admin/catalog/star-exclusions',{method:'PUT',body:JSON.stringify({product_external_ids:[...selectedProducts]})}),api('/api/admin/catalog/star-group-exclusions',{method:'PUT',body:JSON.stringify({groups:[...selectedGroups].map(([group_external_id,group_name])=>({group_external_id,group_name}))})})]);alert('Список збережено');starExclusions();};renderCount();render();
}

async function challenges(editId=null){
  title.textContent='Челенджі';
  const {challenges: challengeItems}=await api('/api/admin/catalog/challenges');
  const edit=editId?challengeItems.find(x=>String(x.id)===String(editId)):null;
  content.innerHTML=`<div class="card editor-card ${edit?'edit-panel':''}"><h3>${edit?'Редагувати челендж':'Створити челендж'}</h3>
    <form id="challengeForm" class="form-grid">
      <label class="admin-field"><span>Назва</span><input name="name" value="${esc(edit?.name||'')}" required></label>
      <label class="admin-field"><span>Опис</span><input name="description" value="${esc(edit?.description||'')}"></label>
      <label class="admin-field"><span>Код товару або групи з 1С</span><input name="category" placeholder="Наприклад: ЦБ000001210 або bakery" value="${esc(edit?.category||'')}"></label>
      <label class="admin-field"><span>Кількість відвідувань</span><input name="required_visits" type="number" min="1" value="${esc(edit?.required_visits||1)}" required></label>
      <label class="admin-field"><span>Мінімальний чек, грн</span><input name="min_total_uah" type="number" min="0" step="0.01" value="${esc(centsToUah(edit?.min_total_cents)||0)}"></label>
      <label class="admin-field"><span>Бонус, зірок</span><input name="reward_stars" type="number" min="1" value="${esc(edit?.reward_stars||100)}" required></label>
      <label class="admin-field"><span>Період</span><select name="period_type"><option value="week" ${edit?.period_type==='week'?'selected':''}>Тиждень</option><option value="month" ${edit?.period_type==='month'?'selected':''}>Місяць</option></select></label>
      <label class="admin-field"><span>Магазин</span><input name="store_id" placeholder="all або ID магазину" value="${esc(edit?.store_id||'all')}"></label>
      <label class="checkline"><input type="checkbox" name="is_repeatable" ${Number(edit?.is_repeatable)?'checked':''}> Повторюваний</label>
      <label class="checkline"><input type="checkbox" name="is_active" ${edit?(Number(edit.is_active)?'checked':''):'checked'}> Активний</label>
      <div class="form-actions"><button class="primary">${edit?'Зберегти':'Створити'}</button>${edit?'<button type="button" id="cancelEdit">Скасувати</button>':''}</div>
    </form>
  </div>
  <div class="offer-list">${challengeItems.map(c=>`<article class="offer-mobile-card">
    <div class="offer-card-head"><div><span class="pill">Челендж</span><h3>${esc(c.name)}</h3></div><span>${activeText(c.is_active)}</span></div>
    <dl><div><dt>Група 1С</dt><dd>${esc(c.category||'усі товари')}</dd></div><div><dt>Умова</dt><dd>${c.required_visits} відвідувань</dd></div><div><dt>Мін. чек</dt><dd>${num(c.min_total_cents/100)} грн</dd></div><div><dt>Бонус</dt><dd>${num(c.reward_stars)} ★</dd></div></dl>
    <div class="actions">${btn('Редагувати',`data-edit-challenge="${c.id}"`)}${btn('Видалити',`data-delete-challenge="${c.id}"`)}</div>
  </article>`).join('')||'<div class="card">Челенджів поки немає</div>'}</div>`;
  const form=$('#challengeForm');
  form.onsubmit=async ev=>{
    ev.preventDefault();
    const body={name:val(form,'name'),description:val(form,'description'),category:val(form,'category')||null,required_visits:Number(val(form,'required_visits')),min_total_cents:uahToCents(val(form,'min_total_uah'))||0,reward_stars:Number(val(form,'reward_stars')),period_type:val(form,'period_type'),store_id:val(form,'store_id')||'all',is_repeatable:check(form,'is_repeatable'),is_active:check(form,'is_active')};
    await api(edit?`/api/admin/catalog/challenges/${edit.id}`:'/api/admin/catalog/challenges',{method:edit?'PATCH':'POST',body:JSON.stringify(body)});
    challenges();
  };
  $('#cancelEdit')?.addEventListener('click',()=>challenges());
  $$('[data-edit-challenge]').forEach(b=>b.onclick=async()=>{await challenges(b.dataset.editChallenge);scrollAdminFormIntoView();});
  $$('[data-delete-challenge]').forEach(b=>b.onclick=async()=>{if(confirm('Видалити челендж?')){await api(`/api/admin/catalog/challenges/${b.dataset.deleteChallenge}`,{method:'DELETE'});challenges();}});
}

async function stamps(editId=null){
  title.textContent='Накопичувальні програми';
  const {programs}=await api('/api/admin/catalog/stamps');
  const edit=editId?programs.find(x=>String(x.id)===String(editId)):null;
  const currentType=edit?.target_type||'group';
  const currentValue=normalizeAdminOneCCode(edit?.target_value||edit?.category||'');

  content.innerHTML=`
    <div class="card editor-card ${edit?'edit-panel':''}">
      <h3>${edit?'Редагувати програму':'Створити програму'}</h3>
      <p class="small">Оберіть конкретний товар або групу з 1С. Після завершення циклу код видається на товар, який клієнт купував найбільше разів у межах цієї програми.</p>
      <form id="stampForm" class="form-grid stamp-editor-grid">
        <label class="admin-field"><span>Назва програми</span><input name="name" placeholder="Наприклад: 10-та кава безкоштовно" value="${esc(edit?.name||'')}" required></label>
        <label class="admin-field"><span>Що зараховувати</span><select name="target_type" id="stampTargetType"><option value="group" ${currentType==='group'?'selected':''}>Групу товарів</option><option value="product" ${currentType==='product'?'selected':''}>Окремий товар</option></select></label>
        <label class="admin-field stamp-qty-field"><span>Скільки покупок до коду</span><input name="required_qty" type="number" min="1" placeholder="10" value="${esc(edit?.required_qty||10)}" required></label>
        <section class="stamp-picker-panel">
          <label class="admin-field"><span>Пошук у номенклатурі 1С</span><input id="stampTargetSearch" placeholder="Назва або код 1С"></label>
          <div id="stampTargetPicker" class="pricing-target-picker stamp-target-picker"><div class="small">Завантаження…</div></div>
          <div class="technical-code">Вибрано: <b id="stampSelectedTarget">${esc(edit?.target_name||currentValue||'нічого')}</b></div>
        </section>
        <label class="admin-field stamp-reward-field"><span>Винагорода</span><input value="QR/код на найчастіше придбаний товар, діє 7 днів" readonly></label>
        <label class="checkline"><input type="checkbox" name="is_repeatable" ${edit?(Number(edit.is_repeatable)?'checked':''):'checked'}> Повторювати після видачі коду</label>
        <label class="checkline"><input type="checkbox" name="is_active" ${edit?(Number(edit.is_active)?'checked':''):'checked'}> Активна</label>
        ${edit?`<div class="technical-code">Технічний код: <b>${esc(edit.code)}</b></div>`:''}
        <div class="form-actions"><button class="primary">${edit?'Зберегти':'Створити'}</button>${edit?'<button type="button" id="cancelEdit">Скасувати</button>':''}</div>
      </form>
    </div>
    <div class="offer-list ${edit?'hide-while-editing':''}">
      ${programs.map(p=>`<article class="offer-mobile-card">
        <div class="offer-card-head"><div><span class="pill">Накопичувальна</span><h3>${esc(p.name)}</h3></div><span>${activeText(p.is_active)}</span></div>
        <dl>
          <div><dt>Товар або група</dt><dd>${esc(p.target_name||p.target_value||p.category)}</dd></div>
          <div><dt>Код 1С</dt><dd><code>${esc(p.target_value||p.category)}</code></dd></div>
          <div><dt>Потрібно покупок</dt><dd>${num(p.required_qty)}</dd></div>
          <div><dt>Винагорода</dt><dd>Код на найчастіше придбаний товар</dd></div>
        </dl>
        <div class="actions">${btn('Редагувати',`data-edit-stamp="${p.id}"`)}${btn('Видалити',`data-delete-stamp="${p.id}"`)}</div>
      </article>`).join('')||'<div class="card">Програм поки немає</div>'}
    </div>`;

  const form=$('#stampForm');
  const typeSelect=$('#stampTargetType');
  const search=$('#stampTargetSearch');
  const picker=$('#stampTargetPicker');
  const selectedLabel=$('#stampSelectedTarget');
  let items=[];
  let selectedValue=currentValue;
  let selectedName=edit?.target_name||currentValue;

  const codeOf=i=>normalizeAdminOneCCode(i.id||i.external_id||'');
  const renderPicker=()=>{
    const q=String(search.value||'').trim().toLowerCase();
    const filtered=items.filter(i=>!q||String(`${i.name||''} ${codeOf(i)}`).toLowerCase().includes(q));
    picker.innerHTML=filtered.slice(0,500).map(i=>{
      const code=codeOf(i);
      const meta=typeSelect.value==='group'?`${num(i.products_count||0)} товарів`:(i.price_cents?`${num(i.price_cents/100)} грн`:'');
      return `<label class="pricing-target-item"><input type="radio" name="stamp_target_pick" value="${esc(code)}" ${code===selectedValue?'checked':''}><span><b>${esc(i.name||code)}</b><small><code>${esc(code)}</code>${meta?' · '+esc(meta):''}</small></span></label>`;
    }).join('')||'<div class="small">Нічого не знайдено. Синхронізуйте номенклатуру з 1С.</div>';
    $$('input[name="stamp_target_pick"]').forEach(r=>r.onchange=()=>{
      const item=items.find(i=>codeOf(i)===normalizeAdminOneCCode(r.value));
      selectedValue=normalizeAdminOneCCode(r.value);
      selectedName=item?.name||selectedValue;
      selectedLabel.textContent=`${selectedName} (${selectedValue})`;
    });
  };
  const load=async()=>{
    selectedValue='';
    selectedName='';
    selectedLabel.textContent='нічого';
    const data=await api(typeSelect.value==='group'?'/api/admin/catalog/product-groups':'/api/admin/catalog/products');
    items=typeSelect.value==='group'?(data.groups||[]):(data.products||[]).map(p=>({...p,id:p.external_id}));
    if(currentValue&&!items.some(i=>codeOf(i)===currentValue))items.unshift({id:currentValue,external_id:currentValue,name:edit?.target_name||currentValue});
    if(edit&&typeSelect.value===currentType){selectedValue=currentValue;selectedName=edit?.target_name||currentValue;selectedLabel.textContent=`${selectedName} (${selectedValue})`;}
    renderPicker();
  };
  typeSelect.onchange=load;
  search.oninput=renderPicker;
  await load();

  form.onsubmit=async ev=>{
    ev.preventDefault();
    if(!selectedValue){alert('Оберіть товар або групу з 1С');return;}
    const body={
      name:val(form,'name'),
      target_type:val(form,'target_type'),
      target_value:selectedValue,
      target_name:selectedName,
      category:selectedValue,
      required_qty:Number(val(form,'required_qty')),
      reward_stars:0,
      is_repeatable:check(form,'is_repeatable'),
      is_active:check(form,'is_active')
    };
    await api(edit?`/api/admin/catalog/stamps/${edit.id}`:'/api/admin/catalog/stamps',{method:edit?'PATCH':'POST',body:JSON.stringify(body)});
    stamps();
  };
  $('#cancelEdit')?.addEventListener('click',()=>stamps());
  $$('[data-edit-stamp]').forEach(b=>b.onclick=async()=>{await stamps(b.dataset.editStamp);scrollAdminFormIntoView();});
  $$('[data-delete-stamp]').forEach(b=>b.onclick=async()=>{if(confirm('Видалити програму?')){await api(`/api/admin/catalog/stamps/${b.dataset.deleteStamp}`,{method:'DELETE'});stamps();}});
}

async function banners(editId=null){
  title.textContent='Банери головної';
  const data=await api('/api/admin/catalog/banners');
  const items=data.items||[];
  const sources=data.sources||[];
  const edit=editId?items.find(item=>String(item.id)===String(editId)):null;
  const editSourceKey=edit?.source_type&&edit.source_type!=='custom'&&edit.source_id?`${edit.source_type}:${edit.source_id}`:'';
  const sourceOptions=sources.map(source=>`<option value="${esc(source.key)}" ${source.key===editSourceKey?'selected':''}>${source.type==='wholesale'?'Оптова':'Клубна'} · ${esc(source.title)}</option>`).join('');
  content.innerHTML=`
    <div class="card banner-visibility-card">
      <div><span class="pill">Головна сторінка</span><h3>Показ банерів</h3><p class="small">Вимкніть перемикач, щоб повністю прибрати банерний блок із застосунку.</p></div>
      <form id="bannerVisibilityForm"><label class="admin-switch"><input type="checkbox" name="enabled" ${data.enabled!==false?'checked':''}><span>Банери увімкнені</span></label><button class="primary">Зберегти</button></form>
    </div>
    <div class="card editor-card ${edit?'edit-panel':''}">
      <div class="section-title-row"><div><h3>${edit?'Редагувати банер':'Додати банер'}</h3><p class="small">Можна взяти дані з клубної/оптової пропозиції або створити повністю власний банер.</p></div><span class="pill">Керування без коду</span></div>
      <form id="bannerForm" class="form-grid banner-editor">
        <label class="admin-field"><span>Джерело</span><select name="source_mode" id="bannerSourceMode"><option value="custom" ${!editSourceKey?'selected':''}>Власний банер</option><option value="offer" ${editSourceKey?'selected':''} ${sources.length?'':'disabled'}>Взяти з пропозиції</option></select></label>
        <label class="admin-field" id="bannerSourceOfferField"><span>Пропозиція</span><select id="bannerSourceOffer"><option value="">Оберіть пропозицію</option>${sourceOptions}</select></label>
        <label class="admin-field"><span>Мітка</span><input name="tag" value="${esc(edit?.tag||'STAR CLUB')}" placeholder="STAR CLUB"></label>
        <label class="admin-field"><span>Порядок показу</span><input name="sort_order" type="number" step="1" value="${esc(edit?.sort_order??100)}"></label>
        <label class="admin-field banner-title-field"><span>Заголовок</span><input name="title" value="${esc(edit?.title||'')}" placeholder="Заголовок банера" required></label>
        <label class="admin-field banner-text-field"><span>Опис</span><textarea name="text" placeholder="Короткий опис">${esc(edit?.text||'')}</textarea></label>
        <label class="admin-field banner-image-field"><span>Фото URL або локальний шлях</span><input id="bannerImageUrl" name="image_url" value="${esc(edit?.image_url||'/assets/star.svg')}" placeholder="/assets/banner.jpg або https://..."></label>
        <label class="admin-field"><span>Завантажити своє фото</span><input id="bannerImageFile" type="file" accept="image/png,image/jpeg,image/webp,image/gif"></label>
        <div class="banner-admin-preview"><img id="bannerImagePreview" src="${esc(previewImageUrl(edit?.image_url||'/assets/star.svg'))}" alt=""><div><b id="bannerPreviewTitle">${esc(edit?.title||'Новий банер')}</b><p id="bannerPreviewText">${esc(edit?.text||'Попередній перегляд банера')}</p></div></div>
        <label class="admin-field"><span>Дія після натискання</span><select name="link_route"><option value="offers" ${!edit||edit.link_route==='offers'?'selected':''}>Відкрити пропозиції</option><option value="news" ${edit?.link_route==='news'?'selected':''}>Відкрити новини</option><option value="rewards" ${edit?.link_route==='rewards'?'selected':''}>Відкрити «За зірки»</option><option value="none" ${edit?.link_route==='none'?'selected':''}>Без дії</option></select></label>
        <label class="checkline"><input type="checkbox" name="is_active" ${edit?(Number(edit.is_active)?'checked':''):'checked'}> Банер активний</label>
        <div class="form-actions"><button class="primary">${edit?'Зберегти банер':'Додати банер'}</button>${edit?'<button type="button" id="cancelBannerEdit">Скасувати</button>':''}</div>
      </form>
    </div>
    <div class="banner-admin-grid ${edit?'hide-while-editing':''}">
      ${items.map(item=>`<article class="banner-admin-card"><img src="${esc(previewImageUrl(item.image_url))}" alt="${esc(item.title)}"><div><span class="pill">${esc(item.tag||'STAR CLUB')} · ${item.is_active?'активний':'вимкнений'}</span><h3>${esc(item.title)}</h3><p>${esc(item.text||'')}</p><small>Порядок: ${num(item.sort_order)} · ${item.source_type==='custom'?'власний':'із пропозиції'}</small><div class="actions">${btn('Редагувати',`data-edit-banner="${item.id}"`)}${btn('Видалити',`data-delete-banner="${item.id}" class="danger"`)}</div></div></article>`).join('')||'<div class="card">Банерів немає. Додайте власний або виберіть пропозицію.</div>'}
    </div>`;

  $('#bannerVisibilityForm').onsubmit=async event=>{event.preventDefault();await api('/api/admin/catalog/banners/settings',{method:'PUT',body:JSON.stringify({enabled:check(event.currentTarget,'enabled')})});alert('Налаштування банерів збережено');banners();};
  const form=$('#bannerForm');
  const sourceMode=$('#bannerSourceMode');
  const sourceSelect=$('#bannerSourceOffer');
  const sourceField=$('#bannerSourceOfferField');
  const imageInput=$('#bannerImageUrl');
  const imageFile=$('#bannerImageFile');
  const refreshPreview=()=>{$('#bannerImagePreview').src=previewImageUrl(imageInput.value);$('#bannerPreviewTitle').textContent=val(form,'title')||'Новий банер';$('#bannerPreviewText').textContent=val(form,'text')||'Попередній перегляд банера';};
  const syncSource=()=>{const fromOffer=sourceMode.value==='offer';sourceField.hidden=!fromOffer;sourceSelect.required=fromOffer;};
  sourceMode.onchange=syncSource;
  sourceSelect.onchange=()=>{const source=sources.find(item=>item.key===sourceSelect.value);if(!source)return;form.elements.title.value=source.title||'';form.elements.text.value=source.text||'';form.elements.tag.value=source.tag||'STAR CLUB';imageInput.value=source.image_url||'/assets/star.svg';form.elements.link_route.value='offers';refreshPreview();};
  ['title','text'].forEach(name=>form.elements[name].addEventListener('input',refreshPreview));
  imageInput.addEventListener('input',refreshPreview);
  imageFile.addEventListener('change',async()=>{const file=imageFile.files?.[0];if(!file)return;if(file.size>1_050_000){alert('Фото завелике. Оберіть файл до 1 МБ.');imageFile.value='';return;}const dataUrl=await fileToDataUrl(file);if(dataUrl){imageInput.value=dataUrl;refreshPreview();}});
  syncSource();
  form.onsubmit=async event=>{event.preventDefault();let source_type='custom',source_id=null;if(sourceMode.value==='offer'){const [type,id]=String(sourceSelect.value||'').split(':');if(!type||!id){alert('Оберіть пропозицію');return;}source_type=type;source_id=Number(id);}const body={source_type,source_id,title:val(form,'title'),text:val(form,'text'),tag:val(form,'tag'),image_url:val(form,'image_url')||'/assets/star.svg',link_route:val(form,'link_route'),sort_order:Number(val(form,'sort_order')||100),is_active:check(form,'is_active')};await api(edit?`/api/admin/catalog/banners/${edit.id}`:'/api/admin/catalog/banners',{method:edit?'PATCH':'POST',body:JSON.stringify(body)});banners();};
  $('#cancelBannerEdit')?.addEventListener('click',()=>banners());
  $$('[data-edit-banner]').forEach(button=>button.onclick=async()=>{await banners(button.dataset.editBanner);scrollAdminFormIntoView();});
  $$('[data-delete-banner]').forEach(button=>button.onclick=async()=>{if(confirm('Видалити банер?')){await api(`/api/admin/catalog/banners/${button.dataset.deleteBanner}`,{method:'DELETE'});banners();}});
}

async function news(editId=null){
  title.textContent='Новини';
  const {news: newsItems}=await api('/api/admin/catalog/news');
  const edit=editId?newsItems.find(x=>String(x.id)===String(editId)):null;
  content.innerHTML=`<div class="card editor-card ${edit?'edit-panel':''}"><h3>${edit?'Редагувати новину':'Додати новину'}</h3><form id="newsForm" class="form-grid"><input name="title" placeholder="Заголовок" value="${esc(edit?.title||'')}" required><input name="tag" placeholder="Тег" value="${esc(edit?.tag||'')}"><input name="image_url" placeholder="Фото URL" value="${esc(edit?.image_url||'/assets/star.svg')}"><textarea name="text" placeholder="Текст" required>${esc(edit?.text||'')}</textarea><label class="checkline"><input type="checkbox" name="is_active" ${edit?(Number(edit.is_active)?'checked':''):'checked'}> Активна</label><button>${edit?'Зберегти':'Додати'}</button>${edit?'<button type="button" id="cancelEdit">Скасувати</button>':''}</form></div><div class="card listing-card ${edit?'hide-while-editing':''}"><table><thead><tr><th>Дата</th><th>Тег</th><th>Заголовок</th><th>Текст</th><th>Статус</th><th>Дії</th></tr></thead><tbody>${newsItems.map(n=>`<tr><td>${dt(n.created_at)}</td><td>${esc(n.tag||'')}</td><td>${esc(n.title)}</td><td>${esc(n.text)}</td><td>${activeText(n.is_active)}</td><td class="actions">${btn('Редагувати',`data-edit-news="${n.id}"`)}${btn('Видалити',`data-delete-news="${n.id}"`)}</td></tr>`).join('')}</tbody></table></div>`;
  const form=$('#newsForm'); form.onsubmit=async ev=>{ev.preventDefault();const body={title:val(form,'title'),tag:val(form,'tag'),image_url:val(form,'image_url')||'/assets/star.svg',text:val(form,'text'),is_active:check(form,'is_active')}; await api(edit?`/api/admin/catalog/news/${edit.id}`:'/api/admin/catalog/news',{method:edit?'PATCH':'POST',body:JSON.stringify(body)});news();}; $('#cancelEdit')?.addEventListener('click',()=>news()); $$('[data-edit-news]').forEach(b=>b.onclick=async()=>{await news(b.dataset.editNews);scrollAdminFormIntoView();}); $$('[data-delete-news]').forEach(b=>b.onclick=async()=>{if(confirm('Видалити новину?')){await api(`/api/admin/catalog/news/${b.dataset.deleteNews}`,{method:'DELETE'});news();}});
}

async function settings(){
  title.textContent='Налаштування';
  const [data,cleanupPreview]=await Promise.all([
    api('/api/admin/settings'),
    api('/api/admin/settings/client-cleanup/preview')
  ]);
  const map={};
  (data.settings||[]).forEach(s=>map[s.key]=s.value);
  const bonus=map.profile_bonus||{enabled:true,stars:500,grantWhen:'immediately',requiredFields:['phone','name','birth_date','favorite_store']};
  const cleanup=cleanupPreview.config||map.client_cleanup||{enabled:true,deletePositiveBalance:true,positiveInactiveDays:183,positiveMinBalance:1,positiveMaxBalance:null,deleteZeroBalance:true,zeroInactiveDays:183};
  const cleanupSummary=cleanupPreview.summary||{total:0,zero_balance:0,positive_balance:0};
  const required=new Set(bonus.requiredFields||[]);
  const field = (name,label) => `<label class="checkline"><input type="checkbox" name="requiredFields" value="${name}" ${required.has(name)?'checked':''}> ${label}</label>`;
  content.innerHTML=`<div class="admin-settings-stack">
    <div class="card"><h2>Бонус за повний профіль</h2><p class="small">Ці параметри керують тим, чи отримує клієнт бонус, який розмір бонусу, коли він нараховується і які поля вважаються повним профілем.</p>
      <form id="bonusSettingsForm" class="form-grid">
        <label class="checkline"><input type="checkbox" name="enabled" ${bonus.enabled!==false?'checked':''}> Давати бонус</label>
        <input name="stars" type="number" min="0" step="1" placeholder="Розмір бонусу, ★" value="${esc(bonus.stars??500)}">
        <select name="grantWhen">
          <option value="immediately" ${bonus.grantWhen!=='after_first_purchase'?'selected':''}>Одразу після повного профілю</option>
          <option value="after_first_purchase" ${bonus.grantWhen==='after_first_purchase'?'selected':''}>Після першої покупки</option>
        </select>
        <div class="card inner"><b>Поля повного профілю</b>
          ${field('phone','Номер телефону')}
          ${field('name','Імʼя')}
          ${field('birth_date','Дата народження')}
          ${field('favorite_store','Улюблений магазин')}
          ${field('email','Email')}
          ${field('preferences','Вподобання')}
        </div>
        <button>Зберегти налаштування</button>
      </form>
    </div>

    <div class="card cleanup-settings-card">
      <div class="section-title-row"><div><span class="pill">Автоматичне очищення</span><h2>Неактивні клієнти</h2><p class="small">Клієнт видаляється лише тоді, коли одночасно немає покупок і не змінювався баланс зірок протягом заданого часу. Чеки залишаються в обліку без персональної привʼязки.</p></div><strong>${num(cleanupSummary.total)} кандидатів</strong></div>
      <div class="cleanup-summary-grid">
        <div><span>Баланс 0</span><b>${num(cleanupSummary.zero_balance)}</b></div>
        <div><span>Баланс у заданому діапазоні</span><b>${num(cleanupSummary.positive_balance)}</b></div>
        <div><span>Остання перевірка</span><b>${cleanup.lastRunAt?dt(cleanup.lastRunAt):'ще не запускалась'}</b></div>
        <div><span>Видалено минулого разу</span><b>${num(cleanup.lastDeletedCount||0)}</b></div>
      </div>
      <form id="clientCleanupForm" class="form-grid cleanup-settings-form">
        <label class="checkline"><input type="checkbox" name="enabled" ${cleanup.enabled!==false?'checked':''}> Увімкнути автоматичне очищення</label>
        <label class="checkline"><input type="checkbox" name="deletePositiveBalance" ${cleanup.deletePositiveBalance!==false?'checked':''}> Видаляти з додатним балансом</label>
        <label class="admin-field"><span>Неактивність для балансу від 1, днів</span><input name="positiveInactiveDays" type="number" min="1" max="3650" step="1" value="${esc(cleanup.positiveInactiveDays??183)}" required></label>
        <label class="admin-field"><span>Мінімальний баланс, ★</span><input name="positiveMinBalance" type="number" min="1" step="1" value="${esc(cleanup.positiveMinBalance??1)}" required></label>
        <label class="admin-field"><span>Максимальний баланс, ★</span><input name="positiveMaxBalance" type="number" min="0" step="1" value="${esc(cleanup.positiveMaxBalance??0)}"><small>0 — без верхнього обмеження</small></label>
        <label class="checkline"><input type="checkbox" name="deleteZeroBalance" ${cleanup.deleteZeroBalance!==false?'checked':''}> Видаляти з балансом 0</label>
        <label class="admin-field"><span>Неактивність для балансу 0, днів</span><input name="zeroInactiveDays" type="number" min="1" max="3650" step="1" value="${esc(cleanup.zeroInactiveDays??183)}" required></label>
        <div class="admin-help">За замовчуванням 183 дні — приблизно пів року. Автоматична перевірка виконується під час запуску сервера та один раз на добу.</div>
        <div class="form-actions"><button class="primary">Зберегти правила</button><button type="button" class="danger" id="runClientCleanup">Перевірити й очистити зараз</button></div>
      </form>
    </div>
  </div>`;
  const form=$('#bonusSettingsForm');
  form.onsubmit=async ev=>{ev.preventDefault();const fd=new FormData(form);const requiredFields=fd.getAll('requiredFields');const body={value:{enabled:fd.has('enabled'),stars:Number(fd.get('stars')||0),grantWhen:fd.get('grantWhen')||'immediately',requiredFields}};await api('/api/admin/settings/profile_bonus',{method:'PUT',body:JSON.stringify(body)});alert('Налаштування бонусу збережено');settings();};
  const cleanupForm=$('#clientCleanupForm');
  cleanupForm.onsubmit=async ev=>{ev.preventDefault();const fd=new FormData(cleanupForm);const maxBalance=Number(fd.get('positiveMaxBalance')||0);const body={value:{enabled:fd.has('enabled'),deletePositiveBalance:fd.has('deletePositiveBalance'),positiveInactiveDays:Number(fd.get('positiveInactiveDays')||183),positiveMinBalance:Number(fd.get('positiveMinBalance')||1),positiveMaxBalance:maxBalance>0?maxBalance:null,deleteZeroBalance:fd.has('deleteZeroBalance'),zeroInactiveDays:Number(fd.get('zeroInactiveDays')||183)}};await api('/api/admin/settings/client_cleanup',{method:'PUT',body:JSON.stringify(body)});alert('Правила автоматичного очищення збережено');settings();};
  $('#runClientCleanup').onclick=async()=>{if(!confirm(`Перевірити клієнтів зараз? За поточними правилами кандидатів: ${num(cleanupSummary.total)}.`))return;const result=await api('/api/admin/settings/client-cleanup/run',{method:'POST',body:'{}'});if(result.skipped)alert('Автоматичне очищення вимкнене. Спочатку увімкніть і збережіть правило.');else alert(`Перевірку завершено. Видалено клієнтів: ${num(result.deleted||0)}.`);settings();};
}

async function support(){
  title.textContent='Підтримка';
  const {tickets}=await api('/api/admin/support/tickets');
  content.innerHTML=`<div class="support-board">${tickets.map(t=>`<article class="card support-admin-card"><div class="support-head"><div><span class="ticket-id">#${t.id}</span><h3>${esc(t.subject)}</h3><p class="small">${esc(t.client_name||'Клієнт')} · ${esc(t.phone||'')} · ${esc(t.card_number||'')}</p></div><span class="pill">${esc(t.status)}</span></div><div class="support-thread">${(t.messages||[]).map(m=>`<div class="support-message ${m.sender_type}"><b>${m.sender_type==='client'?'Клієнт':'Адмін'}</b><p>${esc(m.message)}</p><span>${dt(m.created_at)}</span></div>`).join('')}</div><form class="adminReply" data-ticket="${t.id}"><textarea name="message" placeholder="Відповідь клієнту" required></textarea><div class="actions"><button class="primary">Відповісти</button><button type="button" data-close-ticket="${t.id}">Закрити</button></div></form></article>`).join('')||'<div class="card">Звернень немає</div>'}</div>`;
  $$('.adminReply').forEach(f=>f.onsubmit=async e=>{e.preventDefault();const fd=new FormData(f);await api(`/api/admin/support/tickets/${f.dataset.ticket}/reply`,{method:'POST',body:JSON.stringify({message:fd.get('message')})});support();});
  $$('[data-close-ticket]').forEach(b=>b.onclick=async()=>{await api(`/api/admin/support/tickets/${b.dataset.closeTicket}`,{method:'PATCH',body:JSON.stringify({status:'closed'})});support();});
}

async function admins(){
  title.textContent='Адміністратори';
  const {users}=await api('/api/admin/users');
  const permissionLabels={
    dashboard:'Аналітика',clients:'Клієнти',stores:'Магазини',rewards:'Товари за зірки',offers:'Пропозиції та ціни',
    challenges:'Челенджі',stamps:'Накопичувальні',news:'Новини',qrs:'QR-коди',coupons:'Знижки клієнтам',
    support:'Підтримка',settings:'Налаштування',audit:'Журнал дій'
  };
  const perms=Object.keys(permissionLabels);
  const checks=(selected=[])=>perms.map(p=>`<label class="checkline"><input type="checkbox" name="permissions" value="${p}" ${selected.includes(p)?'checked':''}> ${permissionLabels[p]}</label>`).join('');
  content.innerHTML=`
    <div class="card">
      <h2>Призначити адміністратора</h2>
      <p class="small">Для Telegram-адмінки можна вказати Telegram ID. Для ПК-адмінки обовʼязково задайте логін і пароль. Якщо Telegram ID не вказаний, система створить веб-адміна тільки для входу з браузера.</p>
      <form id="adminForm" class="form-grid">
        <input name="telegram_id" placeholder="Telegram ID, якщо потрібен вхід через /admin" inputmode="numeric">
        <input name="login" placeholder="Логін для ПК-адмінки">
        <input name="password" type="password" placeholder="Пароль для ПК-адмінки">
        <input name="name" placeholder="Імʼя адміністратора">
        <input name="username" placeholder="Telegram username без @">
        <div class="permission-grid">${checks(perms.filter(p=>!['settings','audit'].includes(p)))}</div>
        <button class="primary">Додати Admin</button>
      </form>
    </div>
    <div class="admin-user-grid">
      ${users.map(u=>`<article class="card admin-user-card" data-admin-id="${u.id}">
        <div class="support-head"><div><h3>${esc(u.name||'—')}</h3><p class="small">Telegram ID: ${esc(u.telegram_id||'—')}${u.login?` · логін: ${esc(u.login)}`:''}${u.username?` · @${esc(u.username)}`:''}</p></div><span class="pill">${u.role==='owner'?'Owner':'Admin'}</span></div>
        ${u.role==='owner'
          ? `<p class="small">Owner має повний доступ. У браузері може входити логіном і паролем, якщо вони задані.</p>`
          : `<form class="adminEditForm">
              <input name="name" value="${esc(u.name||'')}" placeholder="Імʼя">
              <input name="username" value="${esc(u.username||'')}" placeholder="Telegram username">
              <input name="login" value="${esc(u.login||'')}" placeholder="Логін для ПК">
              <input name="password" type="password" placeholder="Новий пароль, якщо треба змінити">
              <div class="permission-grid">${checks(u.permissions||[])}</div>
              <label class="checkline"><input type="checkbox" name="is_active" ${u.is_active?'checked':''}> Доступ активний</label>
              <div class="actions"><button class="primary">Зберегти права</button><button type="button" class="danger" data-delete-admin="${u.id}">Видалити Admin</button></div>
            </form>`}
      </article>`).join('')}
    </div>`;
  $('#adminForm').onsubmit=async e=>{
    e.preventDefault();
    const fd=new FormData(e.currentTarget);
    const permissions=fd.getAll('permissions');
    if(!permissions.length) return alert('Оберіть хоча б один доступний розділ.');
    await api('/api/admin/users',{method:'POST',body:JSON.stringify({telegram_id:String(fd.get('telegram_id')||'').trim(),login:String(fd.get('login')||'').trim(),password:String(fd.get('password')||''),name:fd.get('name'),username:fd.get('username'),permissions})});
    admins();
  };
  $$('.adminEditForm').forEach(form=>form.onsubmit=async e=>{
    e.preventDefault();
    const card=form.closest('[data-admin-id]');
    const fd=new FormData(form);
    const permissions=fd.getAll('permissions');
    const is_active=fd.has('is_active');
    if(is_active&&!permissions.length) return alert('Для активного Admin оберіть хоча б один розділ.');
    await api(`/api/admin/users/${card.dataset.adminId}`,{method:'PATCH',body:JSON.stringify({name:fd.get('name'),username:fd.get('username'),login:String(fd.get('login')||'').trim(),password:String(fd.get('password')||''),permissions,is_active})});
    admins();
  });
  $$('[data-delete-admin]').forEach(btn=>btn.onclick=async()=>{
    if(!confirm('Видалити цього адміністратора та завершити його активні сесії?')) return;
    await api(`/api/admin/users/${btn.dataset.deleteAdmin}`,{method:'DELETE'});
    admins();
  });
}

async function qrs(){
  title.textContent='QR за зірки';
  const {qrs: qrItems}=await api('/api/admin/reward-qrs');
  content.innerHTML=`<div class="card"><table><thead><tr><th>Дата</th><th>Клієнт</th><th>Товар</th><th>Код</th><th>Зірки</th><th>Тип</th><th>Статус</th><th>Діє до</th></tr></thead><tbody>${qrItems.map(q=>`<tr><td>${dt(q.created_at)}</td><td>${esc(q.client_name||q.phone)}</td><td>${esc(q.reward_name)}</td><td><b>${esc(q.token)}</b></td><td>${num(q.stars_reserved)} ★</td><td>${q.source_type==='stamp_program'?'накопичувальна':'за зірки'}</td><td><span class="pill">${esc(q.status)}</span></td><td>${dt(q.expires_at)}</td></tr>`).join('') || '<tr><td colspan="8">Поки QR не створювались</td></tr>'}</tbody></table></div>`;
}
async function audit(){
  title.textContent='Журнал дій';
  const {logs}=await api('/api/admin/audit');
  content.innerHTML=`<div class="card"><table><thead><tr><th>Дата</th><th>Хто</th><th>Дія</th><th>Обʼєкт</th><th>Опис</th></tr></thead><tbody>${logs.map(l=>`<tr><td>${dt(l.created_at)}</td><td>${esc(l.actor_type)} ${esc(l.actor_id||'')}</td><td>${esc(l.action)}</td><td>${esc(l.entity_type||'')} ${esc(l.entity_id||'')}</td><td><pre>${esc(l.payload_json||'')}</pre></td></tr>`).join('') || '<tr><td colspan="5">Журнал порожній</td></tr>'}</tbody></table></div>`;
}
function syncActiveNavigation(){
  $$('[data-tab]').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));
}
function enhanceMobileTables(root=content){
  root.querySelectorAll('table').forEach(table=>{
    table.classList.add('mobile-cards');
    const headers=[...table.querySelectorAll('thead th')].map(th=>th.textContent.trim());
    table.querySelectorAll('tbody tr').forEach(row=>{
      [...row.children].forEach((cell,index)=>{
        if(cell.tagName==='TD'&&!cell.hasAttribute('colspan')) cell.dataset.label=headers[index]||'';
      });
    });
  });
}
const mobileTableObserver=new MutationObserver(()=>requestAnimationFrame(()=>enhanceMobileTables()));
mobileTableObserver.observe(content,{childList:true,subtree:true});
function closeMobileMenu(){ $('#mobileMenuOverlay')?.classList.add('hidden'); }
async function render(){
  liveState.signature='';
  syncActiveNavigation();
  try{
    if(tab==='dashboard') await dashboard();
    if(tab==='clients') { if(clientDetailState?.id) await clientDetails(clientDetailState.id); else await clients(); }
    if(tab==='stores') await stores();
    if(tab==='rewards') await rewards();
    if(tab==='star-exclusions') await starExclusions();
    if(tab==='offers') await offers();
    if(tab==='challenges') await challenges();
    if(tab==='stamps') await stamps();
    if(tab==='banners') await banners();
    if(tab==='news') await news();
    if(tab==='qrs') await qrs();
    if(tab==='support') await support();
    if(tab==='admins') await admins();
    if(tab==='settings') await settings();
    if(tab==='audit') await audit();
  } catch(e){ if(e.status===401){showLogin(); return;} content.innerHTML=`<div class="card"><h2>Помилка</h2><p>${esc(e.message)}</p></div>`; }
  enhanceMobileTables();
  syncActiveNavigation();
}
$$('[data-tab]').forEach(b=>b.onclick=()=>{tab=b.dataset.tab;closeMobileMenu();render();});
$('#mobileMenuButton')?.addEventListener('click',()=>$('#mobileMenuOverlay')?.classList.remove('hidden'));
$('#mobileMoreButton')?.addEventListener('click',()=>$('#mobileMenuOverlay')?.classList.remove('hidden'));
$('#mobileMenuClose')?.addEventListener('click',closeMobileMenu);
$('#mobileMenuBackdrop')?.addEventListener('click',closeMobileMenu);
$('#mobileSaveKey')?.addEventListener('click',()=>{const v=$('#mobileApiKey')?.value||'';localStorage.setItem('starclub_admin_key',v);if(keyInput)keyInput.value=v;adminToken='';localStorage.removeItem('starclub_admin_session');closeMobileMenu();bootstrapAdmin();});
$('#saveKey')?.addEventListener('click',()=>{localStorage.setItem('starclub_admin_key',keyInput?.value||'');adminToken='';localStorage.removeItem('starclub_admin_session');hideLogin();bootstrapAdmin();});
$('#keyAdminLogin')?.addEventListener('click',()=>{const v=$('#loginApiKey')?.value.trim();if(!v)return;localStorage.setItem('starclub_admin_key',v);if(keyInput)keyInput.value=v;adminToken='';localStorage.removeItem('starclub_admin_session');hideLogin();bootstrapAdmin();});
$('#telegramAdminLogin')?.addEventListener('click',async()=>{
  try {
    const initData = tg?.initData || '';
    const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
    if (!initData && !isLocal) {
      throw new Error('Відкрийте адмін-панель через команду /admin у Telegram-боті.');
    }
    const payload = { initData };
    if (!initData && isLocal) {
      payload.devUser = { id: '111111111', first_name: 'Local Owner' };
    }
    const data = await fetch('/api/admin/auth/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(async (r) => {
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        const messages = {
          ADMIN_ACCESS_DENIED: 'Ваш Telegram ID не має доступу до адмін-панелі.',
          TELEGRAM_AUTH_FAILED: 'Не вдалося підтвердити Telegram-вхід. Відкрийте панель повторно через /admin.',
          TELEGRAM_USER_REQUIRED: 'Telegram не передав дані користувача. Відкрийте панель через кнопку бота.'
        };
        throw new Error(messages[d.error] || d.error || 'LOGIN_FAILED');
      }
      return d;
    });
    adminToken = data.session.token;
    localStorage.setItem('starclub_admin_session', adminToken);
    localStorage.removeItem('starclub_admin_key');
    if(keyInput) keyInput.value = '';
    admin = data.admin;
    hideLogin();
    applyAdminVisibility();
    render();
  } catch (e) {
    alert(e.message);
  }
});
$('#passwordAdminLogin')?.addEventListener('submit',async(e)=>{
  e.preventDefault();
  try{
    const fd=new FormData(e.currentTarget);
    const data=await fetch('/api/admin/auth/password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({login:fd.get('login'),password:fd.get('password')})}).then(async r=>{const d=await r.json().catch(()=>({})); if(!r.ok) throw new Error(d.error||'LOGIN_FAILED'); return d;});
    adminToken=data.session.token;
    localStorage.setItem('starclub_admin_session',adminToken);
    localStorage.removeItem('starclub_admin_key');
    if(keyInput) keyInput.value='';
    admin=data.admin;
    hideLogin();
    applyAdminVisibility();
    render();
  }catch(error){
    const message=error.message==='INVALID_CREDENTIALS'?'Невірний логін або пароль.':(error.message||'Не вдалося увійти');
    alert(message);
  }
});
function applyAdminVisibility(){
  const owner = admin?.role === 'owner' || Boolean(key());
  const permissions = new Set(admin?.permissions || []);
  $$('[data-owner-only]').forEach(el=>el.style.display=owner?'':'none');
  $$('[data-tab]').forEach(el=>{
    if(owner) return el.style.display='';
    const requiredPermission = el.dataset.permission || el.dataset.tab;
    el.style.display = permissions.has(requiredPermission) ? '' : 'none';
  });
}
async function bootstrapAdmin(){
  try{
    const data=await api('/api/admin/me',{silentError:true});
    admin=data.admin;
    hideLogin();
    applyAdminVisibility();
    render();
  }catch(e){
    if(e.status===401){
      adminToken='';
      localStorage.removeItem('starclub_admin_session');
    }
    showLogin();
    console.error('STARCLUB ADMIN BOOTSTRAP FAILED',e);
  }
}

function setupAdminMobileKeyboard(){
  const fields='input,textarea,select';
  document.addEventListener('focusin',event=>{
    if(!event.target.matches(fields)) return;
    document.body.classList.add('keyboard-open');
    setTimeout(()=>event.target.scrollIntoView({behavior:'smooth',block:'center'}),180);
  });
  document.addEventListener('focusout',()=>setTimeout(()=>{if(!document.activeElement?.matches?.(fields))document.body.classList.remove('keyboard-open');},80));
  document.addEventListener('pointerdown',event=>{
    if(!document.body.classList.contains('keyboard-open')) return;
    if(event.target.closest(fields)||event.target.closest('button')) return;
    document.activeElement?.blur?.();
  });
}
setupAdminMobileKeyboard();
startAdminLiveRefresh();
bootstrapAdmin();
