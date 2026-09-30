/**
 * ============================================================================
 * CERTIFICATE POSTING — GOOGLE SHEETS BRIDGE (Apps Script web app)
 * ============================================================================
 * WHAT THIS IS : The "reception window" on your master sheet. Zoho Desk's
 *                functions send it requests over the internet; it does the
 *                sheet work and replies. Zoho never gets direct sheet access.
 *
 * OPERATIONS   :
 *   checkEligibility {email, excludeTicket?} -> {priorPayoutClaims: N}
 *        counts rows in the Auto Payout tab where Email matches (trimmed,
 *        case-insensitive) AND Certificate Type is exactly "Payout" (trimmed).
 *        Any percentage era (90/70/60), any Approved Status incl. blank.
 *   codeExists {code, excludeTicket?} -> {taken: true/false}
 *        checks the Codes column of the Coupon tab (whole registry).
 *   upsertRows {ticket, payoutRow?, couponRow?} -> {payout:{row,mode}, coupon:{row,mode}}
 *        one row per tab keyed on Ticket #: update if the ticket already has
 *        a row (send-back loop), append if not. Auto-fills Week from Date
 *        (your Sunday-week scheme). Returns real row numbers for the draft.
 *   deleteRows {ticket} -> {payoutDeleted:N, couponDeleted:N}   (Reject)
 *   getRow {tab:"payout"|"coupon", ticket} -> {found, row, rowNumber} (Fulfil gate)
 *   updateStatus {ticket, status} -> {updated:N}   (On Hold -> Approved)
 *
 * SAFETY       : every request must carry the SECRET_KEY below; wrong or
 *                missing key -> "unauthorized", nothing returned. The Ticket #
 *                column is auto-created at the far right of each tab on first
 *                use; no existing column is ever moved or renamed. Tab names
 *                are matched TRIMMED, so the trailing space in "Auto Payout "
 *                is harmless.
 *
 * ----------------------------------------------------------------------------
 * DEPLOY (one time):
 *   1. Open the master sheet -> Extensions -> Apps Script.
 *   2. Add this code (new script file, or below the structure-report code —
 *      they coexist fine). 
 *   3. Replace SECRET_KEY below with your own long random passphrase
 *      (40+ characters, letters+digits). The SAME string goes into
 *      BRIDGE_KEY in the four Deluge functions.
 *   4. Project Settings (gear icon) -> Time zone -> set to your local
 *      time zone (e.g. Asia/Kolkata) so dates land on the right day.
 *   5. Deploy -> New deployment -> gear -> Web app ->
 *      Execute as: Me · Who has access: Anyone -> Deploy -> authorize ->
 *      copy the URL ending in /exec. That URL = BRIDGE_URL in Deluge.
 *   6. Browser test (incognito): opening the URL should show
 *      "certificate bridge alive".
 *
 * THE ONE GOTCHA YOU MUST REMEMBER:
 *   After ANY future edit to this code, changes do NOT go live until you do
 *   Deploy -> Manage deployments -> pencil -> Version: "New version" -> Deploy.
 *   (The URL stays the same.) Editing without redeploying = old code keeps
 *   running, which looks exactly like "my change didn't work".
 * ============================================================================
 */

var SECRET_KEY = 'CHANGE_ME_LONG_RANDOM_PASSPHRASE';

var PAYOUT_TAB_MATCH = 'auto payout';   // matched against trimmed, lowercased tab names
var COUPON_TAB_MATCH = 'coupon';
var CAMPAIGN_TAB_MATCH = 'campaign bonus';
var REGISTRY_SHEET_ID = 'PASTE_REGISTRY_SHEET_ID';  // from the Master Sheet URL: the long id between /d/ and /edit
var REGISTRY_TAB_MATCH = 'client registry';

// --- Payout Tracker (read-only lookup of the exact payout behind a certificate) ---
var TRACKER_SHEET_ID = 'PASTE_TRACKER_SHEET_ID';  // the long id between /d/ and /edit in the Payout Tracker URL
var TRACKER_TAB_MATCH = 'payout tracker';
var TRACKER_ID_HEADER = 'Payout ID';
var TRACKER_ACCT_HEADER = 'Account No';
var TRACKER_AMOUNT_HEADER = 'Payout Certificate amount';
// Base URL of the portal that serves the official certificate image (OCR fallback):
var CERTIFICATE_API_BASE = 'https://trader.example.com/api/certificates/';
// Hashtags / mentions the X post must contain (checked, never enforced automatically):
var REQUIRED_TAGS = ['#proptrading', '#forextrading', '#fastpayouts', '@acmetrading'];
var BRIDGE_VERSION = 'v4.1';   // shown by the alive page and in every reply -
                               // if this is not what you see, the DEPLOYMENT is old
var TICKET_HEADER = 'Ticket #';
var DATE_HEADERS = { 'Date': 1, 'Start Date': 1, 'End Date': 1 };

function doGet(e) {
  if (e && e.parameter && e.parameter.payload) {
    return handle_(e.parameter.payload);   // GET transport: same operations, payload in the URL
  }
  return ContentService.createTextOutput('certificate bridge alive - ' + BRIDGE_VERSION +
    ' - actions: checkEligibility, codeExists, upsertRows, deleteRows, getRow, updateStatus, ' +
    'readTab, writeTab, verifyClient, bonusDupCheck, campaignUpsert, campaignDelete, readPayoutFromPost');
}

function doPost(e) {
  return handle_(e.postData.contents);
}

function handle_(raw) {
  var out;
  try {
    var req = JSON.parse(raw);
    if (!req || req.key !== SECRET_KEY) {
      out = { ok: false, error: 'unauthorized' };
    } else if (req.action === 'checkEligibility') { out = checkEligibility_(req); }
    else if (req.action === 'codeExists')        { out = codeExists_(req); }
    else if (req.action === 'upsertRows')        { out = upsertRows_(req); }
    else if (req.action === 'deleteRows')        { out = deleteRows_(req); }
    else if (req.action === 'getRow')            { out = getRow_(req); }
    else if (req.action === 'updateStatus')      { out = updateStatus_(req); }
    else if (req.action === 'readTab')           { out = readTab_(req); }
    else if (req.action === 'writeTab')          { out = writeSheetTab_(req); }
    else if (req.action === 'verifyClient')      { out = verifyClient_(req); }
    else if (req.action === 'bonusDupCheck')     { out = bonusDupCheck_(req); }
    else if (req.action === 'campaignUpsert')    { out = campaignUpsert_(req); }
    else if (req.action === 'campaignDelete')    { out = campaignDelete_(req); }
    else if (req.action === 'readPayoutFromPost') { out = readPayoutFromPost_(req); }
    else { out = { ok: false, error: 'unknown action: ' + req.action }; }
  } catch (err) {
    out = { ok: false, error: String(err) };
  }
  if (out && typeof out === 'object') out.version = BRIDGE_VERSION;
  return ContentService.createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ------------------------------ helpers ---------------------------------- */

function ss_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

// ---- readTab: dump a tab's rows (display values) for the Python pipeline ----
function readTab_(req) {
  var sh = sheet_(String(req.tab || 'campaign bonus'));
  if (!sh) return { ok: false, error: 'tab not found: ' + req.tab };
  return { ok: true, tab: sh.getName(), rows: sh.getDataRange().getDisplayValues() };
}

// ---- writeSheetTab: (re)create a result tab; header bold + frozen; optional colors ----
// req = { tabName, rows: [[...],...], colors: { "colIndex1based": { "#HEX": [rowNumbers...] } } }
function writeSheetTab_(req) {
  var name = String(req.tabName || 'Lineage Sheet');
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (sh) { sh.clear(); } else { sh = ss.insertSheet(name); }
  var rows = req.rows || [];
  if (rows.length) {
    var width = rows[0].length;
    sh.getRange(1, 1, rows.length, width).setValues(rows);
    sh.getRange(1, 1, 1, width).setFontWeight('bold').setBackground('#efefef');
    sh.setFrozenRows(1);
  }
  var colors = req.colors || {};
  Object.keys(colors).forEach(function (col) {
    var byHex = colors[col];
    Object.keys(byHex).forEach(function (hex) {
      byHex[hex].forEach(function (r) {
        sh.getRange(Number(r), Number(col)).setBackground(hex);
      });
    });
  });
  return { ok: true, tab: name, written: rows.length };
}

function sheet_(match) {
  var sheets = ss_().getSheets();
  for (var i = 0; i < sheets.length; i++) {
    if (sheets[i].getName().trim().toLowerCase().indexOf(match) > -1) return sheets[i];
  }
  throw new Error('tab not found: ' + match);
}

function headers_(sh) {
  var lastCol = sh.getLastColumn();
  var h = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  return h.map(function (x) { return String(x === null || x === undefined ? '' : x).trim(); });
}

function colIndex_(headers, name) {
  var n = String(name).trim().toLowerCase();
  for (var i = 0; i < headers.length; i++) {
    if (headers[i].toLowerCase() === n) return i;
  }
  return -1;
}

function ensureTicketCol_(sh) {
  var h = headers_(sh);
  var i = colIndex_(h, TICKET_HEADER);
  if (i > -1) return i;
  var c = sh.getLastColumn() + 1;
  sh.getRange(1, c).setValue(TICKET_HEADER);
  return c - 1;
}

function norm_(v) {
  return String(v === null || v === undefined ? '' : v).trim().toLowerCase();
}

function parseDMY_(s) {
  var m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s).trim());
  if (!m) return s;
  return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
}

function weekNum_(d) {
  // Matches your sheet's convention (weeks start Sunday, Jan 1 = week 1):
  // verified against your rows: 18/12/2025->51, 29/12/2025->53, 02/01/2026->1, 15/08/2026->33
  var jan1 = new Date(d.getFullYear(), 0, 1);
  var doy = Math.floor((d - jan1) / 86400000) + 1;
  return Math.floor((doy + jan1.getDay() - 1) / 7) + 1;
}

/* ------------------------------ operations ------------------------------- */

function checkEligibility_(req) {
  var sh = sheet_(PAYOUT_TAB_MATCH);
  var h = headers_(sh);
  var iEmail = colIndex_(h, 'Email');
  var iCert = colIndex_(h, 'Certificate Type');
  var iTicket = colIndex_(h, TICKET_HEADER); // may be -1 before first write
  if (iEmail < 0 || iCert < 0) return { ok: false, error: 'Email / Certificate Type column not found' };
  var vals = sh.getDataRange().getValues();
  var email = norm_(req.email);
  var ex = norm_(req.excludeTicket || '');
  if (!email) return { ok: false, error: 'empty email' };
  var n = 0;
  for (var r = 1; r < vals.length; r++) {
    if (norm_(vals[r][iEmail]) !== email) continue;
    if (norm_(vals[r][iCert]) !== 'payout') continue;   // EXACT "Payout" rows only
    if (ex && iTicket > -1 && norm_(vals[r][iTicket]) === ex) continue;
    n++;
  }
  return { ok: true, priorPayoutClaims: n };
}

function codeExists_(req) {
  var sh = sheet_(COUPON_TAB_MATCH);
  var h = headers_(sh);
  var iCode = colIndex_(h, 'Codes');
  if (iCode < 0) iCode = colIndex_(h, 'Code');
  if (iCode < 0) return { ok: false, error: 'Codes column not found' };
  var iTicket = colIndex_(h, TICKET_HEADER);
  var vals = sh.getDataRange().getValues();
  var code = norm_(req.code);
  var ex = norm_(req.excludeTicket || '');
  for (var r = 1; r < vals.length; r++) {
    if (norm_(vals[r][iCode]) !== code) continue;
    if (ex && iTicket > -1 && norm_(vals[r][iTicket]) === ex) continue; // this ticket's own code isn't "taken"
    return { ok: true, taken: true };
  }
  return { ok: true, taken: false };
}

function writeTab_(sh, ticket, rowObj) {
  var iT = ensureTicketCol_(sh);
  var h = headers_(sh); // re-read: may now include Ticket #
  // Auto-fill Week from Date when the tab has a Week column and none was sent:
  var iWeek = colIndex_(h, 'Week');
  if (iWeek > -1 && !('Week' in rowObj) && rowObj['Date']) {
    var d = parseDMY_(rowObj['Date']);
    if (Object.prototype.toString.call(d) === '[object Date]') rowObj['Week'] = weekNum_(d);
  }
  rowObj[TICKET_HEADER] = String(ticket);
  Object.keys(rowObj).forEach(function (k) {
    if (DATE_HEADERS[k]) rowObj[k] = parseDMY_(rowObj[k]);
  });
  var vals = sh.getDataRange().getValues();
  var tkt = norm_(ticket);
  var found = -1;
  for (var r = 1; r < vals.length; r++) {
    if (norm_(vals[r][iT]) === tkt) { found = r; break; }
  }
  if (found > -1) {
    Object.keys(rowObj).forEach(function (k) {
      var c = colIndex_(h, k);
      if (c > -1) sh.getRange(found + 1, c + 1).setValue(rowObj[k]);
    });
    return { row: found + 1, mode: 'updated' };
  }
  var arr = [];
  for (var c2 = 0; c2 < h.length; c2++) arr.push('');
  Object.keys(rowObj).forEach(function (k) {
    var c3 = colIndex_(h, k);
    if (c3 > -1) arr[c3] = rowObj[k];
  });
  sh.appendRow(arr);
  return { row: sh.getLastRow(), mode: 'inserted' };
}

function upsertRows_(req) {
  if (!req.ticket) return { ok: false, error: 'ticket missing' };
  var res = { ok: true };
  if (req.payoutRow) res.payout = writeTab_(sheet_(PAYOUT_TAB_MATCH), req.ticket, req.payoutRow);
  if (req.couponRow) res.coupon = writeTab_(sheet_(COUPON_TAB_MATCH), req.ticket, req.couponRow);
  return res;
}

function deleteRows_(req) {
  if (!req.ticket) return { ok: false, error: 'ticket missing' };
  function delFrom(sh) {
    var iT = colIndex_(headers_(sh), TICKET_HEADER);
    if (iT < 0) return 0;
    var vals = sh.getDataRange().getValues();
    var t = norm_(req.ticket);
    var n = 0;
    for (var r = vals.length - 1; r >= 1; r--) {
      if (norm_(vals[r][iT]) === t) { sh.deleteRow(r + 1); n++; }
    }
    return n;
  }
  return {
    ok: true,
    payoutDeleted: delFrom(sheet_(PAYOUT_TAB_MATCH)),
    couponDeleted: delFrom(sheet_(COUPON_TAB_MATCH))
  };
}

function getRow_(req) {
  var sh = sheet_(req.tab === 'coupon' ? COUPON_TAB_MATCH : (req.tab === 'campaign' ? CAMPAIGN_TAB_MATCH : PAYOUT_TAB_MATCH));
  var h = headers_(sh);
  var iT = colIndex_(h, TICKET_HEADER);
  if (iT < 0) return { ok: true, found: false };
  var vals = sh.getDataRange().getValues();
  var t = norm_(req.ticket);
  for (var r = 1; r < vals.length; r++) {
    if (norm_(vals[r][iT]) === t) {
      var o = {};
      for (var c = 0; c < h.length; c++) {
        if (!h[c]) continue;
        var v = vals[r][c];
        if (Object.prototype.toString.call(v) === '[object Date]') {
          v = Utilities.formatDate(v, Session.getScriptTimeZone(), 'dd/MM/yyyy');
        }
        o[h[c]] = v;
      }
      return { ok: true, found: true, row: o, rowNumber: r + 1 };
    }
  }
  return { ok: true, found: false };
}

function updateStatus_(req) {
  var sh = sheet_(PAYOUT_TAB_MATCH);
  var h = headers_(sh);
  var iT = colIndex_(h, TICKET_HEADER);
  var iS = colIndex_(h, 'Approved Status');
  if (iT < 0 || iS < 0) return { ok: false, error: 'Ticket # / Approved Status column not found' };
  var vals = sh.getDataRange().getValues();
  var t = norm_(req.ticket);
  var n = 0;
  for (var r = 1; r < vals.length; r++) {
    if (norm_(vals[r][iT]) === t) {
      sh.getRange(r + 1, iS + 1).setValue(req.status);
      n++;
    }
  }
  return { ok: true, updated: n };
}

/* -------------------- bonus + registry operations ------------------------- */

function sheetIn_(ss, match) {
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    if (sheets[i].getName().trim().toLowerCase().indexOf(match) > -1) return sheets[i];
  }
  throw new Error('tab not found: ' + match);
}

function maskEmail_(e) {
  var m = /^(.{1,2})[^@]*(@.*)$/.exec(String(e || ''));
  return m ? m[1] + '***' + m[2] : '***';
}

// verifyClient: { account, email } -> ownership + lineage info from the
// RESTRICTED Certificate Posting Master Sheet (opened by file ID).
function verifyClient_(req) {
  if (REGISTRY_SHEET_ID.indexOf('PASTE') === 0) return { ok: false, error: 'REGISTRY_SHEET_ID not set in the bridge' };
  var acct = String(req.account || '').trim();
  if (!acct) return { ok: false, error: 'empty account' };
  var sh = sheetIn_(SpreadsheetApp.openById(REGISTRY_SHEET_ID), REGISTRY_TAB_MATCH);
  var h = headers_(sh);
  var iA = colIndex_(h, 'Account No');
  if (iA < 0) return { ok: false, error: 'Account No column not found in registry' };
  var cell = sh.getRange(2, iA + 1, Math.max(sh.getLastRow() - 1, 1), 1)
               .createTextFinder(acct).matchEntireCell(true).findNext();
  if (!cell) return { ok: true, found: false };
  var row = sh.getRange(cell.getRow(), 1, 1, h.length).getValues()[0];
  function g(name) {
    var i = colIndex_(h, name);
    var v = i > -1 ? row[i] : '';
    if (Object.prototype.toString.call(v) === '[object Date]') {
      v = Utilities.formatDate(v, Session.getScriptTimeZone(), 'dd/MM/yyyy');
    }
    return String(v === null || v === undefined ? '' : v).trim();
  }
  var owner = g('Email');
  var match = norm_(owner) !== '' && norm_(owner) === norm_(req.email || '');
  return { ok: true, found: true, emailMatch: match,
           ownerHint: match ? owner : maskEmail_(owner),
           name: g('Client Name'), customer: g('Customer #'),
           stage: g('Account Stage'), status: g('Account Status'),
           passedOn: g('Passed On'), plan: g('Plan'),
           nextAccount: g('Next Account'), nextStage: g('Next Account Stage'),
           nextStatus: g('Next Account Status'), prevAccount: g('Previous Account') };
}

// bonusDupCheck: { accounts: [..], excludeTicket } -> which of these accounts
// already appear anywhere in the Campaign Bonus tab (any column that holds
// account numbers), so a certificate is never paid twice.
function bonusDupCheck_(req) {
  var accounts = (req.accounts || []).map(function (a) { return String(a).trim(); }).filter(String);
  if (!accounts.length) return { ok: true, claimed: [] };
  var sh = sheet_(CAMPAIGN_TAB_MATCH);
  var h = headers_(sh);
  var cols = [];
  for (var c = 0; c < h.length; c++) {
    var hl = h[c].toLowerCase();
    if (hl.indexOf('certificate for account') > -1 || hl.indexOf('funded account') > -1) cols.push(c);
  }
  if (!cols.length) return { ok: false, error: 'account columns not found in Campaign Bonus tab' };
  var ex = norm_(req.excludeTicket || '');
  var iT = colIndex_(h, TICKET_HEADER);
  var vals = sh.getDataRange().getValues();
  var claimed = [], seen = {};
  for (var r = 1; r < vals.length; r++) {
    if (ex && iT > -1 && norm_(vals[r][iT]) === ex) continue;
    for (var k = 0; k < cols.length; k++) {
      var txt = String(vals[r][cols[k]] === null ? '' : vals[r][cols[k]]);
      for (var a = 0; a < accounts.length; a++) {
        var re = new RegExp('(^|[^0-9])' + accounts[a] + '([^0-9]|$)');
        if (re.test(txt)) {
          var key = accounts[a] + ':' + (r + 1);
          if (!seen[key]) { seen[key] = 1; claimed.push({ account: accounts[a], row: r + 1 }); }
        }
      }
    }
  }
  return { ok: true, claimed: claimed };
}

// campaignUpsert: { ticket, row: { header: value, ... } } -> one row per ticket
// in the Campaign Bonus tab (Ticket # column auto-created at the far right).
function campaignUpsert_(req) {
  if (!req.ticket) return { ok: false, error: 'ticket missing' };
  return { ok: true, campaign: writeTab_(sheet_(CAMPAIGN_TAB_MATCH), req.ticket, req.row || {}) };
}

function campaignDelete_(req) {
  if (!req.ticket) return { ok: false, error: 'ticket missing' };
  var sh = sheet_(CAMPAIGN_TAB_MATCH);
  var iT = colIndex_(headers_(sh), TICKET_HEADER);
  var n = 0;
  if (iT > -1) {
    var vals = sh.getDataRange().getValues();
    var tt = norm_(req.ticket);
    for (var r = vals.length - 1; r >= 1; r--) {
      if (norm_(vals[r][iT]) === tt) { sh.deleteRow(r + 1); n++; }
    }
  }
  return { ok: true, campaignDeleted: n };
}

/* ---------------- payout amount from the client's X post --------------------
   readPayoutFromPost { xLink, account }
   1. FxTwitter gives the post's image + text (no login, no browser).
   2. The certificate's QR resolves to .../authenticity/<user>/payout/<payoutId>.
   3. That payoutId is looked up in the Payout Tracker -> the exact, official
      "Payout Certificate amount" for THIS certificate (and the account it
      belongs to, cross-checked against the ticket's account).
   4. If the QR can't be read, Drive OCR of the official certificate image (or
      of the posted image) supplies a fallback figure.
   Always returns ok:true - an unreadable post is a note, never a hard error. */

function readPayoutFromPost_(req) {
  var link = String(req.xLink || '').trim();
  var acct = String(req.account || '').trim();
  if (!link) return { ok: true, amount: '', source: 'none', note: 'no X link on the ticket' };
  var m = link.match(/(?:x|twitter)\.com\/([^\/]+)\/status\/(\d+)/);
  if (!m) return { ok: true, amount: '', source: 'none', note: 'not an X status link' };

  var tweet = {}, photos = [], text = '';
  try {
    var resp = UrlFetchApp.fetch('https://api.fxtwitter.com/' + m[1] + '/status/' + m[2], { muteHttpExceptions: true });
    if (resp.getResponseCode() === 404) return { ok: true, amount: '', source: 'none', note: 'post not found (deleted or private)' };
    if (resp.getResponseCode() !== 200) return { ok: true, amount: '', source: 'none', note: 'post fetch failed (HTTP ' + resp.getResponseCode() + ')' };
    tweet = (JSON.parse(resp.getContentText()) || {}).tweet || {};
    text = tweet.text || '';
    var media = tweet.media || {};
    photos = (media.photos || media.all || []).filter(function (p) {
      return p.url && (p.type || 'photo') === 'photo';
    }).map(function (p) { return p.url; });
  } catch (err) {
    return { ok: true, amount: '', source: 'none', note: 'post fetch failed: ' + err.message };
  }

  var checks = postChecks_(text);
  if (!photos.length) return { ok: true, amount: '', source: 'none', checks: checks, note: 'post has no image' };

  var qrUrl = '', payoutId = '', note = '';
  for (var i = 0; i < photos.length && !qrUrl; i++) qrUrl = decodeQr_(photos[i]);
  var ids = qrUrl ? qrUrl.match(/authenticity\/(\d+)\/payout\/(\d+)/) : null;

  // --- primary: the certificate's own payout id, matched in the tracker ---
  if (ids) {
    payoutId = ids[2];
    var look = trackerLookup_(payoutId);
    if (look.found) {
      var acctMatch = acct === '' || String(look.account) === acct;
      return { ok: true, amount: look.amount, payoutId: payoutId, trackerAccount: look.account,
               accountMatch: acctMatch, checks: checks, source: 'tracker',
               note: acctMatch ? '' : 'tracker account ' + look.account + ' differs from the ticket account ' + acct };
    }
    note = 'payout id ' + payoutId + ' not found in the tracker';
  } else {
    note = 'certificate QR not readable';
  }

  // --- fallback: OCR (official certificate image first, posted image second) ---
  var amt = null;
  if (ids) {
    try {
      var png = UrlFetchApp.fetch(CERTIFICATE_API_BASE + ids[1] + '/payout/' + ids[2] + '/png',
                                  { muteHttpExceptions: true });
      if (png.getResponseCode() === 200) amt = amountFromText_(driveOcr_(png.getBlob()));
    } catch (err) { note = note + '; official image failed: ' + err.message; }
  }
  if (amt === null) {
    try { amt = amountFromText_(driveOcr_(fetchPostImage_(photos[0]))); } catch (err) { note = note + '; OCR failed: ' + err.message; }
  }
  if (amt === null) return { ok: true, amount: '', payoutId: payoutId, checks: checks, source: 'none', note: note + '; amount not readable' };

  // The certificate had no readable QR (older certificates carry none), so
  // confirm the OCR figure against the tracker using account + amount, which
  // is effectively unique and also pins down WHICH payout this certificate is.
  if (acct) {
    var byAmt = trackerLookupByAccountAmount_(acct, amt);
    if (byAmt.found) {
      return { ok: true, amount: byAmt.amount, payoutId: byAmt.payoutId, trackerAccount: acct,
               accountMatch: true, checks: checks, source: 'tracker',
               note: note + '; matched in the tracker by account + amount' + (byAmt.multiple ? ' (several payouts of this amount - took the most recent)' : '') };
    }
    note = note + '; $' + amt + ' not found against account ' + acct + ' in the tracker';
  }
  return { ok: true, amount: amt, payoutId: payoutId, checks: checks, source: 'ocr', note: note };
}

/* Finds the payout row for an account whose amount matches the certificate.
   Checks "Payout Certificate amount" first, then "Client Payout Amount".
   With several identical amounts, the most recent request date wins. */
function trackerLookupByAccountAmount_(account, amount) {
  if (TRACKER_SHEET_ID.indexOf('PASTE') === 0) return { found: false };
  var sh = sheetIn_(SpreadsheetApp.openById(TRACKER_SHEET_ID), TRACKER_TAB_MATCH);
  var h = headers_(sh);
  var iAcc = colIndex_(h, TRACKER_ACCT_HEADER);
  var iAmt = colIndex_(h, TRACKER_AMOUNT_HEADER);
  var iAlt = colIndex_(h, 'Client Payout Amount');
  var iId = colIndex_(h, TRACKER_ID_HEADER);
  var iDate = colIndex_(h, 'Date & Time of Request');
  if (iAcc < 0 || iAmt < 0) return { found: false };

  var vals = sh.getDataRange().getValues();
  var want = Math.round(Number(amount) * 100);
  var hits = [];
  for (var r = 1; r < vals.length; r++) {
    if (String(vals[r][iAcc]).replace(/\.0$/, '').trim() !== String(account).trim()) continue;
    var cand = [vals[r][iAmt]];
    if (iAlt > -1) cand.push(vals[r][iAlt]);
    for (var c = 0; c < cand.length; c++) {
      var v = typeof cand[c] === 'number' ? cand[c] : amountFromText_(String(cand[c]));
      if (v !== null && v !== '' && Math.round(Number(v) * 100) === want) {
        var when = iDate > -1 ? vals[r][iDate] : '';
        hits.push({ amount: Math.round(Number(vals[r][iAmt]) * 100) / 100 || Number(v),
                    payoutId: iId > -1 ? String(vals[r][iId]).replace(/\.0$/, '') : '',
                    when: (when instanceof Date) ? when.getTime() : 0 });
        break;
      }
    }
  }
  if (!hits.length) return { found: false };
  hits.sort(function (a, b) { return b.when - a.when; });
  return { found: true, amount: hits[0].amount, payoutId: hits[0].payoutId, multiple: hits.length > 1 };
}

function trackerLookup_(payoutId) {
  if (TRACKER_SHEET_ID.indexOf('PASTE') === 0) return { found: false };
  var sh = sheetIn_(SpreadsheetApp.openById(TRACKER_SHEET_ID), TRACKER_TAB_MATCH);
  var h = headers_(sh);
  var iId = colIndex_(h, TRACKER_ID_HEADER);
  var iAmt = colIndex_(h, TRACKER_AMOUNT_HEADER);
  var iAcc = colIndex_(h, TRACKER_ACCT_HEADER);
  if (iId < 0 || iAmt < 0) return { found: false };
  var cell = sh.getRange(2, iId + 1, Math.max(sh.getLastRow() - 1, 1), 1)
               .createTextFinder(String(payoutId)).matchEntireCell(true).findNext();
  if (!cell) return { found: false };
  var row = sh.getRange(cell.getRow(), 1, 1, h.length).getValues()[0];
  var raw = row[iAmt];
  var amt = typeof raw === 'number' ? Math.round(raw * 100) / 100 : amountFromText_(String(raw));
  return { found: amt !== null && amt !== '', amount: amt, account: iAcc > -1 ? String(row[iAcc]).replace(/\.0$/, '') : '' };
}

function decodeQr_(imageUrl) {
  var sizes = ['orig', '4096x4096', 'large', 'medium'];
  for (var s = 0; s < sizes.length; s++) {
    var u = /[?&]name=\w+/.test(imageUrl) ? imageUrl.replace(/([?&])name=\w+/, '$1name=' + sizes[s])
                                          : imageUrl + (imageUrl.indexOf('?') >= 0 ? '&' : '?') + 'name=' + sizes[s];
    try {
      var r = UrlFetchApp.fetch('https://api.qrserver.com/v1/read-qr-code/?fileurl=' + encodeURIComponent(u),
                                { muteHttpExceptions: true });
      if (r.getResponseCode() === 200) {
        var j = JSON.parse(r.getContentText());
        var sym = j && j[0] && j[0].symbol && j[0].symbol[0];
        if (sym && sym.data && String(sym.data).indexOf('http') === 0) return sym.data;
      }
    } catch (err) { /* try the next size */ }
  }
  return '';
}

function fetchPostImage_(url) {
  var sizes = ['orig', 'large'];
  for (var s = 0; s < sizes.length; s++) {
    var u = /[?&]name=\w+/.test(url) ? url.replace(/([?&])name=\w+/, '$1name=' + sizes[s])
                                     : url + (url.indexOf('?') >= 0 ? '&' : '?') + 'name=' + sizes[s];
    var r = UrlFetchApp.fetch(u, { muteHttpExceptions: true });
    if (r.getResponseCode() === 200 && r.getBlob().getBytes().length < 1.9 * 1024 * 1024) return r.getBlob();
  }
  throw new Error('could not download the post image');
}

// Drive OCR: converting an image to a Google Doc makes Drive read its text.
// Requires the "Drive API" advanced service (Services + -> Drive API v3).
function driveOcr_(blob) {
  var file = Drive.Files.create({ name: 'payout-ocr-' + Date.now(), mimeType: 'application/vnd.google-apps.document' },
                                blob, { ocrLanguage: 'en' });
  try {
    var lastErr;
    for (var attempt = 0; attempt < 3; attempt++) {
      try { return DocumentApp.openById(file.id).getBody().getText(); }
      catch (err) { lastErr = err; Utilities.sleep(1500); }
    }
    throw lastErr;
  } finally {
    try { Drive.Files.remove(file.id); } catch (err) { /* temp doc cleanup is best-effort */ }
  }
}

function amountFromText_(text) {
  var re = /\$\s?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)/g;
  var m, best = null;
  while ((m = re.exec(String(text)))) {
    var v = Math.round(parseFloat(m[1].replace(/,/g, '')) * 100) / 100;
    if (best === null || v > best) best = v;
  }
  return best;
}

function postChecks_(text) {
  if (!REQUIRED_TAGS || !REQUIRED_TAGS.length) return '';
  var low = String(text).toLowerCase();
  var missing = [];
  for (var i = 0; i < REQUIRED_TAGS.length; i++) {
    if (low.indexOf(String(REQUIRED_TAGS[i]).toLowerCase()) < 0) missing.push(REQUIRED_TAGS[i]);
  }
  return missing.length ? 'missing: ' + missing.join(', ') : 'ok';
}
