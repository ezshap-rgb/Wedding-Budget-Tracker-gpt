/**
 * Wedding Budget Google Sheets backend
 *
 * Add this file to Extensions > Apps Script in the shared spreadsheet.
 * Run setupWeddingBudget() once, then deploy as a Web app.
 */
const SHEETS = {
  config: { name: 'הגדרות', headers: ['מפתח', 'ערך'] },
  expenses: { name: 'הוצאות', headers: ['מזהה', 'נוצר בתאריך', 'שם ההוצאה', 'קטגוריה (ישן)', 'ספק', 'סכום', 'מועד תשלום', 'אופן חלוקה', 'אורחי שפירא (ישן)', 'אורחי חגאג (ישן)', 'מחיר לאורח', 'סכום שפירא', 'סכום חגאג', 'סטטוס (מחושב)', 'הערות', 'אופן חישוב הסכום', 'מספר אורחים'] },
  contributions: { name: 'תשלומים', headers: ['מזהה', 'נוצר בתאריך', 'תאריך', 'משפחה', 'סכום', 'סוג תשלום', 'מזהה הוצאה', 'הערה'] },
  comments: { name: 'הערות', headers: ['מזהה', 'נוצר בתאריך', 'הערה'] }
};

function setupWeddingBudget() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(SHEETS).forEach(function (key) {
    const definition = SHEETS[key];
    const sheet = spreadsheet.getSheetByName(definition.name) || spreadsheet.insertSheet(definition.name);
    sheet.setRightToLeft(true);
    if (sheet.getLastRow() === 0) {
      sheet.getRange(1, 1, 1, definition.headers.length).setValues([definition.headers]);
    } else {
      sheet.getRange(1, 1, 1, definition.headers.length).setValues([definition.headers]);
    }
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, definition.headers.length)
      .setFontWeight('bold')
      .setFontColor('#ffffff')
      .setBackground('#242321');
    sheet.autoResizeColumns(1, definition.headers.length);
  });
  const config = spreadsheet.getSheetByName(SHEETS.config.name);
  config.getRange(2, 1, 3, 2).setValues([
    ['familyA', 'שפירא'],
    ['familyB', 'חגאג'],
    ['currency', 'ILS']
  ]);
  Logger.log('Wedding Budget tabs are ready. You can now deploy this script as a Web app.');
}

function doGet(event) {
  const result = readBudget_();
  return respond_(event, result);
}

function doPost(event) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const command = JSON.parse(event.postData.contents || '{}');
    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    if (command.type === 'addExpense' && command.expense) {
      spreadsheet.getSheetByName(SHEETS.expenses.name).appendRow(expenseRow_(command.expense));
      if (command.initialContribution) spreadsheet.getSheetByName(SHEETS.contributions.name).appendRow(contributionRow_(command.initialContribution));
    } else if (command.type === 'updateExpense' && command.expense) {
      if (!updateRow_(spreadsheet.getSheetByName(SHEETS.expenses.name), command.expense.id, expenseRow_(command.expense))) return json_({ ok: false, error: 'Expense not found' });
      if (command.initialContribution) spreadsheet.getSheetByName(SHEETS.contributions.name).appendRow(contributionRow_(command.initialContribution));
    } else if (command.type === 'deleteExpense' && command.expenseId) {
      if (!deleteRow_(spreadsheet.getSheetByName(SHEETS.expenses.name), command.expenseId)) return json_({ ok: false, error: 'Expense not found' });
      deleteLinkedExpensePayments_(spreadsheet.getSheetByName(SHEETS.contributions.name), command.expenseId);
    } else if (command.type === 'addContribution' && command.contribution && command.contribution.expenseId) {
      spreadsheet.getSheetByName(SHEETS.contributions.name).appendRow(contributionRow_(command.contribution));
    } else if (command.type === 'updateContribution' && command.contribution && command.contribution.expenseId) {
      if (!updateRow_(spreadsheet.getSheetByName(SHEETS.contributions.name), command.contribution.id, contributionRow_(command.contribution))) return json_({ ok: false, error: 'Contribution not found' });
    } else if (command.type === 'deleteContribution' && command.contributionId) {
      if (!deleteRow_(spreadsheet.getSheetByName(SHEETS.contributions.name), command.contributionId)) return json_({ ok: false, error: 'Contribution not found' });
    } else if (command.type === 'addComment' && command.comment && String(command.comment.text || '').trim()) {
      spreadsheet.getSheetByName(SHEETS.comments.name).appendRow(commentRow_(command.comment));
    } else if (command.type === 'deleteComment' && command.commentId) {
      if (!deleteRow_(spreadsheet.getSheetByName(SHEETS.comments.name), command.commentId)) return json_({ ok: false, error: 'Comment not found' });
    } else {
      return json_({ ok: false, error: 'Unknown command' });
    }
    return json_({ ok: true });
  } finally {
    lock.releaseLock();
  }
}

function expenseRow_(item) {
  return [item.id, item.createdAt, item.name, '', '', number_(item.amount), '',
    item.splitMethod, 0, 0, number_(item.perGuest), number_(item.customA), number_(item.customB), '', item.notes,
    item.amountMethod || 'fixed', number_(item.guestCount)];
}

function contributionRow_(item) {
  return [item.id, item.createdAt, item.date, item.family, number_(item.amount), item.type, item.expenseId || '', item.note];
}

function commentRow_(item) {
  return [item.id, item.createdAt, item.text];
}

function findRow_(sheet, id) {
  if (!sheet || sheet.getLastRow() < 2) return -1;
  const ids = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
  for (let index = 0; index < ids.length; index += 1) {
    if (String(ids[index][0]) === String(id)) return index + 2;
  }
  return -1;
}

function updateRow_(sheet, id, values) {
  const row = findRow_(sheet, id);
  if (row < 0) return false;
  sheet.getRange(row, 1, 1, values.length).setValues([values]);
  return true;
}

function deleteRow_(sheet, id) {
  const row = findRow_(sheet, id);
  if (row < 0) return false;
  sheet.deleteRow(row);
  return true;
}

function deleteLinkedExpensePayments_(sheet, expenseId) {
  if (!sheet || sheet.getLastRow() < 2) return;
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, SHEETS.contributions.headers.length).getValues();
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (String(rows[index][6]) === String(expenseId)) sheet.deleteRow(index + 2);
  }
}

function readBudget_() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  return {
    ok: true,
    settings: readConfig_(spreadsheet.getSheetByName(SHEETS.config.name)),
    expenses: readExpenses_(spreadsheet.getSheetByName(SHEETS.expenses.name)),
    contributions: readContributions_(spreadsheet.getSheetByName(SHEETS.contributions.name)),
    comments: readComments_(spreadsheet.getSheetByName(SHEETS.comments.name))
  };
}

function readConfig_(sheet) {
  const config = {};
  if (!sheet || sheet.getLastRow() < 2) return config;
  sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues().forEach(function (row) {
    if (row[0]) config[String(row[0])] = String(row[1] || '');
  });
  return config;
}

function readExpenses_(sheet) {
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, SHEETS.expenses.headers.length).getValues().filter(function (row) { return row[0]; }).map(function (row) {
    return {
      id: String(row[0]), createdAt: String(row[1] || ''), name: String(row[2] || ''), vendor: String(row[4] || ''),
      amount: number_(row[5]), dueDate: dateString_(row[6]), splitMethod: String(row[7] || 'even'), guestsA: number_(row[8]), guestsB: number_(row[9]),
      perGuest: number_(row[10]), customA: number_(row[11]), customB: number_(row[12]), notes: String(row[14] || ''),
      amountMethod: String(row[15] || 'fixed'), guestCount: number_(row[16])
    };
  });
}

function readContributions_(sheet) {
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, SHEETS.contributions.headers.length).getValues().filter(function (row) { return row[0]; }).map(function (row) {
    return { id: String(row[0]), createdAt: String(row[1] || ''), date: dateString_(row[2]), family: String(row[3] || 'A'), amount: number_(row[4]), type: String(row[5] || 'Contribution'), expenseId: String(row[6] || ''), note: String(row[7] || '') };
  });
}

function readComments_(sheet) {
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, SHEETS.comments.headers.length).getValues().filter(function (row) { return row[0]; }).map(function (row) {
    return { id: String(row[0]), createdAt: String(row[1] || ''), text: String(row[2] || '') };
  });
}

function dateString_(value) {
  if (!value) return '';
  if (Object.prototype.toString.call(value) === '[object Date]') return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return String(value).slice(0, 10);
}

function number_(value) {
  const number = Number(value);
  return isNaN(number) ? 0 : number;
}

function json_(body) {
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(ContentService.MimeType.JSON);
}

function respond_(event, body) {
  const callback = event && event.parameter && event.parameter.callback;
  if (callback && /^[A-Za-z_$][0-9A-Za-z_$]*$/.test(callback)) {
    return ContentService.createTextOutput(callback + '(' + JSON.stringify(body) + ');').setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return json_(body);
}
