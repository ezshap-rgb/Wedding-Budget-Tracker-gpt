const STORAGE_KEY = 'wedding-budget-v1';
const FAMILY_A = 'שפירא';
const FAMILY_B = "חג'אג'";
const GOOGLE_APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbyOvwwAU84vlGMoz1K17YgTL018z4ffQb4lu0LAOFub1ytx3gkDHNAgX43y0MRv8C3I/exec';
const defaultState = {
  settings: { familyA: FAMILY_A, familyB: FAMILY_B, currency: 'ILS', apiUrl: GOOGLE_APPS_SCRIPT_URL },
  expenses: [],
  contributions: [],
  comments: []
};
let state = loadState();
let activeFilter = 'all';
let editingExpenseId = null;
let editingContributionId = null;
let editingCommentId = null;
let expandedExpenseIds = new Set();
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
  renderComments();
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
  });
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

function latestPaymentDate(expenseId) {
  return state.contributions.filter((item) => item.expenseId === expenseId && item.date).reduce((latest, item) => item.date > latest ? item.date : latest, '');
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
    const lastPaidDate = latestPaymentDate(expense.id);
    const expanded = expandedExpenseIds.has(expense.id);
    const splitText = splitLabel(expense, expenseShares(expense));
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><button class="expense-name-toggle" data-expense-toggle="${expense.id}" type="button" aria-expanded="${expanded}" aria-label="הצגת פרטי ${escapeHtml(expense.name)}"><span class="expense-name">${escapeHtml(expense.name)}</span><span class="expand-indicator" aria-hidden="true">⌄</span></button></td><td class="expense-date">${lastPaidDate ? formatDate(lastPaidDate) : '—'}</td><td><span class="split-pill">${escapeHtml(splitText)}</span></td><td class="align-right money">${money(total)}</td><td class="align-right money paid-money">${money(paid.total)}</td><td class="align-right money paid-money">${money(paid.a)}</td><td class="align-right money paid-money">${money(paid.b)}</td><td class="align-right money ${outstanding > 0 ? 'outstanding-money' : 'paid-money'}"><span class="mobile-outstanding-label">נותר לספק</span>${money(outstanding)}</td><td><span class="status-pill status-${statusClass(status)}">${status}</span></td><td><div class="action-buttons"><button class="row-actions" data-expense-payment="${expense.id}" type="button" aria-label="הוספת תשלום עבור ${escapeHtml(expense.name)}">＋</button><button class="row-actions" data-expense-edit="${expense.id}" type="button" aria-label="עריכת ${escapeHtml(expense.name)}">✎</button><button class="row-actions delete-action" data-expense-delete="${expense.id}" type="button" aria-label="מחיקת ${escapeHtml(expense.name)}">×</button></div></td>`;
    rows.appendChild(tr);
    const detailRow = document.createElement('tr');
    detailRow.className = `mobile-expansion${expanded ? ' is-open' : ''}`;
    detailRow.innerHTML = `<td colspan="10"><div class="expense-details"><div><small>תאריך תשלום</small><strong>${lastPaidDate ? formatDate(lastPaidDate) : '—'}</strong></div><div><small>חלוקה</small><strong>${escapeHtml(splitText)}</strong></div><div><small>מתוכנן</small><strong>${money(total)}</strong></div><div><small>סה״כ שולם</small><strong class="paid-money">${money(paid.total)}</strong></div><div><small>שפירא שילמו</small><strong class="paid-money">${money(paid.a)}</strong></div><div><small>חג'אג' שילמו</small><strong class="paid-money">${money(paid.b)}</strong></div><div><small>נותר לספק</small><strong class="${outstanding > 0 ? 'outstanding-money' : 'paid-money'}">${money(outstanding)}</strong></div><div><small>סטטוס</small><strong><span class="status-pill status-${statusClass(status)}">${status}</span></strong></div>${expense.notes ? `<div class="expense-detail-note"><small>הערות</small><strong>${escapeHtml(expense.notes)}</strong></div>` : ''}</div></td>`;
    rows.appendChild(detailRow);
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
  form.elements.paidDate.value = today();
  editingExpenseId = expenseId;
  const expense = expenseId ? state.expenses.find((item) => item.id === expenseId) : null;
  $('#expenseDialogEyebrow').textContent = expense ? 'עדכון בתוכנית' : 'הוספה לתוכנית';
  $('#expenseDialogTitle').textContent = expense ? 'עריכת הוצאה' : 'הוצאה חדשה';
  if (expense) {
    const legacyGuestSplit = expense.splitMethod === 'guests';
    const legacyShares = expenseShares(expense);
    const splitMethod = legacyGuestSplit ? 'custom' : expense.splitMethod;
    const amountMethod = legacyGuestSplit ? 'fixed' : (expense.amountMethod || 'fixed');
    Object.entries({ name: expense.name, amount: expense.amount, amountMethod, splitMethod, guestCount: expense.guestCount, perGuest: expense.perGuest, customA: legacyGuestSplit ? legacyShares.a : expense.customA, customB: legacyGuestSplit ? legacyShares.b : expense.customB, notes: expense.notes }).forEach(([key, value]) => { if (form.elements[key]) form.elements[key].value = value ?? ''; });
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
  placeholder.textContent = state.expenses.length ? 'בחירת הוצאה' : 'יש להוסיף הוצאה לפני תשלום';
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
  const expense = { id: existing?.id || uid('expense'), createdAt: existing?.createdAt || new Date().toISOString(), name: data.name.trim(), vendor: '', amount, dueDate: '', amountMethod: data.amountMethod || 'fixed', splitMethod: data.splitMethod, guestCount: Number(data.guestCount) || 0, perGuest: Number(data.perGuest) || 0, customA: Number(data.customA) || 0, customB: Number(data.customB) || 0, notes: data.notes.trim() };
  const immediatePayment = paidAmount > 0 ? { id: uid('contribution'), createdAt: new Date().toISOString(), date: data.paidDate || today(), family: data.paidBy || 'A', amount: paidAmount, type: 'שולם', expenseId: expense.id, note: 'שולם בעת הוספת ההוצאה' } : null;
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
  if (!data.expenseId) { $('#paymentError').textContent = 'נא לבחור את ההוצאה שקיבלה את התשלום.'; return; }
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
  expandedExpenseIds.delete(expenseId);
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

function renderComments() {
  const list = $('#generalCommentsList');
  if (!list) return;
  if (!state.comments.length) {
    list.innerHTML = '<p class="comments-empty">עדיין אין הערות כלליות.</p>';
    return;
  }
  list.innerHTML = state.comments.slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).map((comment) => `<article class="comment-card"><div class="comment-meta"><time>${formatDate(String(comment.createdAt || '').slice(0, 10), true)}</time><div class="comment-actions"><button type="button" class="comment-edit" data-comment-edit="${escapeHtml(comment.id)}" aria-label="עריכת הערה">✎</button><button type="button" class="comment-delete" data-comment-delete="${escapeHtml(comment.id)}" aria-label="מחיקת הערה">×</button></div></div><p>${escapeHtml(comment.text).replace(/\n/g, '<br>')}</p></article>`).join('');
}

function openComments() {
  editingCommentId = null;
  $('#commentsForm').reset();
  $('#commentSaveButton').textContent = 'שמירת הערה';
  $('#commentError').textContent = '';
  renderComments();
  $('#commentsDialog').showModal();
  $('#commentText').focus();
}

function handleCommentSubmit(event) {
  if (cancelDialogSubmit(event)) return;
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget).entries());
  const text = String(data.text || '').trim();
  if (!text) {
    $('#commentError').textContent = 'נא לכתוב הערה לפני השמירה.';
    return;
  }
  const existing = editingCommentId ? state.comments.find((item) => item.id === editingCommentId) : null;
  const comment = { id: existing?.id || uid('comment'), createdAt: existing?.createdAt || new Date().toISOString(), text };
  const index = state.comments.findIndex((item) => item.id === comment.id);
  if (index >= 0) state.comments[index] = comment; else state.comments.push(comment);
  const command = { type: existing ? 'updateComment' : 'addComment', comment };
  editingCommentId = null;
  saveState();
  $('#commentsDialog').close();
  render();
  queueSync(command);
  showToast(existing ? 'ההערה עודכנה' : 'ההערה נשמרה');
}

function editComment(commentId) {
  const comment = state.comments.find((item) => item.id === commentId);
  if (!comment) return;
  editingCommentId = commentId;
  $('#commentText').value = comment.text;
  $('#commentSaveButton').textContent = 'עדכון הערה';
  $('#commentError').textContent = '';
  $('#commentText').focus();
}

function deleteComment(commentId) {
  const comment = state.comments.find((item) => item.id === commentId);
  if (!comment) return;
  if (!window.confirm('למחוק את ההערה?')) return;
  state.comments = state.comments.filter((item) => item.id !== commentId);
  if (editingCommentId === commentId) {
    editingCommentId = null;
    $('#commentText').value = '';
    $('#commentSaveButton').textContent = 'שמירת הערה';
  }
  saveState();
  render();
  queueSync({ type: 'deleteComment', commentId });
  showToast('ההערה נמחקה');
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
      state.comments = Array.isArray(payload.comments) ? payload.comments : state.comments;
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
  $('#commentsButton').addEventListener('click', openComments);
  $('#settingsButton').addEventListener('click', openSettings);
  $('#expenseForm').addEventListener('submit', handleExpenseSubmit);
  $('#paymentForm').addEventListener('submit', handlePaymentSubmit);
  $('#settingsForm').addEventListener('submit', handleSettingsSubmit);
  $('#commentsForm').addEventListener('submit', handleCommentSubmit);
  $('#generalCommentsList').addEventListener('click', (event) => {
    const editButton = event.target.closest('[data-comment-edit]');
    const deleteButton = event.target.closest('[data-comment-delete]');
    if (editButton) editComment(editButton.dataset.commentEdit);
    else if (deleteButton) deleteComment(deleteButton.dataset.commentDelete);
  });
  $('#splitMethod').addEventListener('change', toggleSplitDetails);
  $('#amountMethod').addEventListener('change', toggleSplitDetails);
  ['guestCount', 'perGuest'].forEach((key) => $('#expenseForm').elements[key].addEventListener('input', updateGuestAmount));
  $('#searchInput').addEventListener('input', renderExpenses);
  document.querySelectorAll('.filter-button').forEach((button) => button.addEventListener('click', () => { activeFilter = button.dataset.filter; document.querySelectorAll('.filter-button').forEach((item) => item.classList.toggle('active', item === button)); renderExpenses(); }));
  $('#expenseRows').addEventListener('click', (event) => {
    const toggleButton = event.target.closest('[data-expense-toggle]');
    if (toggleButton) {
      const expenseId = toggleButton.dataset.expenseToggle;
      if (expandedExpenseIds.has(expenseId)) expandedExpenseIds.delete(expenseId);
      else expandedExpenseIds.add(expenseId);
      renderExpenses();
      return;
    }
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
