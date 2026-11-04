// ============================================================================
// db.js: shared data layer (Admin, Public site, Student & Warden portals)
// Firestore = source of truth. localStorage = local cache for fast rendering.
//   hostel_system/{TENANT}                    -> settings, rooms, students, expenses, logs...
//   hostel_system/{TENANT}/applications/{id}  -> one document per admission application
// ============================================================================

const firebaseConfig = {
  apiKey: "AIzaSyCRXCp75adfyFUbyZHlgRGQtu2vqb-TPMM",
  authDomain: "hostel-cloud-pk.firebaseapp.com",
  projectId: "hostel-cloud-pk",
  storageBucket: "hostel-cloud-pk.firebasestorage.app",
  messagingSenderId: "394742737685",
  appId: "1:394742737685:web:a8faef1ab5bf69d84e971c"
};

const MASTER_FOUNDER_EMAIL = "jameelfaisal177@gmail.com";
const MASTER_FOUNDER_PASS = "Qwerty@12345";

const emptyDB = {
  settings: {
    hostelName: "Hostel ERP Console",
    jazzcash: "JazzCash / Easypaisa: Not Set",
    bankAccount: "Bank Account: Not Set",
    adminWhatsApp: "",
    adminEmail: MASTER_FOUNDER_EMAIL,
    adminPass: MASTER_FOUNDER_PASS,
    wardenEmail: MASTER_FOUNDER_EMAIL,
    wardenPass: MASTER_FOUNDER_PASS,
    isSuspended: false
  },
  rooms: [], students: [], applications: [], complaints: [], leaves: [],
  visitors: [], expenses: [], inventory: [], staff: [], messMenu: [], logs: []
};

function nowTime() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function freshDB() {
  const d = JSON.parse(JSON.stringify(emptyDB));
  d.logs = [{ time: nowTime(), actor: "System", action: "System ready." }];
  return d;
}
function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function digitsOnly(s) {
  return String(s || "").replace(/\D/g, "");
}

// ============================================================================
// 1. TENANT, CLOUD REFS & PAGE DETECTION
// ============================================================================
const urlParams = new URLSearchParams(window.location.search);
const TENANT_ID = (urlParams.get("hostel") || localStorage.getItem("SAAS_TENANT_ID") || "main_hostel")
  .toLowerCase().replace(/[^a-z0-9_-]/g, "");
try { localStorage.setItem("SAAS_TENANT_ID", TENANT_ID); } catch (e) {}

const DB_KEY = "HOSTEL_SAAS_DB_" + TENANT_ID;
const PAGE_STARTED_AT = new Date().toISOString();

let _fs = null;
let _cloudStarted = false;

function fsDB() {
  if (_fs) return _fs;
  if (typeof firebase !== "undefined" && firebase.apps && firebase.apps.length && typeof firebase.firestore === "function") {
    _fs = firebase.firestore();
  }
  return _fs;
}
function mainRef() {
  const f = fsDB();
  return f ? f.collection("hostel_system").doc(TENANT_ID) : null;
}
function appsRef() {
  const m = mainRef();
  return m ? m.collection("applications") : null;
}
function isMasterPage() {
  return location.pathname.toLowerCase().includes("master") || !!document.getElementById("masterLoginGate");
}
function isAdminPage() {
  return !!document.getElementById("adminLoginGate") && !isMasterPage();
}

// ============================================================================
// 2. CLOUD INIT & LISTENERS
// ============================================================================
function initCloud() {
  if (typeof firebase === "undefined") return;
  if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);

  const start = () => {
    if (_cloudStarted) return;
    _cloudStarted = true;
    startMainListener();
    startApplicationsListener();
  };

  if (typeof firebase.auth === "function") {
    firebase.auth().onAuthStateChanged(user => {
      if (!user) firebase.auth().signInAnonymously().catch(() => {});
      else start();
    });
    setTimeout(start, 3000); // fallback if anonymous auth is not enabled
  } else {
    start();
  }
}

function waitForCloud(timeout = 8000) {
  return new Promise(resolve => {
    const t0 = Date.now();
    (function poll() {
      if (fsDB() || Date.now() - t0 > timeout) return resolve(!!fsDB());
      setTimeout(poll, 200);
    })();
  });
}

function showSuspendedScreen(name) {
  document.body.innerHTML = `
    <div style="background:#020617;color:white;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:sans-serif;text-align:center;padding:24px;">
      <div style="width:70px;height:70px;border-radius:20px;background:rgba(244,63,94,0.15);border:1px solid rgba(244,63,94,0.4);display:flex;align-items:center;justify-content:center;font-size:32px;color:#f43f5e;margin-bottom:16px;">🔒</div>
      <h1 style="color:#f43f5e;font-size:26px;font-weight:800;margin:0;">Software License Suspended</h1>
      <p style="color:#94a3b8;max-width:420px;margin-top:10px;font-size:14px;line-height:1.6;">
        Access to <strong>${esc(name)}</strong> has been temporarily locked due to an expired subscription.
      </p>
    </div>`;
}

function startMainListener() {
  const ref = mainRef();
  if (!ref) return;
  let first = true;

  ref.onSnapshot(snap => {
    if (!snap.exists) {
      if (!isMasterPage()) ref.set(JSON.parse(JSON.stringify(stripApps(getDB())))).catch(() => {});
      return;
    }
    const cloud = snap.data() || {};
    cloud.settings = cloud.settings || {};

    if (cloud.settings.isSuspended === true && !isMasterPage()) {
      return showSuspendedScreen(cloud.settings.hostelName || TENANT_ID);
    }

    // Old format: applications stored inside the main document. Move them to the subcollection once.
    if (Array.isArray(cloud.applications) && cloud.applications.length && !isMasterPage()) {
      migrateOldApplications(ref, cloud.applications);
    }

    const current = getDB();
    cacheWrite({ ...cloud, applications: current.applications });
    refreshCurrentPortalUI();

    if (first) {
      first = false;
      if (isAdminPage()) setTimeout(checkAndApplyAutoLateFine, 1500);
    }
  }, err => console.error("Firestore sync error:", err));
}

function startApplicationsListener() {
  const col = appsRef();
  if (!col) return;
  col.onSnapshot(snap => {
    const list = snap.docs.map(d => normalizeApp({ ...d.data(), id: d.id }));
    list.sort((a, b) => String(b.submittedAt || "").localeCompare(String(a.submittedAt || "")));

    const db = getDB();
    db.applications = list;
    cacheWrite(db);

    // Notify admin about applications that arrived after this page was opened
    if (isAdminPage()) {
      snap.docChanges().forEach(ch => {
        if (ch.type !== "added") return;
        const a = ch.doc.data();
        if (a.submittedAt && a.submittedAt > PAGE_STARTED_AT) {
          saveDB(getDB(), `New online application from ${a.name || "applicant"} (${ch.doc.id}) for Room ${a.room || "-"}`, "Public Site");
        }
      });
    }
    refreshCurrentPortalUI();
  }, err => console.error("Applications sync error:", err));
}

function migrateOldApplications(ref, list) {
  const col = appsRef();
  if (!col) return;
  try {
    const batch = fsDB().batch();
    list.forEach((a, i) => {
      const id = String(a.id || a.appId || ("APP-MIG-" + Date.now().toString(36) + i));
      batch.set(col.doc(id), normalizeApp({ ...a, id }), { merge: true });
    });
    batch.update(ref, { applications: firebase.firestore.FieldValue.delete() });
    batch.commit().catch(err => console.error("Migration failed:", err));
  } catch (err) {
    console.error("Migration error:", err);
  }
}

// ============================================================================
// 3. NORMALIZATION & LOCAL CACHE
// ============================================================================
function normalizeRoom(r) {
  const no = String(r.no ?? r.id ?? "").trim();
  return {
    ...r,
    no,
    id: no,
    type: r.type || "Standard Shared",
    capacity: Number(r.capacity || 0),
    rent: Number(r.rent || 0),
    mess: Number(r.mess || 0),
    security: Number(r.security || 0),
    facilities: r.facilities || ""
  };
}

function normalizeApp(a) {
  const id = String(a.id || a.appId || "");
  return {
    ...a,
    id,
    appId: id,
    room: String(a.room || a.preferredRoom || a.roomPref || ""),
    status: a.status || "Pending"
  };
}

function stripApps(db) {
  const { applications, ...rest } = db;
  return rest;
}

function cacheWrite(db) {
  try { localStorage.setItem(DB_KEY, JSON.stringify(db)); } catch (e) { console.warn("LocalStorage full:", e); }
}

function getDB() {
  let db = null;
  try { db = JSON.parse(localStorage.getItem(DB_KEY) || "null"); } catch (e) {}
  if (!db || typeof db !== "object") db = freshDB();

  db.settings = { ...JSON.parse(JSON.stringify(emptyDB.settings)), ...(db.settings || {}) };
  ["rooms", "students", "applications", "complaints", "leaves", "visitors", "expenses", "inventory", "staff", "messMenu", "logs"]
    .forEach(k => { if (!Array.isArray(db[k])) db[k] = []; });

  db.rooms = db.rooms.map(normalizeRoom);
  db.applications = db.applications.map(normalizeApp);
  return db;
}

function saveDB(db, actionText, actor = "Admin") {
  if (actionText) {
    db.logs = db.logs || [];
    db.logs.unshift({ time: nowTime(), actor, action: actionText });
    db.logs = db.logs.slice(0, 60);
  }
  cacheWrite(db);

  const ref = mainRef();
  if (ref) {
    ref.set(JSON.parse(JSON.stringify(stripApps(db))))
      .catch(err => console.error("Cloud save error:", err));
  }
  refreshCurrentPortalUI();
}

function refreshCurrentPortalUI() {
  if (typeof renderAdminAll === "function") renderAdminAll();
  if (typeof loadPublicSite === "function") loadPublicSite();
  if (typeof renderWardenConsole === "function") renderWardenConsole();
  if (typeof renderStudentDashboard === "function" && window.loggedStudent) renderStudentDashboard();
}

window.addEventListener("storage", e => {
  if (!e.key || e.key === DB_KEY) refreshCurrentPortalUI();
});

// ============================================================================
// 4. APPLICATIONS (separate collection, no overwrite conflicts)
// ============================================================================
async function submitApplication(app) {
  const db = getDB();
  db.applications = [normalizeApp(app), ...db.applications.filter(a => a.id !== app.id)];
  cacheWrite(db);
  refreshCurrentPortalUI();

  await waitForCloud();
  const col = appsRef();
  if (col) {
    col.doc(app.id).set(JSON.parse(JSON.stringify(app)))
      .catch(err => console.error("Application write failed:", err));
  }
}

function updateApplicationRemote(id, patch) {
  const col = appsRef();
  if (col) col.doc(id).update(patch).catch(err => console.error("Application update failed:", err));
}

function deleteApplicationRemote(id) {
  const col = appsRef();
  if (col) col.doc(id).delete().catch(err => console.error("Application delete failed:", err));
}

function setApplicationStatus(id, status) {
  const db = getDB();
  const a = db.applications.find(x => x.id === id);
  if (a) { a.status = status; cacheWrite(db); }
  updateApplicationRemote(id, { status });
  refreshCurrentPortalUI();
}

// ============================================================================
// 5. LIVE METRICS
// ============================================================================
function getLiveMetrics() {
  const db = getDB();
  const totalCapacity = db.rooms.reduce((sum, r) => sum + Number(r.capacity || 0), 0);
  const activeStudents = db.students.filter(s => s.status === "Active");
  const occupiedBeds = activeStudents.length;
  const emptyBeds = Math.max(0, totalCapacity - occupiedBeds);

  let collectedFee = 0, pendingFee = 0, paidCount = 0, unpaidCount = 0, totalSecurity = 0;

  activeStudents.forEach(s => {
    const secAmount = Number(s.security || 0);
    const secDue = s.securityPaid ? 0 : secAmount;
    const total = Number(s.rent || 0) + Number(s.mess || 0) + Number(s.elec || 0) + Number(s.otherCharges || 0) + secDue - Number(s.discount || 0);
    if (s.feeStatus === "Paid") {
      collectedFee += total; totalSecurity += secAmount; paidCount++;
    } else {
      pendingFee += total;
      if (s.securityPaid) totalSecurity += secAmount;
      unpaidCount++;
    }
  });

  const totalExpenses = db.expenses.reduce((sum, e) => sum + Number(e.amount || 0), 0);
  return {
    totalCapacity, occupiedBeds, emptyBeds,
    collectedFee, pendingFee, paidCount, unpaidCount,
    totalExpenses, netProfit: collectedFee - totalExpenses, totalSecurity,
    pendingApps: db.applications.filter(a => a.status === "Pending").length,
    openComplaints: db.complaints.filter(c => c.status !== "Resolved").length
  };
}

// ============================================================================
// 6. LOGIN (Admin / Warden / Student gates)
// ============================================================================
async function verifyAdminLogin(e) {
  if (e) e.preventDefault();
  const email = (document.getElementById("adminEmailInput")?.value || "").trim().toLowerCase();
  const pass = (document.getElementById("adminPassInput")?.value || "").trim();
  if (!email || !pass) return alert("⚠️ Please enter both Admin Email and Password!");

  await refreshFromCloudOnce();
  const set = getDB().settings;
  const savedEmail = (set.adminEmail || MASTER_FOUNDER_EMAIL).trim().toLowerCase();
  const savedPass = (set.adminPass || MASTER_FOUNDER_PASS).trim();
  const isFounder = email === MASTER_FOUNDER_EMAIL.toLowerCase() && pass === MASTER_FOUNDER_PASS;
  const isTenantAdmin = email === savedEmail && pass === savedPass;

  if (isFounder || isTenantAdmin) {
    try { sessionStorage.setItem("ADMIN_AUTH_" + TENANT_ID, "true"); } catch (err) {}
    const gate = document.getElementById("adminLoginGate");
    if (gate) gate.style.setProperty("display", "none", "important");
    if (typeof renderAdminAll === "function") renderAdminAll();
  } else {
    alert("❌ Access Denied!\nInvalid Admin Email or Password.");
  }
}

async function handleWardenLogin(e) {
  if (e) e.preventDefault();
  const email = (document.getElementById("wardenEmailInput")?.value || "").trim().toLowerCase();
  const pass = (document.getElementById("wardenPassInput")?.value || "").trim();
  if (!email || !pass) return alert("⚠️ Please enter both Warden Email and Password!");

  await refreshFromCloudOnce();
  const set = getDB().settings;
  const savedEmail = (set.wardenEmail || set.adminEmail || MASTER_FOUNDER_EMAIL).trim().toLowerCase();
  const savedPass = (set.wardenPass || MASTER_FOUNDER_PASS).trim();
  const isFounder = email === MASTER_FOUNDER_EMAIL.toLowerCase() && pass === MASTER_FOUNDER_PASS;
  const isWarden = email === savedEmail && pass === savedPass;

  if (isFounder || isWarden) {
    try { sessionStorage.setItem("WARDEN_AUTH_" + TENANT_ID, "true"); } catch (err) {}
    const gate = document.getElementById("wardenLoginGate");
    if (gate) gate.style.setProperty("display", "none", "important");
    if (typeof renderWardenConsole === "function") renderWardenConsole();
  } else {
    alert("❌ Access Denied!\nInvalid Warden Email or Password.");
  }
}

async function refreshFromCloudOnce() {
  const ref = mainRef();
  if (!ref) return;
  try {
    const snap = await ref.get();
    if (snap.exists) cacheWrite({ ...snap.data(), applications: getDB().applications });
  } catch (err) {}
}

// Adds email/password fields to student & warden gates if those pages don't already have them
function upgradePortalLoginGates() {
  const wardenForm = document.querySelector("#wardenLoginGate form");
  if (wardenForm && !document.getElementById("wardenEmailInput")) {
    const d = document.createElement("div");
    d.innerHTML = `<label class="block text-xs font-bold text-zinc-700 mb-1.5">Authorized Warden Email *</label>
      <input id="wardenEmailInput" type="email" required placeholder="Enter Registered Warden Email" class="w-full bg-zinc-50 border border-zinc-300 rounded-xl px-3.5 py-2.5 text-sm text-zinc-900 outline-none mb-3" />`;
    wardenForm.insertBefore(d, wardenForm.firstChild);
  }
  const stuForm = document.querySelector("#studentLoginGate form");
  if (stuForm && !document.getElementById("stuPassInput")) {
    const d = document.createElement("div");
    d.innerHTML = `<label class="block font-bold text-zinc-700 mb-1.5">Student Password / PIN *</label>
      <input id="stuPassInput" type="password" required placeholder="Enter password issued by Hostel Admin" class="w-full bg-zinc-50 border border-zinc-300 rounded-xl px-3.5 py-3 text-sm text-zinc-900 outline-none" />`;
    const btn = stuForm.querySelector("button[type='submit']");
    if (btn) stuForm.insertBefore(d, btn);
  }
}

// ============================================================================
// 7. IMAGE UPLOADS (KYC & logo)
// ============================================================================
function compressImageFile(file, maxW, quality, type, cb) {
  const reader = new FileReader();
  reader.onload = e => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxW / img.width);
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      cb(c.toDataURL(type, quality));
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

window.kycTempUploads = { photo: "", cnicFront: "", cnicBack: "" };

window.handleKYCFileUpload = function (inputEl, key, previewId) {
  const file = inputEl.files && inputEl.files[0];
  if (!file) return;
  compressImageFile(file, key === "photo" ? 260 : 480, 0.58, "image/jpeg", url => {
    window.kycTempUploads[key] = url;
    const prev = document.getElementById(previewId);
    if (prev) { prev.src = url; prev.classList.remove("hidden"); }
  });
};

window.handleHostelLogoUpload = function (inputEl) {
  const file = inputEl.files && inputEl.files[0];
  if (!file) return;
  compressImageFile(file, 200, 1, "image/png", url => {
    const db = getDB();
    db.settings.logo = url;
    saveDB(db, "Updated official hostel logo", "Admin");
    applyBrandLogoEverywhere();
    alert("✅ Official Hostel Logo Updated!");
  });
};

function applyBrandLogoEverywhere() {
  const db = getDB();
  const logoSrc = db.settings.logo || "logo.png";
  let fav = document.querySelector("link[rel='icon']");
  if (!fav) { fav = document.createElement("link"); fav.rel = "icon"; document.head.appendChild(fav); }
  fav.href = logoSrc;
}

// ============================================================================
// 8. VOUCHERS, CARDS, CERTIFICATES, MODALS
// ============================================================================
function injectUniversalModal() {
  if (document.getElementById("universalDocModal")) return;
  const div = document.createElement("div");
  div.id = "universalDocModal";
  div.className = "fixed inset-0 bg-zinc-950/85 hidden items-center justify-center z-50 p-3 sm:p-6 overflow-y-auto";
  div.innerHTML = `
    <div class="bg-zinc-900 border border-zinc-700 rounded-2xl max-w-5xl w-full p-4 sm:p-6 space-y-4 my-8 text-zinc-100 shadow-2xl">
      <div class="flex justify-between items-center border-b border-zinc-800 pb-3">
        <h3 id="uniModalTitle" class="text-sm sm:text-base font-extrabold text-white">Document Preview</h3>
        <button type="button" onclick="closeUniModal()" class="text-zinc-400 hover:text-white text-2xl leading-none px-2">&times;</button>
      </div>
      <div id="uniPrintArea" class="bg-white text-zinc-900 p-4 sm:p-6 rounded-xl overflow-x-auto"></div>
      <div class="flex flex-wrap justify-end gap-2.5 pt-2">
        <button type="button" onclick="closeUniModal()" class="px-4 py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-bold">Close</button>
        <button type="button" onclick="window.print()" class="px-4 py-2.5 rounded-xl bg-zinc-100 hover:bg-white text-zinc-900 text-xs font-extrabold">Print</button>
        <button type="button" id="uniDownloadBtn" class="px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-extrabold">Download PDF</button>
      </div>
    </div>`;
  document.body.appendChild(div);
}

function closeUniModal() {
  const m = document.getElementById("universalDocModal");
  if (m) { m.classList.add("hidden"); m.classList.remove("flex"); m.style.setProperty("display", "none", "important"); }
}

function showUniModal(filename, orientation) {
  const m = document.getElementById("universalDocModal");
  m.classList.remove("hidden");
  m.classList.add("flex");
  m.style.setProperty("display", "flex", "important");
  document.getElementById("uniDownloadBtn").onclick = () => {
    html2pdf().set({
      margin: 0.25, filename,
      image: { type: "jpeg", quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true },
      jsPDF: { unit: "in", format: "a4", orientation }
    }).from(document.getElementById("uniPrintArea")).save();
  };
}

function openStudentVoucher(studentId) {
  injectUniversalModal();
  const db = getDB();
  const s = db.students.find(st => st.id === studentId);
  if (!s) return alert("❌ Student not found!");

  const rent = Number(s.rent || 0), mess = Number(s.mess || 0), elec = Number(s.elec || 0);
  const other = Number(s.otherCharges || 0), disc = Number(s.discount || 0);
  const secDue = s.securityPaid ? 0 : Number(s.security || 0);
  const total = rent + mess + elec + other + secDue - disc;
  const challanNo = "VIP-" + new Date().getFullYear() + "-" + s.id.replace("ST-", "");
  const billingMonth = db.settings.currentMonth || new Date().toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  const issueDate = new Date().toLocaleDateString("en-GB");
  const isPaid = s.feeStatus === "Paid";
  const payOption1 = db.settings.jazzcash || "Not Configured in Settings";
  const payOption2 = db.settings.bankAccount || "";
  const qrData = encodeURIComponent(`VOUCHER:${challanNo}|HOSTEL:${db.settings.hostelName}|ID:${s.id}|NAME:${s.name}|ROOM:${s.room}|AMT:${total}|STATUS:${s.feeStatus}`);
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=110x110&data=${qrData}`;

  const buildCopy = (copyTitle, accentBg) => `
    <div style="border:2px solid #18181b;border-radius:14px;overflow:hidden;background:#fff;display:flex;flex-direction:column;justify-content:space-between;">
      <div>
        <div style="background:#18181b;color:#fff;padding:14px 16px;display:flex;justify-content:space-between;align-items:center;">
          <div>
            <span style="font-size:9px;text-transform:uppercase;letter-spacing:1.5px;color:#34d399;font-weight:800;display:block;">OFFICIAL HOSTEL FEE CHALLAN</span>
            <h4 style="font-size:15px;font-weight:800;margin:2px 0 0 0;text-transform:uppercase;">${esc(db.settings.hostelName)}</h4>
          </div>
          <span style="background:${accentBg};color:#fff;font-size:9px;font-weight:800;padding:4px 9px;border-radius:6px;text-transform:uppercase;">${copyTitle}</span>
        </div>
        <div style="padding:14px 16px;">
          <div style="display:flex;justify-content:space-between;align-items:center;background:#f4f4f5;border:1px solid #e4e4e7;border-radius:10px;padding:8px 12px;margin-bottom:10px;font-size:11px;">
            <div><span style="color:#71717a;font-size:9px;text-transform:uppercase;font-weight:700;display:block;">Challan No.</span><strong style="font-family:monospace;font-size:12px;">${challanNo}</strong></div>
            <div><span style="color:#71717a;font-size:9px;text-transform:uppercase;font-weight:700;display:block;">Billing Month</span><strong style="color:#047857;">${esc(billingMonth)}</strong></div>
            <div><span style="color:#71717a;font-size:9px;text-transform:uppercase;font-weight:700;display:block;">Due Date</span><strong style="color:#e11d48;">05 ${esc(billingMonth)}</strong></div>
            <div style="text-align:right;"><span style="padding:3px 8px;border-radius:6px;font-size:10px;font-weight:800;background:${isPaid ? '#d1fae5' : '#fef3c7'};color:${isPaid ? '#065f46' : '#92400e'};">${isPaid ? '✓ PAID' : '● UNPAID'}</span></div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:11px;border:1px solid #e4e4e7;border-radius:10px;padding:10px 12px;margin-bottom:10px;">
            <div><span style="color:#71717a;">Resident:</span> <strong>${esc(s.name)}</strong></div>
            <div><span style="color:#71717a;">Roll ID:</span> <strong style="color:#047857;font-family:monospace;">${esc(s.id)}</strong></div>
            <div><span style="color:#71717a;">Room No:</span> <strong>Room ${esc(s.room)}</strong></div>
            <div><span style="color:#71717a;">CNIC:</span> <strong>${esc(s.cnic || s.phone || "—")}</strong></div>
          </div>
          <table style="width:100%;border-collapse:collapse;font-size:11px;margin-bottom:10px;">
            <thead><tr style="background:#f4f4f5;border-top:1px solid #d4d4d8;border-bottom:1px solid #d4d4d8;font-size:9.5px;color:#52525b;text-transform:uppercase;">
              <th style="padding:6px 8px;text-align:left;">Description of Charges</th><th style="padding:6px 8px;text-align:right;">Amount (PKR)</th></tr></thead>
            <tbody>
              <tr style="border-bottom:1px solid #f4f4f5;"><td style="padding:5px 8px;">01. Monthly Room / Seat Rent</td><td style="padding:5px 8px;text-align:right;font-weight:700;">Rs. ${rent.toLocaleString()}</td></tr>
              <tr style="border-bottom:1px solid #f4f4f5;"><td style="padding:5px 8px;">02. Mess & Dining Charges</td><td style="padding:5px 8px;text-align:right;font-weight:700;">Rs. ${mess.toLocaleString()}</td></tr>
              <tr style="border-bottom:1px solid #f4f4f5;"><td style="padding:5px 8px;">03. Electricity Sub-Meter Share</td><td style="padding:5px 8px;text-align:right;font-weight:700;">Rs. ${elec.toLocaleString()}</td></tr>
              <tr style="border-bottom:1px solid #f4f4f5;"><td style="padding:5px 8px;">04. Refundable Security Deposit ${s.securityPaid ? '(Already Paid)' : '(1st Month)'}</td><td style="padding:5px 8px;text-align:right;font-weight:700;">Rs. ${secDue.toLocaleString()}</td></tr>
              <tr style="border-bottom:1px solid #f4f4f5;color:#e11d48;"><td style="padding:5px 8px;">05. Late Fine / Previous Arrears</td><td style="padding:5px 8px;text-align:right;font-weight:700;">Rs. ${other.toLocaleString()}</td></tr>
              <tr style="border-bottom:1px solid #e4e4e7;color:#047857;"><td style="padding:5px 8px;">06. Mess-Off Rebate / Scholarship</td><td style="padding:5px 8px;text-align:right;font-weight:700;">- Rs. ${disc.toLocaleString()}</td></tr>
            </tbody>
          </table>
          <div style="background:#18181b;color:#fff;padding:10px 14px;border-radius:10px;display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
            <div><span style="font-size:9px;color:#a1a1aa;text-transform:uppercase;font-weight:700;display:block;">Total Net Payable</span>
              <span style="font-size:10px;color:#fbbf24;">* Rs. 200 Fine after 5th</span></div>
            <strong style="font-size:16px;font-weight:800;color:#34d399;">Rs. ${total.toLocaleString()}</strong>
          </div>
          <div style="background:#ecfdf5;border:1.5px solid #6ee7b7;border-radius:10px;padding:10px 12px;display:flex;justify-content:space-between;align-items:center;gap:10px;">
            <div style="font-size:10.5px;line-height:1.45;flex:1;">
              <span style="font-size:9.5px;font-weight:800;text-transform:uppercase;color:#065f46;display:block;margin-bottom:3px;">💳 PAYABLE THROUGH:</span>
              <div style="font-weight:700;"><span style="color:#047857;">● Option 1:</span> ${esc(payOption1)}</div>
              ${payOption2 ? `<div style="font-weight:700;margin-top:2px;"><span style="color:#047857;">● Option 2:</span> ${esc(payOption2)}</div>` : ""}
              ${s.paymentTid ? `<div style="margin-top:4px;color:#1d4ed8;font-family:monospace;font-weight:700;">Submitted TID: ${esc(s.paymentTid)}</div>` : ""}
            </div>
            <img src="${qrUrl}" alt="QR" style="width:56px;height:56px;border:1px solid #a7f3d0;border-radius:8px;padding:2px;background:#fff;" crossorigin="anonymous" />
          </div>
        </div>
      </div>
      <div style="padding:10px 16px 12px;border-top:1px dashed #d4d4d8;display:flex;justify-content:space-between;font-size:10px;color:#71717a;background:#fafafa;">
        <span>Issued: ${issueDate}</span><span>Depositor Sign: _____________</span><span>Cashier / Stamp: _____________</span>
      </div>
    </div>`;

  document.getElementById("uniModalTitle").innerText = `Fee Challan (${billingMonth})`;
  document.getElementById("uniPrintArea").innerHTML = `<div class="grid grid-cols-1 lg:grid-cols-2 gap-5">${buildCopy("HOSTEL OFFICE COPY", "#059669")}${buildCopy("RESIDENT STUDENT COPY", "#2563eb")}</div>`;
  showUniModal(`Fee_Voucher_${s.id}.pdf`, "landscape");
}

function openStudentQRCard(studentId) {
  injectUniversalModal();
  const db = getDB();
  const s = db.students.find(st => st.id === studentId);
  if (!s) return;
  const qrData = encodeURIComponent(`HOSTEL:${db.settings.hostelName}|ID:${s.id}|NAME:${s.name}|ROOM:${s.room}|CNIC:${s.cnic}`);
  const avatar = s.photo
    ? `<img src="${s.photo}" class="w-20 h-20 rounded-full object-cover mx-auto border-2 border-emerald-600" />`
    : `<div class="w-20 h-20 rounded-full bg-emerald-100 text-emerald-900 font-extrabold text-2xl flex items-center justify-center mx-auto border-2 border-emerald-600">${esc((s.name || "ST").substring(0, 2).toUpperCase())}</div>`;

  document.getElementById("uniModalTitle").innerText = "Digital Student QR Gate Pass ID Card";
  document.getElementById("uniPrintArea").innerHTML = `
    <div class="max-w-sm mx-auto border-2 border-zinc-900 rounded-2xl overflow-hidden bg-white text-zinc-900">
      <div class="bg-zinc-900 text-white p-4 text-center">
        <h3 class="font-extrabold text-base uppercase">${esc(db.settings.hostelName)}</h3>
        <span class="text-[10px] uppercase bg-emerald-600 px-2.5 py-0.5 rounded-full font-bold">Official Resident Gate Pass ID</span>
      </div>
      <div class="p-5 text-center space-y-3">
        ${avatar}
        <div><h4 class="text-lg font-extrabold">${esc(s.name)}</h4><p class="text-xs font-bold text-emerald-700">Roll ID: ${esc(s.id)} | Room: ${esc(s.room)}</p></div>
        <div class="bg-zinc-100 p-3 rounded-xl text-left text-xs space-y-1">
          <div><strong>CNIC:</strong> ${esc(s.cnic)}</div>
          <div><strong>Phone:</strong> ${esc(s.phone)}</div>
          <div><strong>Guardian:</strong> ${esc(s.guardian || "N/A")}</div>
          <div><strong>Institute:</strong> ${esc(s.uni || "—")}</div>
        </div>
        <img src="https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${qrData}" alt="QR" class="w-32 h-32 mx-auto border p-1 rounded-lg" crossorigin="anonymous" />
      </div>
    </div>`;
  showUniModal(`ID_Card_${s.id}.pdf`, "portrait");
}

function openClearanceCertificate(studentId) {
  injectUniversalModal();
  const db = getDB();
  const s = db.students.find(st => st.id === studentId);
  if (!s) return;
  const unpaid = s.feeStatus === "Paid" ? 0 : (Number(s.rent || 0) + Number(s.mess || 0) + Number(s.elec || 0) + Number(s.otherCharges || 0) - Number(s.discount || 0));
  const securityHeld = Number(s.security || 0);
  const netRefund = Math.max(0, securityHeld - unpaid);

  document.getElementById("uniModalTitle").innerText = "No-Dues Clearance & Security Refund";
  document.getElementById("uniPrintArea").innerHTML = `
    <div class="border-2 border-zinc-900 p-6 rounded-xl space-y-4 text-xs max-w-2xl mx-auto">
      <div class="text-center border-b-2 border-zinc-300 pb-3">
        <h2 class="text-xl font-extrabold uppercase">${esc(db.settings.hostelName)}</h2>
        <p class="text-xs font-bold text-emerald-700 uppercase mt-1">Leaving Clearance & Security Refund Certificate</p>
      </div>
      <p class="text-sm leading-relaxed">This is to certify that <strong>${esc(s.name)}</strong> (Roll ID: <strong>${esc(s.id)}</strong>, CNIC: <strong>${esc(s.cnic)}</strong>), occupant of Room <strong>${esc(s.room)}</strong>, is checking out of the hostel.</p>
      <table class="w-full text-left border border-zinc-300"><tbody class="divide-y divide-zinc-200">
        <tr><td class="p-2 font-semibold">Refundable Security Deposit Held</td><td class="p-2 text-right font-bold text-emerald-700">Rs. ${securityHeld.toLocaleString()}</td></tr>
        <tr><td class="p-2 font-semibold">Pending Dues Deducted</td><td class="p-2 text-right font-bold text-rose-600">- Rs. ${unpaid.toLocaleString()}</td></tr>
        <tr class="bg-zinc-900 text-white text-sm"><td class="p-2.5 font-bold">NET SECURITY REFUNDABLE</td><td class="p-2.5 text-right font-bold">Rs. ${netRefund.toLocaleString()}</td></tr>
      </tbody></table>
    </div>`;
  showUniModal(`Clearance_${s.id}.pdf`, "portrait");
}

function openMonthlyAuditPDF() {
  injectUniversalModal();
  const db = getDB();
  const m = getLiveMetrics();
  const billingMonth = db.settings.currentMonth || new Date().toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  const expRows = db.expenses.map((e, i) => `<tr><td class="p-1.5 border">${i + 1}</td><td class="p-1.5 border font-semibold">${esc(e.title || "Expense")}</td><td class="p-1.5 border">${esc(e.date || "-")}</td><td class="p-1.5 border text-right font-bold text-rose-600">Rs. ${Number(e.amount || 0).toLocaleString()}</td></tr>`).join("")
    || `<tr><td colspan="4" class="p-2 text-center text-zinc-400">No expenses recorded</td></tr>`;

  document.getElementById("uniModalTitle").innerText = `Monthly Financial Audit (${billingMonth})`;
  document.getElementById("uniPrintArea").innerHTML = `
    <div class="border-2 border-zinc-900 p-6 rounded-xl space-y-4 text-xs max-w-3xl mx-auto">
      <div class="flex justify-between items-start border-b-2 border-zinc-900 pb-3">
        <div><h2 class="text-xl font-extrabold uppercase">${esc(db.settings.hostelName)}</h2><p class="text-xs font-bold text-emerald-700 uppercase">Monthly P&amp;L Financial Audit</p></div>
        <span class="bg-zinc-900 text-white px-3 py-1 rounded font-bold">${esc(billingMonth)}</span>
      </div>
      <div class="grid grid-cols-4 gap-3 text-center bg-zinc-100 p-3 rounded-xl border border-zinc-300">
        <div><span class="text-[10px] text-zinc-500 block">Occupancy</span><strong>${m.occupiedBeds} / ${m.totalCapacity}</strong></div>
        <div><span class="text-[10px] text-zinc-500 block">Collected</span><strong class="text-emerald-700">Rs. ${m.collectedFee.toLocaleString()}</strong></div>
        <div><span class="text-[10px] text-zinc-500 block">Expenses</span><strong class="text-rose-600">Rs. ${m.totalExpenses.toLocaleString()}</strong></div>
        <div><span class="text-[10px] text-zinc-500 block">Net Profit</span><strong class="text-emerald-700">Rs. ${m.netProfit.toLocaleString()}</strong></div>
      </div>
      <table class="w-full text-left border-collapse border border-zinc-300 text-[11px]">
        <thead class="bg-zinc-200"><tr><th class="p-1.5 border">#</th><th class="p-1.5 border">Expense Head</th><th class="p-1.5 border">Date</th><th class="p-1.5 border text-right">Amount</th></tr></thead>
        <tbody>${expRows}</tbody>
      </table>
    </div>`;
  showUniModal(`Audit_${billingMonth.replace(/\s+/g, "_")}.pdf`, "portrait");
}

window.openKYCDocumentsModal = function (recordId) {
  injectUniversalModal();
  const db = getDB();
  const rec = db.applications.find(a => a.id === String(recordId)) || db.students.find(s => String(s.id) === String(recordId));
  if (!rec) return alert("❌ Record not found!");

  const img = (src, label) => src
    ? `<img src="${src}" class="w-full h-56 object-contain rounded-lg bg-white mx-auto" />`
    : `<div class="h-56 flex items-center justify-center text-zinc-400">No ${label}</div>`;

  document.getElementById("uniModalTitle").innerText = `Identity & KYC — ${rec.name} (${rec.id})`;
  document.getElementById("uniPrintArea").innerHTML = `
    <div class="space-y-5 text-xs max-w-3xl mx-auto p-2">
      <div class="flex flex-wrap items-center justify-between gap-4 border-b border-zinc-200 pb-4">
        <div class="flex items-center gap-4">
          ${rec.photo ? `<img src="${rec.photo}" class="w-20 h-20 rounded-2xl object-cover border-2 border-zinc-900" />` : `<div class="w-20 h-20 rounded-2xl bg-zinc-200 flex items-center justify-center font-bold text-zinc-500">No Photo</div>`}
          <div><h3 class="text-lg font-extrabold">${esc(rec.name)}</h3>
            <p class="text-zinc-600 font-mono">ID: ${esc(rec.id)} • CNIC: ${esc(rec.cnic || "—")} • Phone: ${esc(rec.phone || "—")}</p></div>
        </div>
        <span class="bg-zinc-900 text-white px-3.5 py-1.5 rounded-xl font-bold">Room ${esc(rec.room || "—")}</span>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div class="border border-zinc-300 rounded-xl p-3 bg-zinc-50 text-center"><span class="text-[11px] font-extrabold uppercase block mb-2">CNIC Front</span>${img(rec.cnicFront, "CNIC Front")}</div>
        <div class="border border-zinc-300 rounded-xl p-3 bg-zinc-50 text-center"><span class="text-[11px] font-extrabold uppercase block mb-2">CNIC Back</span>${img(rec.cnicBack, "CNIC Back")}</div>
      </div>
    </div>`;
  showUniModal(`KYC_${rec.id}.pdf`, "portrait");
};

window.openPaymentReceiptModal = function (studentId) {
  injectUniversalModal();
  const s = getDB().students.find(st => st.id === studentId);
  if (!s || !s.paymentImg) return alert("⚠️ No receipt screenshot attached by student!");
  document.getElementById("uniModalTitle").innerText = `Payment Receipt — ${s.name} (${s.id})`;
  document.getElementById("uniPrintArea").innerHTML = `
    <div class="max-w-md mx-auto text-center space-y-4 p-2 text-xs">
      <div class="bg-zinc-100 border border-zinc-300 rounded-xl p-3 flex justify-between"><span>Student: <strong>${esc(s.name)}</strong></span><span>TID: <strong class="font-mono">${esc(s.paymentTid || "—")}</strong></span></div>
      <img src="${s.paymentImg}" class="w-full max-h-[480px] object-contain rounded-xl border-2 border-zinc-900 mx-auto" />
    </div>`;
  showUniModal(`Receipt_${s.id}.pdf`, "portrait");
};

window.openHostelRulesModal = function () {
  let modal = document.getElementById("hostelRulesImgModal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "hostelRulesImgModal";
    modal.className = "fixed inset-0 bg-zinc-950/85 hidden items-center justify-center z-[85] p-3 sm:p-5";
    modal.innerHTML = `
      <div class="bg-white rounded-2xl max-w-lg w-full max-h-[90dvh] flex flex-col shadow-2xl overflow-hidden text-zinc-900">
        <div class="px-5 py-3.5 flex items-center justify-between bg-zinc-900 text-white shrink-0">
          <h3 class="text-sm font-extrabold">Official Hostel Rules & Terms</h3>
          <button type="button" onclick="closeHostelRulesModal()" class="text-zinc-400 hover:text-white text-2xl leading-none px-1">&times;</button>
        </div>
        <div class="flex-1 overflow-y-auto p-3 bg-zinc-100 text-center">
          <img src="rules.jpg" alt="Hostel Rules" class="w-full h-auto rounded-xl border border-zinc-300" />
        </div>
        <div class="p-3.5 border-t bg-white flex justify-end gap-2 text-xs">
          <button type="button" onclick="closeHostelRulesModal()" class="px-4 py-2.5 rounded-xl border border-zinc-300 font-bold">Close</button>
          <button type="button" onclick="acceptHostelRules()" class="px-5 py-2.5 rounded-xl bg-emerald-700 hover:bg-emerald-600 text-white font-extrabold">I Have Read & Agree</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
  }
  modal.classList.remove("hidden");
  modal.classList.add("flex");
  modal.style.setProperty("display", "flex", "important");
};

window.closeHostelRulesModal = function () {
  const m = document.getElementById("hostelRulesImgModal");
  if (m) { m.classList.add("hidden"); m.classList.remove("flex"); m.style.setProperty("display", "none", "important"); }
};

window.acceptHostelRules = function () {
  const chk = document.getElementById("agreeRulesCheckbox");
  if (chk) chk.checked = true;
  closeHostelRulesModal();
};

// ============================================================================
// 9. BILLING, ROOM SHIFT, MESS REBATE, WHATSAPP, BACKUP
// ============================================================================
function checkAndApplyAutoLateFine() {
  const today = new Date();
  if (today.getDate() <= 5) return;
  const monthKey = today.getFullYear() + "-" + (today.getMonth() + 1);
  const db = getDB();
  let updated = false;
  db.students.forEach(s => {
    if (s.status === "Active" && s.feeStatus !== "Paid" && s.lastFineMonth !== monthKey) {
      s.otherCharges = Number(s.otherCharges || 0) + 200;
      s.lastFineMonth = monthKey;
      updated = true;
    }
  });
  if (updated) saveDB(db, "Auto-applied Rs. 200 Late Fine to unpaid students", "System");
}

function startNewBillingMonth() {
  const monthName = prompt("Enter New Billing Month Name (e.g. November 2026):", "November 2026");
  if (!monthName) return;
  const db = getDB();
  db.settings.currentMonth = monthName;
  db.students.forEach(s => {
    if (s.status !== "Active") return;
    if (s.feeStatus === "Paid") {
      s.securityPaid = true; s.otherCharges = 0; s.elec = 0;
    } else {
      const secDue = s.securityPaid ? 0 : Number(s.security || 0);
      const prevUnpaid = Number(s.rent || 0) + Number(s.mess || 0) + Number(s.elec || 0) + secDue;
      s.otherCharges = Number(s.otherCharges || 0) + prevUnpaid;
      s.securityPaid = true;
    }
    s.feeStatus = "Unpaid";
    s.paymentTid = "";
    s.paymentImg = "";
    s.lastFineMonth = "";
  });
  saveDB(db, `Started new billing cycle for ${monthName}`, "Admin");
  alert(`✅ New Month (${monthName}) Vouchers Generated!`);
}

function waNumber(raw) {
  const d = digitsOnly(raw);
  return d.startsWith("92") ? d : "92" + d.replace(/^0/, "");
}

function studentTotal(s) {
  const secDue = s.securityPaid ? 0 : Number(s.security || 0);
  return Number(s.rent || 0) + Number(s.mess || 0) + Number(s.elec || 0) + Number(s.otherCharges || 0) + secDue - Number(s.discount || 0);
}

function sendStudentFeeReminder(studentId) {
  const db = getDB();
  const s = db.students.find(st => st.id === studentId);
  if (!s) return;
  const month = db.settings.currentMonth || new Date().toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  const msg = `*FEE REMINDER — ${db.settings.hostelName}*\n\nSalam *${s.name}* (${s.id}, Room ${s.room}),\nYour hostel fee for *${month}* is *${String(s.feeStatus).toUpperCase()}*.\n\n💰 *Payable:* Rs. ${studentTotal(s).toLocaleString()}\n💳 *Account:* ${db.settings.jazzcash}`;
  window.open(`https://wa.me/${waNumber(s.phone)}?text=${encodeURIComponent(msg)}`, "_blank");
}

function sendGuardianAlert(studentId) {
  const db = getDB();
  const s = db.students.find(st => st.id === studentId);
  if (!s) return;
  const target = s.guardian || s.phone;
  if (!target) return alert("⚠️ No Guardian phone number saved!");
  const msg = `*GUARDIAN ALERT — ${db.settings.hostelName}*\n\nRespected Guardian of *${s.name}* (Room ${s.room}),\nStatus: *${String(s.feeStatus).toUpperCase()}* (Rs. ${studentTotal(s).toLocaleString()}).`;
  window.open(`https://wa.me/${waNumber(target)}?text=${encodeURIComponent(msg)}`, "_blank");
}

function shiftStudentRoom(studentId) {
  const db = getDB();
  const s = db.students.find(st => st.id === studentId);
  if (!s) return;
  const newRoomNo = prompt(`🔄 SHIFT ROOM FOR: ${s.name} (Current: ${s.room})\nEnter New Room Number:`, s.room);
  if (!newRoomNo || String(newRoomNo).trim() === String(s.room)) return;
  const target = db.rooms.find(r => r.no === String(newRoomNo).trim());
  if (!target) return alert(`❌ Room "${newRoomNo}" does not exist!`);
  s.room = target.no;
  saveDB(db, `Shifted ${s.name} to Room ${target.no}`, "Admin");
  alert(`✅ ${s.name} shifted to Room ${target.no}!`);
}

function applyMessRebate(studentId) {
  const db = getDB();
  const s = db.students.find(st => st.id === studentId);
  if (!s) return;
  const days = Number(prompt(`🍲 Enter number of Mess-Off days for ${s.name}:`, "5"));
  if (!days || days <= 0) return;
  const rate = Number(prompt("Enter Per-Day Mess Rate (Rs.):", "250"));
  if (!rate || rate <= 0) return;
  const amount = days * rate;
  s.discount = Number(s.discount || 0) + amount;
  saveDB(db, `Applied Rs. ${amount} Mess Rebate to ${s.name}`, "Admin");
  alert(`✅ Rs. ${amount.toLocaleString()} Mess Rebate added!`);
}

function wipeAllData() {
  if (!confirm("Are you sure? This will wipe all rooms, students, applications and records!")) return;
  const cur = getDB();
  const fresh = freshDB();
  fresh.settings = { ...fresh.settings, ...cur.settings, isSuspended: cur.settings.isSuspended || false };
  delete fresh.settings.liveNotice;
  saveDB(fresh, "Factory reset of hostel data", "Admin");
  const col = appsRef();
  if (col) col.get().then(snap => snap.docs.forEach(d => d.ref.delete())).catch(() => {});
  setTimeout(() => location.reload(), 600);
}

function exportHostelBackupJSON() {
  const data = JSON.stringify(getDB(), null, 2);
  const a = document.createElement("a");
  a.href = "data:text/json;charset=utf-8," + encodeURIComponent(data);
  a.download = `Backup_${TENANT_ID}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function importHostelBackupJSON(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const imported = JSON.parse(e.target.result);
      if (confirm(`Restore backup for "${imported.settings?.hostelName}"?`)) {
        cacheWrite({ ...imported, applications: getDB().applications });
        saveDB(getDB(), "Restored database from JSON backup", "Admin");
        location.reload();
      }
    } catch (err) { alert("❌ Invalid JSON file!"); }
  };
  reader.readAsText(file);
}

// ============================================================================
// 10. PWA INSTALL BUTTONS
// ============================================================================
window.pwaPromptEvent = null;

window.addEventListener("beforeinstallprompt", e => {
  e.preventDefault();
  window.pwaPromptEvent = e;
});

window.installHostelPWA = async function () {
  if (window.pwaPromptEvent) {
    window.pwaPromptEvent.prompt();
    const res = await window.pwaPromptEvent.userChoice;
    if (res && res.outcome === "accepted") window.pwaPromptEvent = null;
  } else {
    alert("📲 Install karne ka tareeqa:\n\n1. Browser ke menu (⋮ ya Share ⬆️) par tap karein.\n2. 'Install App' ya 'Add to Home Screen' par tap karein.");
  }
};

function hidePWAButtonsIfInstalled() {
  const standalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  if (standalone) document.querySelectorAll(".pwa-install-trigger").forEach(el => el.style.setProperty("display", "none", "important"));
}

// ============================================================================
// 11. CUSTOM POPUP (replaces window.alert) & ANIMATIONS
// ============================================================================
(function initCustomSaaSUI() {
  if (document.getElementById("saasGlobalAnimations")) return;
  const style = document.createElement("style");
  style.id = "saasGlobalAnimations";
  style.innerHTML = `
    @keyframes saasModalSpring { 0% { opacity: 0; transform: scale(0.90) translateY(14px); } 100% { opacity: 1; transform: scale(1) translateY(0); } }
    #customSaaSAlertModal:not(.hidden) > div { animation: saasModalSpring 0.32s cubic-bezier(0.22, 1, 0.36, 1) forwards; }`;
  document.head.appendChild(style);

  window.showSaaSPopup = function (rawMsg) {
    let modal = document.getElementById("customSaaSAlertModal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "customSaaSAlertModal";
      modal.className = "fixed inset-0 bg-zinc-950/75 hidden items-center justify-center z-[9999] p-4";
      document.body.appendChild(modal);
    }
    const msg = String(rawMsg || "").trim();
    const isError = msg.includes("❌") || msg.includes("🚫") || /invalid|incorrect|denied|error|failed|blocked|already/i.test(msg);
    const isWarn = msg.includes("⚠️") || /warning|wait|please/i.test(msg);
    const lines = msg.replace(/^[✅❌⚠️🎉🗑️📲🚫ℹ️]+\s*/, "").split("\n").filter(l => l.trim() !== "");
    const headline = lines[0] || "Notice";
    const body = lines.slice(1);
    const badge = isError ? "bg-rose-600 text-white" : isWarn ? "bg-amber-500 text-zinc-950" : "bg-emerald-600 text-white";
    const icon = isError ? "fa-shield-xmark" : isWarn ? "fa-triangle-exclamation" : "fa-circle-check";

    modal.innerHTML = `
      <div class="bg-white border border-zinc-200 rounded-2xl max-w-sm w-full p-6 shadow-2xl space-y-4 text-zinc-900">
        <div class="flex items-start gap-3.5 border-b border-zinc-100 pb-4">
          <div class="w-11 h-11 rounded-xl ${badge} flex items-center justify-center text-lg shrink-0"><i class="fa-solid ${icon}"></i></div>
          <h3 class="text-sm sm:text-base font-extrabold flex-1 break-words">${esc(headline)}</h3>
          <button type="button" onclick="closeSaaSPopup()" class="text-zinc-400 hover:text-zinc-800 text-xl leading-none">&times;</button>
        </div>
        ${body.length ? `<div class="bg-zinc-50 border border-zinc-200 rounded-xl p-3.5 space-y-1 text-xs text-zinc-700 font-medium">${body.map(l => `<div>${esc(l)}</div>`).join("")}</div>` : ""}
        <button type="button" onclick="closeSaaSPopup()" class="w-full ${isError ? "bg-rose-600 hover:bg-rose-500" : "bg-zinc-900 hover:bg-zinc-800"} text-white py-3 rounded-xl text-xs font-extrabold uppercase tracking-wider">Continue →</button>
      </div>`;
    modal.classList.remove("hidden");
    modal.classList.add("flex");
    modal.style.setProperty("display", "flex", "important");
  };

  window.closeSaaSPopup = function () {
    const m = document.getElementById("customSaaSAlertModal");
    if (m) { m.classList.add("hidden"); m.classList.remove("flex"); m.style.setProperty("display", "none", "important"); }
  };

  window.alert = function (message) { window.showSaaSPopup(message); };
})();

// ============================================================================
// 12. BOOT
// ============================================================================
initCloud();

window.addEventListener("DOMContentLoaded", () => {
  // Keep tenant id in every internal link
  document.querySelectorAll("a[href]").forEach(link => {
    const href = link.getAttribute("href");
    if (href && !/^(http|#|tel:|mailto:)/.test(href) && !href.includes("?hostel=")) {
      link.setAttribute("href", `${href}?hostel=${TENANT_ID}`);
    }
  });
  upgradePortalLoginGates();
  applyBrandLogoEverywhere();
  hidePWAButtonsIfInstalled();
  refreshCurrentPortalUI();
});
