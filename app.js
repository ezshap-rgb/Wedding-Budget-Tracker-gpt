const STORAGE_KEY = 'wedding-budget-v1';
const FAMILY_A = 'שפירא';
const FAMILY_B = 'חגאג';
const GOOGLE_APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbyOvwwAU84vlGMoz1K17YgTL018z4ffQb4lu0LAOFub1ytx3gkDHNAgX43y0MRv8C3I/exec';
const defaultState = {
  settings: { familyA: FAMILY_A, familyB: FAMILY_B, currency: 'ILS', apiUrl: GOOGLE_APPS_SCRIPT_URL },
  expenses: [],
  contributions: []
};
let state = loadState();
let activeFilter = 'all';
let editingExpenseId = null;
let editingContributionId = null;
let toastTimer;

const $ = (selector) => document.querySelector(selector);
const money = (value) => new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 }).format(Number(value) || 0);
const uid = (prefix) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const today = () => new Date().toISOString().slice(0, 10);

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return saved ? { ...defaultState, ...saved, settings: { ...defaultState.settings, ...(saved.settings || {}), familyA: FAMILY_A, familyB: FAMILY_B, currency: 'ILS', apiUrl: GOOGLE_APPS_SCRIPT_URL } } : structuredClone(defaultState);
  } catch (error) {
    return structuredClone(defaultState);
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function expenseShares(expense) {
  const total = Number(expense.amount) || 0;
  // Keep reading older two-family guest-split records.
  if (expense.splitMethod === 'guests') {
    const a = Number(expense.guestsA) || 0;
    const b = Number(expense.guestsB) || 0;
    const count = a + b;
    return count ? { a: total * a / count, b: total * b / count } : { a: total / 2, b: total / 2 };
  }
  if (expense.splitMethod === 'familyA') return { a: total, b: 0 };
  if (expense.splitMethod === 'familyB') return { a: 0, b: total };
  if (expense.splitMethod === 'custom') return { a: Number(expense.customA) || 0, b: Number(expense.customB) || 0 };
  return { a: total / 2, b: total / 2 };
}

function expensePaid(expenseId) {
  return state.contributions.filter((item) => item.expenseId === expenseId).reduce((sum, item) => sum + Number(item.amount || 0), 0);
}

function totals() {
  const targets = state.expenses.reduce((result, expense) => {
    const shares = expenseShares(expense);
    result.a += shares.a;
    result.b += shares.b;
    result.planned += Number(expense.amount) || 0;
    result.paid += expensePaid(expense.id);
    return result;
  }, { a: 0, b: 0, planned: 0, paid: 0 });
  const vendorPayments = state.contributions.filter((item) => item.expenseId);
  targets.contributed = vendorPayments.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  targets.givenA = vendorPayments.filter((item) => item.family === 'A').reduce((sum, item) => sum + Number(item.amount || 0), 0);
  targets.givenB = vendorPayments.filter((item) => item.family === 'B').reduce((sum, item) => sum + Number(item.amount || 0), 0);
  return targets;
}

function render() {
  renderSettings();
  renderFamilyCards();
  renderExpenses();
  updateExpenseOptions();
}

function renderSettings() {
  const { familyA, familyB } = { familyA: FAMILY_A, familyB: FAMILY_B };
  $('#familyAName').textContent = familyA;
  $('#familyBName').textContent = familyB;
  $('#familyAAvatar').textContent = familyA.trim().charAt(0).toUpperCase() || 'A';
  $('#familyBAvatar').textContent = familyB.trim().charAt(0).toUpperCase() || 'B';
  $('#splitMethod').options[1].textContent = `100% ${familyA}`;
  $('#splitMethod').options[2].textContent = `100% ${familyB}`;
  $('#customAFLabel').textContent = `סכום ${familyA}`;
  $('#customBFLabel').textContent = `סכום ${familyB}`;
  $('#paymentFamily').options[0].textContent = familyA;
  $('#paymentFamily').options[1].textContent = familyB;
  const hasApi = Boolean(state.settings.apiUrl);
  $('#syncStatus').className = `sync-status${hasApi ? ' connected' : ''}`;
  $('#syncStatus').innerHTML = `<span class="status-dot"></span> ${hasApi ? 'Google Sheets מחובר' : 'מצב הדגמה'}`;
}

function renderFamilyCards() {
  const data = totals();
  const update = (prefix, target, given) => {
    $(`#${prefix}Target`).textContent = money(target);
    $(`#${prefix}Given`).textContent = money(given);
    $(`#${prefix}Remaining`).textContent = money(Math.max(0, target - given));
    $(`#${prefix}Progress`).style.width = `${target ? Math.min(100, given / target * 100) : 0}%`;
  };
  update('familyA', data.a, data.givenA);
  update('familyB', data.b, data.givenB);
}

function visibleExpenses() {
  const query = ($('#searchInput').value || '').trim().toLowerCase();
  return state.expenses.filter((expense) => {
    const paid = expensePaid(expense.id);
    const matchesFilter = activeFilter === 'all' || (activeFilter === 'paid' ? paid >= Number(expense.amount || 0) : paid < Number(expense.amount || 0));
    const matchesQuery = !query || [expense.name, expense.vendor, expense.notes].join(' ').toLowerCase().includes(query);
    return matchesFilter && matchesQuery;
  }).sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999'));
}

function paymentTotals(expenseId) {
  return state.contributions.filter((item) => item.expenseId === expenseId).reduce((result, item) => {
    const amount = Number(item.amount) || 0;
    if (item.family === 'B') result.b += amount;
    else result.a += amount;
    result.total += amount;
    return result;
  }, { a: 0, b: 0, total: 0 });
}

function renderExpenses() {
  const rows = $('#expenseRows');
  rows.innerHTML = '';
  const expenses = visibleExpenses();
  const paidExpenses = state.expenses.filter((expense) => paymentTotals(expense.id).total >= Number(expense.amount || 0) && Number(expense.amount || 0) > 0).length;
  const openExpenses = state.expenses.length - paidExpenses;
  $('#emptyState').style.display = expenses.length ? 'none' : 'block';
  $('#countAll').textContent = state.expenses.length;
  $('#countPaid').textContent = paidExpenses;
  $('#countOpen').textContent = openExpenses;

  expenses.forEach((expense) => {
    const paid = paymentTotals(expense.id);
    const total = Number(expense.amount) || 0;
    const outstanding = Math.max(0, total - paid.total);
    const status = paid.total >= total && total > 0 ? 'שולם' : paid.total > 0 ? 'חלקי' : 'מתוכנן';
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><div class="expense-name">${escapeHtml(expense.name)}</div><div class="expense-vendor">${escapeHtml(expense.vendor || '')}</div></td><td class="expense-date ${expense.dueDate && expense.dueDate < today() && outstanding > 0 ? 'overdue' : ''}">${expense.dueDate ? formatDate(expense.dueDate) : '—'}</td><td><span class="split-pill">${splitLabel(expense, expenseShares(expense))}</span></td><td class="align-right money">${money(total)}</td><td class="align-right money paid-money">${money(paid.total)}</td><td class="align-right money paid-money">${money(paid.a)}</td><td class="align-right money paid-money">${money(paid.b)}</td><td class="align-right money ${outstanding > 0 ? 'outstanding-money' : 'paid-money'}">${money(outstanding)}</td><td><span class="status-pill status-${statusClass(status)}">${status}</span></td><td><div class="action-buttons"><button class="row-actions" data-expense-payment="${expense.id}" type="button" aria-label="הוספת תשלום עבור ${escapeHtml(expense.name)}">＋</button><button class="row-actions" data-expense-edit="${expense.id}" type="button" aria-label="עריכת ${escapeHtml(expense.name)}">✎</button><button class="row-actions delete-action" data-expense-delete="${expense.id}" type="button" aria-label="מחיקת ${escapeHtml(expense.name)}">×</button></div></td>`;
    rows.appendChild(tr);
  });
}

function splitLabel(expense, shares) {
  if (expense.amountMethod === 'guests') {
    const family = expense.splitMethod === 'familyA' ? FAMILY_A : expense.splitMethod === 'familyB' ? FAMILY_B : '';
    return `${family ? `${family} · ` : ''}${expense.guestCount || 0} × ${money(expense.perGuest)} לאורח`;
  }
  if (expense.splitMethod === 'guests') return `${expense.guestsA || 0} / ${expense.guestsB || 0} אורחים`;
  if (expense.splitMethod === 'familyA') return FAMILY_A;
  if (expense.splitMethod === 'familyB') return FAMILY_B;
  if (expense.splitMethod === 'custom') return `${money(shares.a)} / ${money(shares.b)}`;
  return '50 / 50';
}

function statusClass(status) {
  return { 'שולם': 'paid', 'חלקי': 'partial', 'מתוכנן': 'planned' }[status] || 'planned';
}

function formatDate(value, short = false) {
  if (!value) return '—';
  const date = new Date(`${value}T12:00:00`);
  return new Intl.DateTimeFormat('he-IL', { month: short ? 'short' : 'short', day: 'numeric', year: short ? undefined : 'numeric' }).format(date);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function openExpenseDialog(expenseId = null) {
  const form = $('#expenseForm');
  form.reset();
  editingExpenseId = expenseId;
  const expense = expenseId ? state.expenses.find((item) => item.id === expenseId) : null;
  $('#expenseDialogEyebrow').textContent = expense ? 'עדכון בתוכנית' : 'הוספה לתוכנית';
  $('#expenseDialogTitle').textContent = expense ? 'עריכת הוצאה' : 'הוצאה חדשה';
  if (expense) {
    const legacyGuestSplit = expense.splitMethod === 'guests';
    const legacyShares = expenseShares(expense);
    const splitMethod = legacyGuestSplit ? 'custom' : expense.splitMethod;
    const amountMethod = legacyGuestSplit ? 'fixed' : (expense.amountMethod || 'fixed');
    Object.entries({ name: expense.name, vendor: expense.vendor, amount: expense.amount, dueDate: expense.dueDate, amountMethod, splitMethod, guestCount: expense.guestCount, perGuest: expense.perGuest, customA: legacyGuestSplit ? legacyShares.a : expense.customA, customB: legacyGuestSplit ? legacyShares.b : expense.customB, notes: expense.notes }).forEach(([key, value]) => { if (form.elements[key]) form.elements[key].value = value ?? ''; });
  }
  $('#expenseError').textContent = '';
  toggleSplitDetails();
  $('#expenseDialog').showModal();
  form.elements.name.focus();
}

function openPaymentDialog(expenseId = '', contributionId = null) {
  const form = $('#paymentForm');
  form.reset();
  editingContributionId = contributionId;
  const contribution = contributionId ? state.contributions.find((item) => item.id === contributionId) : null;
  $('#paymentDialogEyebrow').textContent = contribution ? 'עדכון תשלום' : 'רישום תשלום';
  $('#paymentDialogTitle').textContent = contribution ? 'עריכת תשלום' : 'הוספת תשלום';
  $('#paymentError').textContent = '';
  if (contribution) {
    const type = 'שולם';
    Object.entries({ family: contribution.family, amount: contribution.amount, date: contribution.date, type, expenseId: contribution.expenseId, note: contribution.note }).forEach(([key, value]) => { if (form.elements[key]) form.elements[key].value = value ?? ''; });
    expenseId = contribution.expenseId || '';
  } else {
    form.elements.date.value = today();
  }
  updateExpenseOptions(expenseId);
  $('#paymentDialog').showModal();
  form.elements.amount.focus();
}

function updateExpenseOptions(selected = '') {
  const select = $('#paymentExpense');
  if (!select) return;
  select.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = state.expenses.length ? 'בחירת הוצאה / ספק' : 'יש להוסיף הוצאה לפני תשלום';
  placeholder.disabled = true;
  placeholder.selected = !selected;
  select.appendChild(placeholder);
  state.expenses.forEach((expense) => {
    const option = document.createElement('option');
    option.value = expense.id;
    option.textContent = expense.name;
    option.selected = expense.id === selected;
    select.appendChild(option);
  });
}

function toggleSplitDetails() {
  const amountMethod = $('#amountMethod').value;
  const splitMethod = $('#splitMethod').value;
  $('#guestDetails').classList.toggle('visible', amountMethod === 'guests');
  $('#customDetails').classList.toggle('visible', splitMethod === 'custom');
  $('#expenseAmount').readOnly = amountMethod === 'guests';
  if (amountMethod === 'guests') updateGuestAmount();
}

function updateGuestAmount() {
  if ($('#amountMethod').value !== 'guests') return;
  const guestCount = Number($('#expenseForm').elements.guestCount.value) || 0;
  const rate = Number($('#expenseForm').elements.perGuest.value) || 0;
  $('#expenseAmount').value = guestCount * rate ? (guestCount * rate).toFixed(2) : '';
}

function cancelDialogSubmit(event) {
  if (event.submitter?.value !== 'cancel') return false;
  event.preventDefault();
  event.currentTarget.closest('dialog')?.close('cancel');
  return true;
}

function handleExpenseSubmit(event) {
  if (cancelDialogSubmit(event)) return;
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form).entries());
  const amount = Number(data.amount) || 0;
  const paidAmount = Number(data.paidAmount) || 0;
  const error = $('#expenseError');
  if (!data.name.trim() || amount <= 0) { error.textContent = 'נא להזין שם הוצאה וסכום גדול מאפס.'; return; }
  if (data.amountMethod === 'guests' && ((Number(data.guestCount) || 0) <= 0 || (Number(data.perGuest) || 0) <= 0)) { error.textContent = 'נא להזין מספר אורחים ומחיר לאורח.'; return; }
  if (data.splitMethod === 'custom' && Math.abs((Number(data.customA) || 0) + (Number(data.customB) || 0) - amount) > 0.01) { error.textContent = 'הסכומים המותאמים צריכים להיות שווים לסכום המתוכנן.'; return; }
  const existing = editingExpenseId ? state.expenses.find((item) => item.id === editingExpenseId) : null;
  const existingPaid = existing ? expensePaid(existing.id) : 0;
  if (paidAmount < 0 || paidAmount > Math.max(0, amount - existingPaid) + 0.01) { error.textContent = 'סכום התשלום הנוסף אינו יכול להיות גדול מהיתרה של ההוצאה.'; return; }
  const expense = { id: existing?.id || uid('expense'), createdAt: existing?.createdAt || new Date().toISOString(), name: data.name.trim(), vendor: data.vendor.trim(), amount, dueDate: data.dueDate, amountMethod: data.amountMethod || 'fixed', splitMethod: data.splitMethod, guestCount: Number(data.guestCount) || 0, perGuest: Number(data.perGuest) || 0, customA: Number(data.customA) || 0, customB: Number(data.customB) || 0, notes: data.notes.trim() };
  const immediatePayment = paidAmount > 0 ? { id: uid('contribution'), createdAt: new Date().toISOString(), date: today(), family: data.paidBy || 'A', amount: paidAmount, type: 'שולם', expenseId: expense.id, note: 'שולם בעת הוספת ההוצאה' } : null;
  const index = state.expenses.findIndex((item) => item.id === expense.id);
  if (index >= 0) state.expenses[index] = expense; else state.expenses.push(expense);
  if (immediatePayment) state.contributions.push(immediatePayment);
  saveState();
  $('#expenseDialog').close();
  editingExpenseId = null;
  render();
  const command = { type: existing ? 'updateExpense' : 'addExpense', expense };
  if (immediatePayment) command.initialContribution = immediatePayment;
  queueSync(command);
  showToast(existing ? (immediatePayment ? 'ההוצאה והתשלום עודכנו' : 'ההוצאה עודכנה') : (immediatePayment ? 'ההוצאה והתשלום נוספו' : 'ההוצאה נוספה לתוכנית'));
}

function handlePaymentSubmit(event) {
  if (cancelDialogSubmit(event)) return;
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form).entries());
  const amount = Number(data.amount) || 0;
  if (amount <= 0) { $('#paymentError').textContent = 'נא להזין סכום גדול מאפס.'; return; }
  if (!data.expenseId) { $('#paymentError').textContent = 'נא לבחור את ההוצאה או הספק שקיבל את התשלום.'; return; }
  const existing = editingContributionId ? state.contributions.find((item) => item.id === editingContributionId) : null;
  const contribution = { id: existing?.id || uid('contribution'), createdAt: existing?.createdAt || new Date().toISOString(), date: data.date || today(), family: data.family, amount, type: 'שולם', expenseId: data.expenseId, note: data.note.trim() };
  const index = state.contributions.findIndex((item) => item.id === contribution.id);
  if (index >= 0) state.contributions[index] = contribution; else state.contributions.push(contribution);
  saveState();
  $('#paymentDialog').close();
  editingContributionId = null;
  render();
  queueSync({ type: existing ? 'updateContribution' : 'addContribution', contribution });
  showToast(existing ? 'התשלום עודכן' : 'התשלום נרשם');
}

function deleteExpense(expenseId) {
  const expense = state.expenses.find((item) => item.id === expenseId);
  if (!expense) return;
  const linkedCount = state.contributions.filter((item) => item.expenseId === expenseId).length;
  const message = linkedCount ? `להסיר את ההוצאה "${expense.name}"? ${linkedCount} תשלומים מקושרים יימחקו גם הם.` : `להסיר את ההוצאה "${expense.name}"?`;
  if (!window.confirm(message)) return;
  state.expenses = state.expenses.filter((item) => item.id !== expenseId);
  state.contributions = state.contributions.filter((item) => item.expenseId !== expenseId);
  saveState();
  render();
  queueSync({ type: 'deleteExpense', expenseId });
  showToast('ההוצאה נמחקה');
}

function deleteContribution(contributionId) {
  const contribution = state.contributions.find((item) => item.id === contributionId);
  if (!contribution) return;
  if (!window.confirm(`למחוק את התשלום בסך ${money(contribution.amount)}?`)) return;
  state.contributions = state.contributions.filter((item) => item.id !== contributionId);
  saveState();
  render();
  queueSync({ type: 'deleteContribution', contributionId });
  showToast('התשלום נמחק');
}

function handleSettingsSubmit(event) {
  if (cancelDialogSubmit(event)) return;
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form).entries());
  state.settings = { familyA: FAMILY_A, familyB: FAMILY_B, currency: 'ILS', apiUrl: GOOGLE_APPS_SCRIPT_URL };
  saveState();
  $('#settingsDialog').close();
  render();
  showToast(state.settings.apiUrl ? 'ההגדרות נשמרו — מסנכרן עם Google Sheets' : 'ההגדרות נשמרו');
  if (state.settings.apiUrl) syncFromSheet();
}

function openSettings() {
  const form = $('#settingsForm');
  Object.entries(state.settings).forEach(([key, value]) => { if (form.elements[key]) form.elements[key].value = value; });
  $('#settingsError').textContent = '';
  $('#settingsDialog').showModal();
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3000);
}

function setSyncing(syncing) {
  const status = $('#syncStatus');
  if (syncing) { status.className = 'sync-status syncing'; status.innerHTML = '<span class="status-dot"></span> מסנכרן…'; }
  else renderSettings();
}

function queueSync(command) {
  if (!state.settings.apiUrl) return;
  setSyncing(true);
  fetch(state.settings.apiUrl, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(command) }).then(() => setTimeout(syncFromSheet, 700)).catch(() => { setSyncing(false); showToast('נשמר כאן, אך לא ניתן להתחבר ל־Google Sheets'); });
}

function syncFromSheet() {
  const url = state.settings.apiUrl;
  if (!url) return;
  setSyncing(true);
  const callbackName = `weddingSheetCallback_${Date.now()}`;
  const script = document.createElement('script');
  const cleanup = () => { delete window[callbackName]; script.remove(); };
  const timer = setTimeout(() => { cleanup(); setSyncing(false); showToast('לא ניתן לקרוא את Google Sheets — בדקו את הכתובת'); }, 9000);
  window[callbackName] = (payload) => {
    clearTimeout(timer); cleanup();
    if (payload && payload.ok) {
      const savedApiUrl = state.settings.apiUrl;
      if (payload.settings) {
        state.settings = { ...state.settings, familyA: FAMILY_A, familyB: FAMILY_B, currency: 'ILS', apiUrl: savedApiUrl };
      }
      state.expenses = Array.isArray(payload.expenses) ? payload.expenses : [];
      state.contributions = Array.isArray(payload.contributions) ? payload.contributions : [];
      saveState(); render(); setSyncing(false); showToast('Google Sheets מעודכן');
    } else { setSyncing(false); showToast('Google Sheets החזיר שגיאה'); }
  };
  script.onerror = () => { clearTimeout(timer); cleanup(); setSyncing(false); showToast('לא ניתן לקרוא את Google Sheets — בדקו את הכתובת'); };
  script.src = `${url}?action=read&callback=${callbackName}&t=${Date.now()}`;
  document.head.appendChild(script);
}

function bindEvents() {
  document.querySelectorAll('.modal button[value="cancel"]').forEach((button) => button.addEventListener('click', (event) => {
    event.preventDefault();
    button.closest('dialog')?.close('cancel');
  }));
  $('#addExpenseButton').addEventListener('click', openExpenseDialog);
  $('#emptyAddButton').addEventListener('click', openExpenseDialog);
  $('#topAddPaymentButton').addEventListener('click', () => openPaymentDialog());
  $('#settingsButton').addEventListener('click', openSettings);
  $('#expenseForm').addEventListener('submit', handleExpenseSubmit);
  $('#paymentForm').addEventListener('submit', handlePaymentSubmit);
  $('#settingsForm').addEventListener('submit', handleSettingsSubmit);
  $('#splitMethod').addEventListener('change', toggleSplitDetails);
  $('#amountMethod').addEventListener('change', toggleSplitDetails);
  ['guestCount', 'perGuest'].forEach((key) => $('#expenseForm').elements[key].addEventListener('input', updateGuestAmount));
  $('#searchInput').addEventListener('input', renderExpenses);
  document.querySelectorAll('.filter-button').forEach((button) => button.addEventListener('click', () => { activeFilter = button.dataset.filter; document.querySelectorAll('.filter-button').forEach((item) => item.classList.toggle('active', item === button)); renderExpenses(); }));
  $('#expenseRows').addEventListener('click', (event) => {
    const paymentButton = event.target.closest('[data-expense-payment]');
    const editButton = event.target.closest('[data-expense-edit]');
    const deleteButton = event.target.closest('[data-expense-delete]');
    if (paymentButton) openPaymentDialog(paymentButton.dataset.expensePayment);
    else if (editButton) openExpenseDialog(editButton.dataset.expenseEdit);
    else if (deleteButton) deleteExpense(deleteButton.dataset.expenseDelete);
    else {
      const contributionEdit = event.target.closest('[data-contribution-edit]');
      const contributionDelete = event.target.closest('[data-contribution-delete]');
      if (contributionEdit) openPaymentDialog('', contributionEdit.dataset.contributionEdit);
      else if (contributionDelete) deleteContribution(contributionDelete.dataset.contributionDelete);
    }
  });

}

bindEvents();
render();
if (state.settings.apiUrl) syncFromSheet();
