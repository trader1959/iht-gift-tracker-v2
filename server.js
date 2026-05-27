const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const archiver = require('archiver');
const AdmZip = require('adm-zip');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3050;
const dataDir = path.join(__dirname, 'data');
const proofDir = path.join(dataDir, 'proofs');
const secureProofDir = path.join(dataDir, 'proofs-secure');
const dbPath = path.join(dataDir, 'db.json');
const auditPath = path.join(dataDir, 'audit.log');
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

function ensureDirs() {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(proofDir, { recursive: true });
  fs.mkdirSync(secureProofDir, { recursive: true });
}

function todayIso() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return year + '-' + month + '-' + day;
}

function pad2(n) { return String(n).padStart(2, '0'); }
function safeNamePart(value) {
  return String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'unknown';
}

function defaultData() {
  return {
    settings: {
      giftMaker: {
        fullName: '',
        dob: '',
        niNumber: '',
        ihtReference: '',
        phone: '',
        relationshipToRecipients: '',
        addressLine1: '',
        addressLine2: '',
        town: '',
        postcode: ''
      },
      display: {
        fontFamily: 'Arial, sans-serif',
        fontSize: '16px'
      },
      recipients: ['Child A', 'Child B', 'Grandchild A'],
      incomeTypes: ['Salary', 'Pension', 'Rental income', 'Dividends', 'Interest']
    },
    gifts: [],
    allowanceGifts: [],
    expenditures: [],
    expTables: {}
  };
}

function readDb() {
  ensureDirs();
  if (!fs.existsSync(dbPath)) {
    const seed = defaultData();
    fs.writeFileSync(dbPath, JSON.stringify(seed, null, 2), 'utf8');
    return seed;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    if (!parsed.expTables) { parsed.expTables = {}; }
    if (!parsed.allowanceGifts) { parsed.allowanceGifts = []; }
    if (!parsed.sevenYearGifts)  { parsed.sevenYearGifts  = []; }
    if (!parsed.settings.incomeTypes) { parsed.settings.incomeTypes = []; }
    if (!parsed.settings.regularIncome) { parsed.settings.regularIncome = []; }
    if (!parsed.settings.regularExpenditure) { parsed.settings.regularExpenditure = []; }
    return parsed;
  } catch (err) {
    const seed = defaultData();
    fs.writeFileSync(dbPath, JSON.stringify(seed, null, 2), 'utf8');
    return seed;
  }
}

function writeDb(data) {
  ensureDirs();
  const tmp = dbPath + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, dbPath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch(e) {}
    throw err;
  }
}

function makeId(prefix) {
  return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
}



function auditLog(action, details) {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), action, details }) + '\n';
    fs.appendFileSync(auditPath, line, 'utf8');
  } catch(e) {}
}

function sanitize(obj, allowed) {
  const out = {};
  allowed.forEach(function(k) { if (Object.prototype.hasOwnProperty.call(obj || {}, k)) out[k] = obj[k]; });
  return out;
}
function taxYearLabel(dateText) {
  const date = new Date(dateText + 'T00:00:00');
  const year = date.getFullYear();
  const taxBoundary = new Date(year, 3, 6);
  if (date >= taxBoundary) {
    return year + '/' + String(year + 1).slice(-2);
  }
  return (year - 1) + '/' + String(year).slice(-2);
}

function summariseGifts(gifts) {
  const byRecipient = {};
  const byTaxYear = {};
  let grandTotal = 0;
  gifts.forEach(function (gift) {
    const amount = Number(gift.amount || 0);
    grandTotal += amount;
    const rec = gift.recipient || 'Unknown';
    const year = taxYearLabel(gift.date);
    byRecipient[rec] = (byRecipient[rec] || 0) + amount;
    byTaxYear[year] = (byTaxYear[year] || 0) + amount;
  });
  return { byRecipient, byTaxYear, grandTotal };
}

function incomeSummary(expenditures) {
  const byTaxYear = {};
  expenditures.forEach(function (item) {
    const year = taxYearLabel(item.date);
    byTaxYear[year] = byTaxYear[year] || { income: 0, expenditure: 0 };
    byTaxYear[year].income += Number(item.incomeAmount || 0);
    byTaxYear[year].expenditure += Number(item.expenditureAmount || 0);
  });
  return byTaxYear;
}

function headerLines(settings) {
  const maker = settings.giftMaker || {};
  return [
    'Gift maker: ' + (maker.fullName || ''),
    'NI number: ' + (maker.niNumber || ''),
    'DOB: ' + (maker.dob || ''),
    'IHT reference: ' + (maker.ihtReference || ''),
    'Phone: ' + (maker.phone || '')
  ];
}

function drawHeader(doc, settings, title) {
  doc.fontSize(10).font('Helvetica-Bold').text(title, 40, 28);
  const lines = headerLines(settings);
  let y = 44;
  doc.fontSize(9).font('Helvetica');
  lines.forEach(function (line) {
    doc.text(line, 40, y);
    y += 12;
  });
  doc.moveTo(40, 104).lineTo(555, 104).stroke('#999999');
}

function drawFooter(doc) {
  doc.fontSize(8).fillColor('#666666').text('Page ' + doc.page.pageNumber, 500, 810, { align: 'right' });
  doc.fillColor('#000000');
}

function startPdf(res, filename) {
  const doc = new PDFDocument({ margin: 40, size: 'A4', bufferPages: true });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
  doc.pipe(res);
  return doc;
}


function renderIht403ExtendedTable(doc, rows, startY) {
  const x = [40, 92, 205, 320, 410, 455, 490, 525];
  let y = startY;
  doc.font('Helvetica-Bold').fontSize(8);
  ['Date', 'Recipient/relationship', 'Description', 'Exemption/relief', 'A', 'B', 'C', 'D'].forEach(function (h, i) { doc.text(h, x[i], y, { width: i === 2 ? 85 : 40 }); });
  y += 12;
  doc.moveTo(40, y).lineTo(555, y).stroke('#999');
  y += 6;
  doc.font('Helvetica').fontSize(8);
  rows.forEach(function (r) {
    if (y > 720) { doc.addPage(); y = 115; }
    doc.text(String(r.date || ''), x[0], y, { width: 48 });
    doc.text(String(r.recipient || ''), x[1], y, { width: 108 });
    doc.text(String(r.desc || ''), x[2], y, { width: 110 });
    doc.text(String(r.exemption || ''), x[3], y, { width: 80 });
    doc.text(formatCurrency(r.amount || 0), x[4], y, { width: 34, align: 'right' });
    doc.text(formatCurrency(r.deduct || 0), x[5], y, { width: 28, align: 'right' });
    doc.text(String(r.pct || ''), x[6], y, { width: 22, align: 'right' });
    doc.text(formatCurrency(r.net || 0), x[7], y, { width: 30, align: 'right' });
    y += 16;
  });
  const total = rows.reduce(function (s, r) { return s + Number(r.net || 0); }, 0);
  doc.font('Helvetica-Bold').fontSize(9).text('Total net value after exemptions or reliefs: ' + formatCurrency(total), 40, y + 4);
  return y + 20;
}

function renderIncomeAnalysis(doc, income, startY, incomeGifts) {
  let y = startY;
  const years = Object.keys(income || {}).sort();
  if (!years.length) {
    doc.font('Helvetica').fontSize(9).text('No income/expenditure data recorded.', 40, y);
    return y + 16;
  }
  years.forEach(function (year) {
    if (y > 680) { doc.addPage(); y = 115; }
    const rec = income[year];
    const giftsTotal = incomeGifts.filter(function (g) { return taxYearLabel(g.date) === year; }).reduce(function (s, g) { return s + Number(g.amount || 0); }, 0);
    doc.font('Helvetica-Bold').fontSize(10).text('Tax year ' + year, 40, y); y += 14;
    doc.font('Helvetica').fontSize(9);
    doc.text('Box 20 Income: salary ' + formatCurrency(rec.salary || 0) + ', pensions ' + formatCurrency(rec.pensions || 0) + ', interest/ISA ' + formatCurrency(rec.interest || 0) + ', investments ' + formatCurrency(rec.investments || 0) + ', rents ' + formatCurrency(rec.rents || 0) + ', annuities ' + formatCurrency(rec.annuities || 0) + ', other ' + formatCurrency(rec.other || 0) + ', less Income Tax ' + formatCurrency(rec.tax || 0) + ', net income ' + formatCurrency(rec.net || 0), 40, y, { width: 515 });
    y += 24;
    doc.text('Box 21 Expenditure: mortgages ' + formatCurrency(rec.mortgages || 0) + ', insurance ' + formatCurrency(rec.insurance || 0) + ', household bills ' + formatCurrency(rec.household || 0) + ', council tax ' + formatCurrency(rec.councilTax || 0) + ', travelling ' + formatCurrency(rec.travel || 0) + ', entertainment ' + formatCurrency(rec.entertainment || 0) + ', holidays ' + formatCurrency(rec.holidays || 0) + ', nursing home fees ' + formatCurrency(rec.nursing || 0) + ', other ' + formatCurrency(rec.otherExp || 0) + ', total expenditure ' + formatCurrency(rec.totalExp || 0), 40, y, { width: 515 });
    y += 30;
    doc.font('Helvetica-Bold').fontSize(9).text('Box 22 Surplus/(deficit) income: ' + formatCurrency((rec.net || 0) - (rec.totalExp || 0)) + '    Gifts made: ' + formatCurrency(giftsTotal), 40, y);
    y += 18;
  });
  return y;
}
function renderGiftTable(doc, gifts, startY) {
  const cols = [40, 120, 280, 390, 470];
  let y = startY;
  doc.font('Helvetica-Bold').fontSize(9);
  doc.text('A Date', cols[0], y);
  doc.text('B Recipient', cols[1], y);
  doc.text('C Description', cols[2], y);
  doc.text('D Amount', cols[4], y, { width: 70, align: 'right' });
  y += 16;
  doc.font('Helvetica').fontSize(9);
  gifts.forEach(function (gift) {
    if (y > 760) {
      drawFooter(doc);
      doc.addPage();
      y = 110;
    }
    doc.text(gift.date || '', cols[0], y, { width: 70 });
    doc.text(gift.recipient || '', cols[1], y, { width: 150 });
    doc.text(gift.description || '', cols[2], y, { width: 100 });
    doc.text(Number(gift.amount || 0).toFixed(2), cols[4], y, { width: 70, align: 'right' });
    y += 14;
  });
  return y;
}

function renderSummaryTable(doc, title, summaryMap, startY) {
  let y = startY;
  doc.font('Helvetica-Bold').fontSize(11).text(title, 40, y);
  y += 18;
  doc.font('Helvetica').fontSize(9);
  Object.keys(summaryMap).sort().forEach(function (key) {
    if (y > 760) {
      drawFooter(doc);
      doc.addPage();
      y = 110;
    }
    doc.text(key, 40, y, { width: 300 });
    doc.text(Number(summaryMap[key] || 0).toFixed(2), 430, y, { width: 100, align: 'right' });
    y += 14;
  });
  return y;
}

const tmpDir = path.join(dataDir, 'tmp');
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    fs.mkdirSync(tmpDir, { recursive: true });
    cb(null, tmpDir);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname) || '';
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50);
    cb(null, base + '_' + Date.now() + ext);
  }
});
const upload = multer({ storage: storage, limits: { fileSize: MAX_UPLOAD_BYTES }, fileFilter: function(req, file, cb) { const allowed = ['.pdf']; const ext = require('path').extname(file.originalname || '').toLowerCase(); cb(null, allowed.includes(ext)); } });

const backupStorage = multer.diskStorage({
  destination: function (req, file, cb) { cb(null, dataDir); },
  filename: function (req, file, cb) { cb(null, 'backup_import_' + Date.now() + '.zip'); }
});
const backupUpload = multer({ storage: backupStorage, limits: { fileSize: 50 * 1024 * 1024 }, fileFilter: function(req, file, cb) { const ext = path.extname(file.originalname || '').toLowerCase(); cb(null, ext === '.zip'); } });
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/proofs', express.static(secureProofDir));
app.get('/', function (req, res) {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/state', function (req, res) {
  const db = readDb();
  res.json({ ok: true, today: todayIso(), data: db });
});

app.get('/api/data', function (req, res) {
  const db = readDb();
  res.json({ ok: true, today: todayIso(), data: db });
});

app.post('/api/settings', function (req, res) {
  const db = readDb();
  db.settings = req.body.settings || db.settings;
  writeDb(db);
  res.json({ ok: true, data: db });
});

app.post('/api/gifts', function (req, res) {
  const db = readDb();
  if (!req.body.date || !req.body.recipient || isNaN(Number(req.body.amount))) return res.status(400).json({ error: 'Missing required fields: date, recipient, amount' });
  const gift = Object.assign({}, req.body);
  gift.id = makeId('gift');
  gift.proofFiles = Array.isArray(gift.proofFiles) ? gift.proofFiles : [];
  gift.proofReference = gift.proofReference || '';
  db.gifts.push(gift);
  writeDb(db);
  auditLog('gift_create', { id: gift.id, recipient: gift.recipient, amount: gift.amount });
  res.json({ ok: true, gift: gift, data: db });
});

app.post('/api/expenditures', function (req, res) {
  const db = readDb();
  const item = Object.assign({}, req.body);
  item.id = makeId('exp');
  db.expenditures.push(item);
  writeDb(db);
  res.json({ ok: true, expenditure: item, data: db });
});

app.post('/api/upload-proof', upload.array('files'), function (req, res) {
  ensureDirs();
  const uploaded = [];
  const now = new Date();
  const dtPrefix = now.getFullYear() + pad2(now.getMonth()+1) + pad2(now.getDate()) + '_' + pad2(now.getHours()) + pad2(now.getMinutes()) + pad2(now.getSeconds());
  const recipient = safeNamePart(req.body.recipient || 'unknown-recipient');
  let giftType = 'Gifting_Out_Income';
  if (req.body.giftType === 'allowance') { giftType = 'Gift_Annual_Exemption'; }
  else if (req.body.giftType === 'seven-year') { giftType = 'Gifting_Seven_Year'; }
  (req.files || []).forEach(function (file, index) {
    const ext = path.extname(file.originalname) || '';
    const originalBase = safeNamePart(path.basename(file.originalname, ext)).slice(0, 40);
    const safeName = dtPrefix + '_' + recipient + '_' + giftType + '_' + originalBase + (index > 0 ? '_' + index : '') + ext;
    const target = path.join(proofDir, safeName);
    fs.renameSync(file.path, target);
    uploaded.push({ storedName: safeName, originalName: file.originalname, size: file.size });
  });
  res.json({ ok: true, files: uploaded });
});

app.put('/api/gifts/:id', function (req, res) {
  const db = readDb();
  const idx = (db.gifts || []).findIndex(function (g) { return g.id === req.params.id; });
  if (idx === -1) { return res.status(404).json({ error: 'Not found' }); }
  db.gifts[idx] = Object.assign({}, db.gifts[idx], req.body, { id: req.params.id });
  writeDb(db);
  auditLog('gift_update', { id: req.params.id });
  res.json({ ok: true, data: db });
});

app.delete('/api/gifts/:id', function (req, res) {
  const db = readDb();
  const gift = db.gifts.find(function (g) { return g.id === req.params.id; });
  if (gift && Array.isArray(gift.proofFiles)) {
    gift.proofFiles.forEach(function (f) {
      try { fs.unlinkSync(path.join(proofDir, f)); } catch(e) {}
    });
  }
  db.gifts = db.gifts.filter(function (g) { return g.id !== req.params.id; });
  writeDb(db);
  auditLog('gift_delete', { id: req.params.id });
  res.json({ ok: true });
});



app.post('/api/allowance-gifts', function (req, res) {
  const db = readDb();
  if (!db.allowanceGifts) { db.allowanceGifts = []; }
  const gift = Object.assign({ id: makeId('allow') }, req.body);
  db.allowanceGifts.push(gift);
  writeDb(db);
  res.json({ ok: true, data: db });
});

app.put('/api/allowance-gifts/:id', function (req, res) {
  const db = readDb();
  if (!db.allowanceGifts) { db.allowanceGifts = []; }
  const idx = db.allowanceGifts.findIndex(function (g) { return g.id === req.params.id; });
  if (idx === -1) { return res.status(404).json({ error: 'Not found' }); }
  db.allowanceGifts[idx] = Object.assign({}, db.allowanceGifts[idx], req.body, { id: req.params.id });
  writeDb(db);
  res.json({ ok: true, data: db });
});

app.delete('/api/allowance-gifts/:id', function (req, res) {
  const db = readDb();
  const gift = (db.allowanceGifts || []).find(function (g) { return g.id === req.params.id; });
  if (gift && Array.isArray(gift.proofFiles)) {
    gift.proofFiles.forEach(function (fname) {
      const fpath = path.join(proofDir, fname);
      try { if (fs.existsSync(fpath)) { fs.unlinkSync(fpath); } } catch (e) {}
    });
  }
  db.allowanceGifts = (db.allowanceGifts || []).filter(function (g) { return g.id !== req.params.id; });
  writeDb(db);
  res.json({ ok: true, data: db });
});

app.post('/api/allowance-gifts/:id/upload', upload.array('files'), function (req, res) {
  ensureDirs();
  const db = readDb();
  if (!db.allowanceGifts) { db.allowanceGifts = []; }
  const idx = db.allowanceGifts.findIndex(function (g) { return g.id === req.params.id; });
  if (idx === -1) { return res.status(404).json({ error: 'Not found' }); }
  if (!db.allowanceGifts[idx].proofFiles) { db.allowanceGifts[idx].proofFiles = []; }
  const recipient = safeNamePart(db.allowanceGifts[idx].recipient || 'unknown');
  const now = new Date();
  const dtPrefix = now.getFullYear() + pad2(now.getMonth()+1) + pad2(now.getDate()) + '_' + pad2(now.getHours()) + pad2(now.getMinutes()) + pad2(now.getSeconds());
  (req.files || []).forEach(function (file, i) {
    const ext = path.extname(file.originalname) || '';
    const origBase = safeNamePart(path.basename(file.originalname, ext)).slice(0, 40);
    const finalName = dtPrefix + '_' + recipient + '_Gift_Annual_Exemption_' + origBase + (i > 0 ? '_' + i : '') + ext;
    const dest = path.join(proofDir, finalName);
    fs.renameSync(file.path, dest);
    db.allowanceGifts[idx].proofFiles.push(finalName);
  });
  writeDb(db);
  res.json({ ok: true, data: db, files: db.allowanceGifts[idx].proofFiles });
});


app.post('/api/test-data/generate', function (req, res) {
  const db = readDb();
  const count = Math.max(1, Math.min(1000, Number(req.body.count || 25)));
  const recipients = (db.settings.recipients || []).filter(Boolean);
  const methods = ['Bank transfer', 'Cheque', 'Cash', 'Standing order'];
  const incomeTypes = ['Salary', 'Pension', 'Rental income', 'Dividends', 'Interest'];
  const reasons = ['Birthday gift', 'School fees help', 'Wedding contribution', 'Regular support', 'Household support'];
  const today = new Date();
  const startYear = today.getFullYear() - 3;
  for (let i = 0; i < count; i += 1) {
    const month = Math.floor(Math.random() * 12);
    const day = 1 + Math.floor(Math.random() * 28);
    const year = startYear + Math.floor(Math.random() * 3);
    const amount = 50 + Math.floor(Math.random() * 451);
    const giftDate = new Date(year, month, day);
    const iso = giftDate.toISOString().slice(0, 10);
    const recipient = recipients.length ? recipients[Math.floor(Math.random() * recipients.length)] : 'Recipient ' + (i + 1);
    db.gifts.push({
      id: makeId('gift'),
      date: iso,
      recipient: recipient,
      amount: amount,
      method: methods[Math.floor(Math.random() * methods.length)],
      description: reasons[Math.floor(Math.random() * reasons.length)],
      incomeType: incomeTypes[Math.floor(Math.random() * incomeTypes.length)],
      proofReference: Math.random() > 0.35 ? 'REF-' + String(1000 + i) : '',
      notes: 'Generated test data',
      proofFiles: []
    });
  }
  writeDb(db);
  res.json({ ok: true, data: db });
});


function monthInTaxYear(year, month, taxYearLabel2) {
  // taxYearLabel2 e.g. "2025/26"
  const startYear = parseInt(taxYearLabel2.split('/')[0], 10);
  // Tax year runs Apr (month4) of startYear to Mar (month3) of startYear+1
  if (year === startYear && month >= 4) { return true; }
  if (year === startYear + 1 && month <= 3) { return true; }
  return false;
}

function buildExpAuditData(db, yr) {
  const expTables = db.expTables || {};
  const incomeGifts = db.gifts || [];
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  // collect all year/month combos
  const keys = Object.keys(expTables);
  const combos = [];
  keys.forEach(function (k) {
    const m = k.match(/^exp_(\d+)_(\d+)_(income|expenditure)$/);
    if (!m) { return; }
    const y = parseInt(m[1], 10); const mo = parseInt(m[2], 10); const mode = m[3];
    if (yr !== 'all' && !monthInTaxYear(y, mo, yr)) { return; }
    combos.push({ y: y, mo: mo, mode: mode, key: k, tbl: expTables[k] });
  });
  combos.sort(function (a, b) { return a.y !== b.y ? a.y - b.y : a.mo !== b.mo ? a.mo - b.mo : a.mode.localeCompare(b.mode); });
  // build by tax year -> month -> mode
  const byTaxYear = {};
  combos.forEach(function (c) {
    const tyLabel = c.mo >= 4 ? c.y + '/' + String(c.y + 1).slice(-2) : (c.y - 1) + '/' + String(c.y).slice(-2);
    if (!byTaxYear[tyLabel]) { byTaxYear[tyLabel] = {}; }
    const mKey = c.y + '-' + String(c.mo).padStart(2, '0');
    if (!byTaxYear[tyLabel][mKey]) { byTaxYear[tyLabel][mKey] = { y: c.y, mo: c.mo, monthName: months[c.mo - 1] + ' ' + c.y, income: [], expenditure: [] }; }
    const tbl = c.tbl || {};
    (tbl.rows || []).forEach(function (row) {
      byTaxYear[tyLabel][mKey][c.mode].push({
        name: row.name || '',
        amount: Number(row.amount || 0),
        description: row.description || '',
        incomeType: row.incomeType || '',
        category: row.category || ''
      });
    });
  });
  // also compute gift totals per tax year
  const giftsByTy = {};
  incomeGifts.forEach(function (g) {
    const ty2 = taxYearLabel(g.date);
    if (yr !== 'all' && ty2 !== yr) { return; }
    giftsByTy[ty2] = (giftsByTy[ty2] || 0) + Number(g.amount || 0);
  });
  return { byTaxYear: byTaxYear, giftsByTy: giftsByTy };
}

app.get('/api/pdf/exp-audit', function (req, res) {
  const db = readDb();
  const yr = req.query.year || 'all';
  const { byTaxYear, giftsByTy } = buildExpAuditData(db, yr);
  const title = yr === 'all' ? 'Expenditure Audit Log' : 'Expenditure Audit Log - ' + yr;
  res.setHeader('Content-Disposition', 'attachment; filename="expenditure-audit.pdf"');
  const doc = startPdf(res, 'expenditure-audit.pdf');
  drawHeader(doc, db.settings, title);

  let y = 115;
  doc.font('Helvetica-Bold').fontSize(11).text('Expenditure Audit Log for IHT403 / Normal Expenditure Out of Income claim', 40, y); y += 14;
  doc.font('Helvetica').fontSize(8).text('This schedule supports HMRC IHT403 page 8 Box 20 (income), Box 21 (expenditure) and Box 22 (surplus). All amounts in GBP.', 40, y, { width: 520 }); y += 20;

  const tyKeys = Object.keys(byTaxYear).sort();
  if (!tyKeys.length) {
    doc.font('Helvetica').fontSize(9).text('No expenditure data recorded for the selected period.', 40, y);
    doc.end(); return;
  }

  tyKeys.forEach(function (ty2) {
    if (y > 680) { doc.addPage(); drawHeader(doc, db.settings, title); y = 115; }
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#01696f').text('Tax Year ' + ty2, 40, y); doc.fillColor('black');
    y += 16;
    const months2 = Object.keys(byTaxYear[ty2]).sort();
    let tyIncTotal = 0, tyExpTotal = 0;
    months2.forEach(function (mKey) {
      const mData = byTaxYear[ty2][mKey];
      if (y > 650) { doc.addPage(); drawHeader(doc, db.settings, title); y = 115; }
      doc.font('Helvetica-Bold').fontSize(10).text(mData.monthName, 40, y); y += 12;
      // Income rows
      if (mData.income.length) {
        doc.font('Helvetica-Bold').fontSize(8).text('Income', 50, y); y += 10;
        const incHead = ['Name / Source', 'Income type', 'Amount', 'Description'];
        const icx = [50, 200, 330, 385];
        doc.font('Helvetica-Bold').fontSize(7);
        incHead.forEach(function (h, i) { doc.text(h, icx[i], y, { width: i === 3 ? 160 : 140 }); }); y += 10;
        doc.moveTo(50, y).lineTo(550, y).stroke('#ccc'); y += 3;
        doc.font('Helvetica').fontSize(8);
        let incTotal = 0;
        mData.income.forEach(function (r) {
          if (y > 720) { doc.addPage(); drawHeader(doc, db.settings, title); y = 115; }
          incTotal += r.amount;
          doc.text(String(r.name || ''), icx[0], y, { width: 145 });
          doc.text(String(r.incomeType || ''), icx[1], y, { width: 125 });
          doc.text(formatCurrency(r.amount), icx[2], y, { width: 50, align: 'right' });
          doc.text(String(r.description || ''), icx[3], y, { width: 160 });
          y += 12;
        });
        doc.font('Helvetica-Bold').fontSize(8).text('Month income total: ' + formatCurrency(incTotal), 50, y, { align: 'right', width: 490 }); y += 12;
        tyIncTotal += incTotal;
      }
      // Expenditure rows
      if (mData.expenditure.length) {
        doc.font('Helvetica-Bold').fontSize(8).text('Expenditure', 50, y); y += 10;
        const exHead = ['Name / Item', 'Category', 'Amount', 'Description'];
        const ecx = [50, 200, 330, 385];
        doc.font('Helvetica-Bold').fontSize(7);
        exHead.forEach(function (h, i) { doc.text(h, ecx[i], y, { width: i === 3 ? 160 : 140 }); }); y += 10;
        doc.moveTo(50, y).lineTo(550, y).stroke('#ccc'); y += 3;
        doc.font('Helvetica').fontSize(8);
        let expTotal = 0;
        mData.expenditure.forEach(function (r) {
          if (y > 720) { doc.addPage(); drawHeader(doc, db.settings, title); y = 115; }
          expTotal += r.amount;
          doc.text(String(r.name || ''), ecx[0], y, { width: 145 });
          doc.text(String(r.category || ''), ecx[1], y, { width: 125 });
          doc.text(formatCurrency(r.amount), ecx[2], y, { width: 50, align: 'right' });
          doc.text(String(r.description || ''), ecx[3], y, { width: 160 });
          y += 12;
        });
        doc.font('Helvetica-Bold').fontSize(8).text('Month expenditure total: ' + formatCurrency(expTotal), 50, y, { align: 'right', width: 490 }); y += 12;
        tyExpTotal += expTotal;
      }
      y += 6;
    });
    // Tax year summary
    if (y > 660) { doc.addPage(); drawHeader(doc, db.settings, title); y = 115; }
    const giftsTotal = giftsByTy[ty2] || 0;
    const surplus = tyIncTotal - tyExpTotal - giftsTotal;
    doc.rect(40, y, 515, 46).fill('#f3f0ec'); doc.fillColor('black');
    doc.font('Helvetica-Bold').fontSize(9);
    doc.text('Tax year ' + ty2 + ' summary (Box 20/21/22)', 46, y + 6);
    doc.font('Helvetica').fontSize(9);
    doc.text('Total income (Box 20): ' + formatCurrency(tyIncTotal) + '   |   Total expenditure (Box 21): ' + formatCurrency(tyExpTotal) + '   |   Income gifts: ' + formatCurrency(giftsTotal), 46, y + 20, { width: 510 });
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#01696f').text('Surplus after expenditure and gifts (Box 22 basis): ' + formatCurrency(surplus), 46, y + 34, { width: 510 }); doc.fillColor('black');
    y += 58;
  });
  doc.end();
});

app.get('/api/csv/exp-audit', function (req, res) {
  const db = readDb();
  const yr = req.query.year || 'all';
  const { byTaxYear, giftsByTy } = buildExpAuditData(db, yr);
  const rows = [['Tax Year','Month','Type','Name / Source','Income Type / Category','Amount (GBP)','Description']];
  const tyKeys = Object.keys(byTaxYear).sort();
  tyKeys.forEach(function (ty2) {
    const months2 = Object.keys(byTaxYear[ty2]).sort();
    months2.forEach(function (mKey) {
      const mData = byTaxYear[ty2][mKey];
      mData.income.forEach(function (r) {
        rows.push([ty2, mData.monthName, 'Income', r.name, r.incomeType, r.amount.toFixed(2), r.description]);
      });
      mData.expenditure.forEach(function (r) {
        rows.push([ty2, mData.monthName, 'Expenditure', r.name, r.category, r.amount.toFixed(2), r.description]);
      });
    });
    const tyInc = Object.values(byTaxYear[ty2]).reduce(function (s, m) { return s + m.income.reduce(function (a, r) { return a + r.amount; }, 0); }, 0);
    const tyExp = Object.values(byTaxYear[ty2]).reduce(function (s, m) { return s + m.expenditure.reduce(function (a, r) { return a + r.amount; }, 0); }, 0);
    rows.push([ty2, '-- YEAR TOTAL --', 'Income total', '', '', tyInc.toFixed(2), '']);
    rows.push([ty2, '-- YEAR TOTAL --', 'Expenditure total', '', '', tyExp.toFixed(2), '']);
    rows.push([ty2, '-- YEAR TOTAL --', 'Income gifts total', '', '', (giftsByTy[ty2] || 0).toFixed(2), '']);
    rows.push([ty2, '-- YEAR TOTAL --', 'Surplus (Box 22 basis)', '', '', (tyInc - tyExp - (giftsByTy[ty2] || 0)).toFixed(2), '']);
    rows.push([]);
  });
  function csvEscape(v) { const s = String(v == null ? '' : v); if (/[",\n]/.test(s)) { return '"' + s.replace(/"/g, '""') + '"'; } return s; }
  const csv = rows.map(function (r) { return r.map(csvEscape).join(','); }).join('\r\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="expenditure-audit.csv"');
  res.end(csv);
});

app.delete('/api/transactions/all', function (req, res) {
  const db = readDb();
  const which = req.query.which || 'all';
  if (which === 'all' || which === 'gifts') { db.gifts = []; }
  if (which === 'all' || which === 'allowance') { db.allowanceGifts = []; }
  if (which === 'all' || which === 'sevenyear') { db.sevenYearGifts = []; }
  if (which === 'all' || which === 'expenditure') { db.expTables = {}; db.expenditures = []; }
  // delete proof files if clearing gifts
  if (which === 'all' || which === 'gifts' || which === 'allowance' || which === 'sevenyear') {
    try {
      const files = fs.readdirSync(proofDir);
      files.forEach(function (f) { try { fs.unlinkSync(path.join(proofDir, f)); } catch(e){} });
    } catch(e) {}
  }
  writeDb(db);
  res.json({ ok: true, data: db });
});

app.post('/api/test-data/clear', function (req, res) {
  const db = readDb();
  db.gifts = db.gifts.filter(function (gift) {
    return gift.notes !== 'Generated test data';
  });
  writeDb(db);
  res.json({ ok: true, data: db });
});

app.post('/api/seven-year-gifts', function (req, res) {
  const db = readDb();
  if (!db.sevenYearGifts) { db.sevenYearGifts = []; }
  const gift = Object.assign({ id: makeId('sy'), proofFiles: [] }, req.body);
  db.sevenYearGifts.push(gift);
  writeDb(db);
  res.json({ ok: true, data: db });
});

app.delete('/api/seven-year-gifts/:id', function (req, res) {
  const db = readDb();
  const gift = (db.sevenYearGifts || []).find(function (g) { return g.id === req.params.id; });
  if (gift && Array.isArray(gift.proofFiles)) {
    gift.proofFiles.forEach(function (fname) {
      const fpath = path.join(proofDir, fname);
      try { if (fs.existsSync(fpath)) { fs.unlinkSync(fpath); } } catch (e) {}
    });
  }
  db.sevenYearGifts = (db.sevenYearGifts || []).filter(function (g) { return g.id !== req.params.id; });
  writeDb(db);
  res.json({ ok: true, data: db });
});

app.get('/api/backup/export', function (req, res) {
  ensureDirs();
  const backupName = todayIso() + '_iht-gift-tracker-backup.zip';
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="' + backupName + '"');
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', function (err) { res.status(500).end(err.message); });
  archive.pipe(res);
  archive.file(dbPath, { name: 'db.json' });
  if (fs.existsSync(proofDir)) {
    archive.directory(proofDir, 'proofs');
  }
  archive.finalize();
});

app.post('/api/backup/import', backupUpload.single('backup'), function (req, res) {
  if (!req.file) {
    return res.status(400).json({ ok: false, error: 'Backup zip is required.' });
  }
  ensureDirs();
  const zip = new AdmZip(req.file.path);
  const entries = zip.getEntries().map(function (entry) { return entry.entryName; });
  if (!entries.includes('db.json')) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ ok: false, error: 'Backup is missing db.json.' });
  }
  const dbJson = zip.readAsText('db.json');
  const parsed = JSON.parse(dbJson);
  fs.writeFileSync(dbPath, JSON.stringify(parsed, null, 2), 'utf8');
  if (fs.existsSync(proofDir)) {
    fs.rmSync(proofDir, { recursive: true, force: true });
  }
  fs.mkdirSync(proofDir, { recursive: true });
  zip.getEntries().forEach(function (entry) {
    if (entry.entryName.startsWith('proofs/') && !entry.isDirectory) {
      const name = entry.entryName.replace('proofs/', '');
      const target = path.join(proofDir, path.basename(name));
      fs.writeFileSync(target, entry.getData());
    }
  });
  fs.unlinkSync(req.file.path);
  return res.json({ ok: true, data: readDb() });
});

app.post('/api/exp-tables', function (req, res) {
  const db = readDb();
  const incoming = req.body.expTables || {};
  db.expTables = Object.assign({}, db.expTables || {}, incoming);
  writeDb(db);
  res.json({ ok: true, data: db });
});

app.delete('/api/exp-tables', function (req, res) {
  const db = readDb();
  db.expTables = {};
  writeDb(db);
  res.json({ ok: true, data: db });
});

app.get('/api/reports/tax-year', function (req, res) {
  const db = readDb();
  const yr = req.query.year || 'all';
  const filterYr = function(g){ return yr === 'all' || taxYearLabel(g.date) === yr; };
  const income = (db.gifts || []).filter(filterYr).map(function(g){ return Object.assign({}, g, {_type:'Income'}); });
  const allow = (db.allowanceGifts || []).filter(filterYr).map(function(g){ return Object.assign({}, g, {_type:'Annual Exemption'}); });
  const sy = (db.sevenYearGifts || []).filter(filterYr).map(function(g){ return Object.assign({}, g, {_type:'7-Year Rule'}); });
  const all = income.concat(allow).concat(sy).sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); });
  res.json({ ok: true, gifts: all, income: income, allowance: allow, sevenYear: sy });
});

app.get('/api/reports/general', function (req, res) {
  const db = readDb();
  const yr = req.query.year || 'all';
  const filterYr = function(g){ return yr === 'all' || taxYearLabel(g.date) === yr; };
  const income = (db.gifts || []).filter(filterYr).map(function(g){ return Object.assign({}, g, {_type:'Income'}); });
  const allow = (db.allowanceGifts || []).filter(filterYr).map(function(g){ return Object.assign({}, g, {_type:'Annual Exemption'}); });
  const sy = (db.sevenYearGifts || []).filter(filterYr).map(function(g){ return Object.assign({}, g, {_type:'7-Year Rule'}); });
  const all = income.concat(allow).concat(sy).sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); });
  const summary = summariseGifts(all);
  res.json({ ok: true, gifts: all, income: income, allowance: allow, sevenYear: sy, summary: summary });
});

app.get('/api/pdf/iht403', function (req, res) {
  const db = readDb();
  const yr = req.query.year || 'all';
  const incomeGifts = yr === 'all' ? (db.gifts || []) : (db.gifts || []).filter(function (g) { return taxYearLabel(g.date) === yr; });
  const allowanceGifts = yr === 'all' ? (db.allowanceGifts || []) : (db.allowanceGifts || []).filter(function (g) { return taxYearLabel(g.date) === yr; });
  const sevenYearGifts = yr === 'all' ? (db.sevenYearGifts || []) : (db.sevenYearGifts || []).filter(function (g) { return taxYearLabel(g.date) === yr; });
  const allGifts = incomeGifts.concat(allowanceGifts).concat(sevenYearGifts).sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); });
  if (!allGifts.length) {
    return res.status(400).json({ error: 'No gift records found. Add some gifts before generating this report.' });
  }
  const pdfTitle = yr === 'all' ? 'IHT403 attached schedule' : 'IHT403 attached schedule - ' + yr;
  res.setHeader('Content-Disposition', 'attachment; filename="iht403-schedule.pdf"');
  const doc = startPdf(res, 'iht403-schedule.pdf');
  drawHeader(doc, db.settings, pdfTitle);
  doc.font('Helvetica-Bold').fontSize(12).text('Schedule IHT403 - Gifts and other transfers of value', 40, 115);
  doc.font('Helvetica').fontSize(9).text('Prepared as an attached schedule to support HMRC IHT403. Includes relevant details for Box 7 gifts table and Box 20/21/22 gifts out of income analysis.', 40, 131, { width: 520 });
  let y = 150;
  doc.font('Helvetica-Bold').fontSize(11).text('Page 1 questions summary', 40, y);
  y += 16;
  doc.font('Helvetica').fontSize(9);
  doc.text('Q1 Gifts/transfers to individuals or organisations: ' + (allGifts.length ? 'Yes' : 'No'), 40, y); y += 12;
  doc.text('Q2 Trust or settlement created: No data recorded in this tracker.', 40, y); y += 12;
  doc.text('Q3 Additional assets transferred into trust: No data recorded in this tracker.', 40, y); y += 12;
  doc.text('Q4 Premiums on life assurance for others: No data recorded in this tracker.', 40, y); y += 12;
  doc.text('Q5 Benefit from trust/settlement ending: No data recorded in this tracker.', 40, y); y += 12;
  doc.text('Q6 Gifts claimed as normal expenditure out of income: ' + (incomeGifts.length ? 'Yes' : 'No'), 40, y); y += 18;

  doc.font('Helvetica-Bold').fontSize(11).text('Box 7 - Gifts made within the 7 years before death / recorded period', 40, y);
  y += 16;
  const rows = allGifts.map(function (g) {
    const type = g.giftType || (g.incomeType ? 'Income gift' : (g.method ? 'Cash gift' : 'Gift'));
    const rel = g.relationship ? ' (' + g.relationship + ')' : '';
    const exemption = g._type || (g.giftType ? g.giftType : (g.incomeType ? 'Normal expenditure out of income claimed separately' : 'Annual exemption / other'));
    return {
      date: g.date,
      recipient: (g.recipient || '') + rel,
      desc: g.description || type,
      exemption: exemption,
      amount: Number(g.amount || 0),
      deduct: 0,
      pct: '',
      net: Number(g.amount || 0)
    };
  });
  y = renderIht403ExtendedTable(doc, rows, y);

  const earlierTransfers = sevenYearGifts.filter(function (g) { return g.giftType === 'CLT'; }).map(function (g) {
    return { date: g.date, recipient: g.recipient || '', desc: g.description || 'Chargeable Lifetime Transfer', exemption: 'CLT', amount: Number(g.amount || 0), deduct: 0, pct: '', net: Number(g.amount || 0) };
  });
  if (y > 640) { doc.addPage(); drawHeader(doc, db.settings, pdfTitle); y = 115; }
  doc.font('Helvetica-Bold').fontSize(11).text('Box 19 - Earlier chargeable transfers before the earliest gifts shown at Box 7', 40, y);
  y += 16;
  if (!earlierTransfers.length) {
    doc.font('Helvetica').fontSize(9).text('None recorded in this tracker.', 40, y); y += 16;
  } else {
    y = renderIht403ExtendedTable(doc, earlierTransfers, y);
  }

  const income = incomeSummary(db.expenditures);
  if (y > 600) { doc.addPage(); drawHeader(doc, db.settings, pdfTitle); y = 115; }
  doc.font('Helvetica-Bold').fontSize(11).text('Page 8 - Boxes 20, 21 and 22: gifts made as part of normal expenditure out of income', 40, y);
  y += 16;
  doc.font('Helvetica').fontSize(9).text('Only years in which gifts out of income were recorded are shown below.', 40, y); y += 14;
  y = renderIncomeAnalysis(doc, income, y, incomeGifts);
  doc.end();
});

app.get('/api/pdf/general', function (req, res) {
  const db = readDb();
  const yr = req.query.year || 'all';
  const filteredGifts = yr === 'all' ? (db.gifts || []) : (db.gifts || []).filter(function (g) { return taxYearLabel(g.date) === yr; });
  if (!filteredGifts.length) {
    return res.status(400).json({ error: 'No gift records found. Add some gifts before generating this report.' });
  }
  const summary = summariseGifts(filteredGifts);
  res.setHeader('Content-Disposition', 'attachment; filename="general-gifts-report.pdf"');
  const doc = startPdf(res, 'general-gifts-report.pdf');
  drawHeader(doc, db.settings, 'General gifts report');
  doc.font('Helvetica-Bold').fontSize(12).text('Gift schedule', 40, 115);
  let y = renderGiftTable(doc, filteredGifts, 135);
  y += 18;
  y = renderSummaryTable(doc, 'Summary by recipient', summary.byRecipient, y);
  y += 18;
  y = renderSummaryTable(doc, 'Summary by tax year', summary.byTaxYear, y);
  if (y > 740) {
    drawFooter(doc);
    doc.addPage();
    y = 110;
  }
  doc.font('Helvetica-Bold').fontSize(11).text('Grand total', 40, y);
  doc.font('Helvetica').fontSize(10).text(Number(summary.grandTotal).toFixed(2), 430, y, { width: 100, align: 'right' });
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    drawHeader(doc, db.settings, 'General gifts report');
    drawFooter(doc);
  }
  doc.end();
});


app.get('/api/audit', function (req, res) {
  const lines = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean) : [];
  res.json({ ok: true, entries: lines.map(function(l) { try { return JSON.parse(l); } catch { return l; } }) });
});
app.listen(PORT, function () {
  ensureDirs();
  readDb();
  console.log('IHT Gift Tracker running on http://localhost:' + PORT);
});
