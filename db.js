// ============================================================================
// db.js: shared data layer (Admin, Warden, Student, Public site)
// Cloud data sirf verified staff likhta hai. localStorage sirf render cache hai.
// ============================================================================

const firebaseConfig = {
  apiKey: "AIzaSyCRXCp75adfyFUbyZHlgRGQtu2vqb-TPMM",
  authDomain: "hostel-cloud-pk.firebaseapp.com",
  projectId: "hostel-cloud-pk",
  storageBucket: "hostel-cloud-pk.firebasestorage.app",
  messagingSenderId: "394742737685",
  appId: "1:394742737685:web:a8faef1ab5bf69d84e971c"
};

const LIBS = {
  html2pdf: "https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js",
  qrcode: "https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"
};
const PUBLIC_SETTINGS = ["hostelName", "jazzcash", "bankAccount", "adminWhatsApp", "currentMonth", "logo"];
const PRIVATE_LISTS = ["students", "complaints", "leaves", "visitors", "expenses", "inventory", "staff", "logs"];
const SECRET_SETTINGS = ["adminPass", "wardenPass", "adminEmail", "wardenEmail", "isSuspended", "saasFee"];

const urlParams = new URLSearchParams(location.search);
const TENANT_ID = (urlParams.get("hostel") || localStorage.getItem("SAAS_TENANT_ID") || "main_hostel")
  .toLowerCase().replace(/[^a-z0-9_-]/g, "");
try { localStorage.setItem("SAAS_TENANT_ID", TENANT_ID); } catch (e) {}

// Student page ka cache alag rakhte hain, taake admin ka cache overwrite na ho
const IS_STUDENT_PAGE = /\/student(\.html)?$/.test(location.pathname);
const DB_KEY = "HOSTEL_CACHE_" + TENANT_ID + (IS_STUDENT_PAGE ? "_STU" : "");
const PAGE_STARTED_AT = new Date().toISOString();

let staffInfo = null;
let staffStarted = false;
let publicStarted = false;
let legacyChecked = false;
let fineChecked = false;
let _authResolve;
const _authReady = new Promise(r => { _authResolve = r; });

// ============================================================================
// 1. UTILITIES
// ============================================================================
function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function digitsOnly(s) { return String(s || "").replace(/\D/g, ""); }
function num(v) { return Number(v) || 0; }
function money(v) { return "Rs. " + num(v).toLocaleString(); }
function nowTime() { return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
function monthLabel() { return new Date().toLocaleDateString("en-GB", { month: "long", year: "numeric" }); }
function pick(obj, keys) {
  const o = {};
  keys.forEach(k => { if (obj && obj[k] !== undefined) o[k] = obj[k]; });
  return o;
}
function clean(o) { return JSON.parse(JSON.stringify(o)); }
function sanitize(settings) {
  const o = { ...(settings || {}) };
  SECRET_SETTINGS.forEach(k => delete o[k]);
  return o;
}
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = src; s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}
function isAdminPage() { return !!document.getElementById("adminLoginGate"); }
function fs() { return firebase.firestore(); }
function tenantDoc(col) { return fs().collection(col).doc(TENANT_ID); }
function appsCol() { return fs().collection("hostel_apps").doc(TENANT_ID).collection("list"); }
function isStaffReady() { return !!staffInfo; }
function sha256Hex_unused() {}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// ============================================================================
// 2. LOCAL CACHE & MODEL
// ============================================================================
function emptyDB() {
  return {
    settings: { hostelName: "Hostel ERP Console", jazzcash: "", bankAccount: "", adminWhatsApp: "", currentMonth: "", logo: "" },
    rooms: [], messMenu: [], occupancy: {}, students: [], applications: [],
    complaints: [], leaves: [], visitors: [], expenses: [], inventory: [], staff: [], logs: []
  };
}

function normalizeRoom(r) {
  const no = String(r.no ?? r.id ?? "").trim();
  return {
    ...r, no, id: no,
    type: r.type || "Standard Shared",
    capacity: num(r.capacity), rent: num(r.rent), mess: num(r.mess), security: num(r.security),
    facilities: r.facilities || ""
  };
}

function normalizeApp(a) {
  const id = String(a.id || "");
  return { ...a, id, room: String(a.room || ""), status: a.status || "Pending" };
}

function getDB() {
  let db = null;
  try { db = JSON.parse(localStorage.getItem(DB_KEY) || "null"); } catch (e) {}
  const base = emptyDB();
  if (!db || typeof db !== "object") db = base;
  db.settings = { ...base.settings, ...(db.settings || {}) };
  Object.keys(base).forEach(k => {
    if (k === "settings") return;
    if (k === "occupancy") { if (!db.occupancy || typeof db.occupancy !== "object") db.occupancy = {}; }
    else if (!Array.isArray(db[k])) db[k] = [];
  });
  db.rooms = db.rooms.map(normalizeRoom);
  db.applications = db.applications.map(normalizeApp);
  return db;
}

function cacheWrite(db) {
  try { localStorage.setItem(DB_KEY, JSON.stringify(db)); } catch (e) { console.warn("Local cache full:", e); }
}

function computeOccupancy(db) {
  const occ = {};
  db.students.forEach(s => {
    if (s.status !== "Active") return;
    const k = String(s.room);
    occ[k] = (occ[k] || 0) + 1;
  });
  return occ;
}

function studentTotal(s) {
  const secDue = s.securityPaid ? 0 : num(s.security);
  return num(s.rent) + num(s.mess) + num(s.elec) + num(s.otherCharges) + secDue - num(s.discount);
}

function addLog(db, action, actor = "Admin") {
  db.logs = [{ time: nowTime(), actor, action }, ...(db.logs || [])].slice(0, 60);
}

function viewId(studentId) {
  return `${TENANT_ID}_${String(studentId).toLowerCase()}`;
}

// Student ke liye safe view: password, receipt aur KYC images shamil nahi
function studentView(db, s, docId) {
  const { pass, paymentImg, cnicFront, cnicBack, ...safe } = s;
  return {
    tenant: TENANT_ID,
    docId,
    status: s.status,
    student: { ...safe, hasReceipt: !!paymentImg },
    complaints: db.complaints.filter(c => c.studentId === s.id),
    leaves: db.leaves.filter(l => l.studentId === s.id),
    roommates: db.students
      .filter(m => m.status === "Active" && String(m.room) === String(s.room))
      .map(m => ({ id: m.id, name: m.name, uni: m.uni || "" }))
  };
}

// ============================================================================
// 3. AUTH & CLOUD LISTENERS
// ============================================================================
function initCloud() {
  if (typeof firebase === "undefined") { console.error("Firebase SDK load nahi hua."); return; }
  if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);

  const auth = firebase.auth();
  // Har tab ka session alag rahe
  auth.setPersistence(firebase.auth.Auth.Persistence.SESSION).catch(() => {});

  auth.onAuthStateChanged(async user => {
    if (!user) {
      auth.signInAnonymously().catch(err =>
        console.error("Anonymous sign-in fail. Firebase Console > Authentication > Anonymous enable karein.", err));
      return;
    }
    _authResolve(user);
    startPublicListeners();
    if (!user.isAnonymous) await loadStaff(user.uid);
  });
}

async function loadStaff(uid) {
  try {
    const snap = await fs().collection("hostel_staff").doc(uid).get();
    if (!snap.exists) return null;
    const s = snap.data();
    if (s.role !== "founder" && s.tenant !== TENANT_ID) return null;
    staffInfo = { uid, role: s.role, tenant: s.tenant || "*" };
    if (!staffStarted) startStaffListeners();
    return staffInfo;
  } catch (err) {
    console.error("Staff check fail:", err);
    return null;
  }
}

async function staffLogin(email, password) {
  const cred = await firebase.auth().signInWithEmailAndPassword(email.trim(), password);
  const info = await loadStaff(cred.user.uid);
  if (!info) {
    await firebase.auth().signOut();
    throw new Error("NOT_STAFF");
  }
  return info;
}

function staffLogout() {
  firebase.auth().signOut().then(() => location.reload());
}

function showNotice(title, text) {
  document.body.innerHTML = `
    <div style="background:#020617;color:#fff;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:sans-serif;text-align:center;padding:24px;">
      <h1 style="color:#f43f5e;font-size:26px;font-weight:800;margin:0;">${esc(title)}</h1>
      <p style="color:#94a3b8;max-width:420px;margin-top:10px;font-size:14px;line-height:1.6;">${esc(text)}</p>
    </div>`;
}

function startPublicListeners() {
  if (publicStarted) return;
  publicStarted = true;

  tenantDoc("hostel_license").onSnapshot(snap => {
    if (!snap.exists) return showNotice("Hostel Registered Nahi", "Is hostel ka subscription record nahi mila. Founder se rabta karein.");
    const lic = snap.data();
    if (lic.isSuspended === true) {
      showNotice("Software License Suspended", `${lic.hostelName || TENANT_ID} ka subscription expire hone ki wajah se access band hai.`);
    }
  }, err => console.error("License sync error:", err));

  tenantDoc("hostel_public").onSnapshot(snap => {
    if (!snap.exists) return;
    const d = snap.data();
    const db = getDB();
    db.settings = { ...db.settings, ...(d.settings || {}) };
    db.rooms = (d.rooms || []).map(normalizeRoom);
    db.messMenu = d.messMenu || [];
    db.occupancy = d.occupancy || {};
    cacheWrite(db);
    refreshCurrentPortalUI();
  }, err => console.error("Public sync error:", err));
}

function startStaffListeners() {
  staffStarted = true;
  ["adminLoginGate", "wardenLoginGate"].forEach(id => {
    const g = document.getElementById(id);
    if (g) g.style.setProperty("display", "none", "important");
  });

  tenantDoc("hostel_private").onSnapshot(snap => {
    if (!snap.exists) return initOrMigrate();
    const d = snap.data();
    const db = getDB();
    db.settings = { ...db.settings, ...(d.settings || {}) };
    PRIVATE_LISTS.forEach(k => { if (Array.isArray(d[k])) db[k] = d[k]; });
    cacheWrite(db);
    refreshCurrentPortalUI();
    if (!fineChecked) { fineChecked = true; checkAndApplyAutoLateFine(); }
  }, err => console.error("Staff data sync error:", err));

  appsCol().onSnapshot(snap => {
    const list = snap.docs
      .map(d => normalizeApp({ ...d.data(), id: d.id }))
      .sort((a, b) => String(b.submittedAt || "").localeCompare(String(a.submittedAt || "")));
    const db = getDB();
    db.applications = list;
    cacheWrite(db);
    refreshCurrentPortalUI();

    if (isAdminPage()) {
      snap.docChanges().forEach(ch => {
        const a = ch.doc.data();
        if (ch.type === "added" && a.submittedAt && a.submittedAt > PAGE_STARTED_AT) {
          saveDB(getDB(), `Naye online application: ${a.name || "applicant"} (${ch.doc.id}) Room ${a.room || "-"}`, "Public Site");
        }
      });
    }
  }, err => console.error("Applications sync error:", err));

  fs().collection("hostel_inbox").where("tenant", "==", TENANT_ID).onSnapshot(snap => {
    const items = snap.docs.map(d => ({ ...d.data(), docId: d.id }));
    if (items.length) processInbox(items);
  }, err => console.error("Inbox sync error:", err));
}

// Pehli dafa: purana hostel_system data naye structure mein move karta hai
async function initOrMigrate() {
  if (legacyChecked) return;
  legacyChecked = true;
  try {
    const oldRef = tenantDoc("hostel_system");
    const oldSnap = await oldRef.get();
    const oldData = oldSnap.exists ? oldSnap.data() : null;
    const oldSubApps = oldSnap.exists
      ? (await oldRef.collection("applications").get()).docs.map(d => ({ ...d.data(), id: d.id }))
      : [];

    const db = getDB();
    if (oldData) {
      db.settings = { ...db.settings, ...sanitize(oldData.settings) };
      ["rooms", "messMenu", ...PRIVATE_LISTS].forEach(k => { if (Array.isArray(oldData[k])) db[k] = oldData[k]; });
    }
    const legacyApps = [...(oldData && Array.isArray(oldData.applications) ? oldData.applications : []), ...oldSubApps]
      .map((a, i) => normalizeApp({ ...a, id: a.id || a.appId || `APP-MIG-${Date.now().toString(36)}-${i}` }));

    for (let i = 0; i < legacyApps.length; i += 400) {
      const batch = fs().batch();
      legacyApps.slice(i, i + 400).forEach(a => batch.set(appsCol().doc(a.id), clean(a), { merge: true }));
      await batch.commit();
    }
    db.applications = legacyApps;
    saveDB(db, oldData ? "Purana data naye secure storage mein move ho gaya" : "Hostel data initialise hua", "System");
  } catch (err) {
    console.error("Migration fail:", err);
  }
}

// ============================================================================
// 4. WRITES (staff only)
// ============================================================================
async function commitChunks(writes) {
  for (let i = 0; i < writes.length; i += 400) {
    const batch = fs().batch();
    writes.slice(i, i + 400).forEach(([ref, data]) => batch.set(ref, clean(data)));
    await batch.commit();
  }
}

async function writeAll(db) {
  if (!staffInfo) throw new Error("Staff login nahi hai.");
  const priv = { settings: sanitize(db.settings) };
  PRIVATE_LISTS.forEach(k => { priv[k] = db[k] || []; });
  priv.students = (db.students || []).map(s => { const { pass, ...rest } = s; return rest; });

  const pub = {
    settings: pick(sanitize(db.settings), PUBLIC_SETTINGS),
    rooms: db.rooms,
    messMenu: db.messMenu,
    occupancy: computeOccupancy(db)
  };

  const writes = [[tenantDoc("hostel_private"), priv], [tenantDoc("hostel_public"), pub]];
  db.students.forEach(s => {
    const docId = viewId(s.id);
    writes.push([fs().collection("hostel_student_view").doc(docId), studentView(db, s, docId)]);
  });
  await commitChunks(writes);
}

async function persist(db) {
  db.occupancy = computeOccupancy(db);
  cacheWrite(db);
  refreshCurrentPortalUI();
  await writeAll(db);
}

function saveDB(db, actionText, actor = "Admin") {
  if (actionText) addLog(db, actionText, actor);
  persist(db).catch(err => {
    console.error("Cloud save error:", err);
    alert("❌ Cloud save fail hua. Internet check karein aur dobara try karein.");
  });
}

function refreshCurrentPortalUI() {
  if (typeof renderAdminAll === "function") renderAdminAll();
  if (typeof loadPublicSite === "function") loadPublicSite();
  if (typeof renderWardenConsole === "function") renderWardenConsole();
  if (typeof renderStudentDashboard === "function") renderStudentDashboard();
}

window.addEventListener("storage", e => {
  if (!e.key || e.key === DB_KEY) refreshCurrentPortalUI();
});

// ============================================================================
// 5. APPLICATIONS
// ============================================================================
async function submitApplication(app) {
  await _authReady;
  await appsCol().doc(app.id).set(clean(app));
}

async function updateApplicationRemote(id, patch) {
  try { await appsCol().doc(id).update(patch); }
  catch (err) { console.error(err); alert("❌ Application update nahi hui. Dobara try karein."); }
}

async function deleteApplicationRemote(id) {
  try { await appsCol().doc(id).delete(); }
  catch (err) { console.error(err); alert("❌ Application delete nahi hui. Dobara try karein."); }
}

// ============================================================================
// 6. STUDENT LOGIN PROVISIONING (admin page se call hota hai)
// ============================================================================
function studentEmail(studentId) {
  return `${TENANT_ID}.${String(studentId).toLowerCase()}@students.hostelcloud.app`;
}

function loginKeys(student) {
  const keys = ["id:" + String(student.id).toLowerCase()];
  const digits = digitsOnly(student.cnic);
  if (digits.length >= 13) keys.push("cnic:" + digits);
  return keys;
}

// Student ka Firebase login banata hai. Staff ka session nahi tootta (alag app instance).
async function provisionStudentLogin(student, password) {
  if (!staffInfo) throw new Error("Pehle staff ke tor par login karein.");
  if (!student || !student.id) throw new Error("Student record ghalat hai.");
  if (!password || password.length < 6) throw new Error("Password kam se kam 6 characters ka hona chahiye.");

  const email = studentEmail(student.id);
  const app = firebase.initializeApp(firebaseConfig, "provisioner-" + Date.now());
  let uid;
  try {
    const cred = await app.auth().createUserWithEmailAndPassword(email, password);
    uid = cred.user.uid;
  } catch (err) {
    if (err.code === "auth/email-already-in-use") {
      throw new Error("Is student ka login pehle se bana hua hai. Password reset ke liye Console mein user update karein.");
    }
    throw err;
  } finally {
    await app.auth().signOut().catch(() => {});
    await app.delete().catch(() => {});
  }

  const batch = fs().batch();
  batch.set(fs().collection("hostel_students").doc(uid), {
    tenant: TENANT_ID,
    studentId: student.id,
    docId: viewId(student.id)
  });
  for (const k of loginKeys(student)) {
    const h = await sha256Hex(k);
    batch.set(fs().collection("hostel_index").doc(`${TENANT_ID}_${h}`), { tenant: TENANT_ID, email });
  }
  await batch.commit();
  return email;
}

// ============================================================================
// 7. STUDENT REQUESTS PROCESS KARNA (staff ke browser mein)
// ============================================================================
let inboxBusy = false;

async function processInbox(items) {
  if (inboxBusy) return;
  inboxBusy = true;
  try {
    const db = getDB();
    items.forEach(item => {
      const s = db.students.find(st => st.id === item.studentId);
      if (!s) return;
      if (item.type === "tid") {
        s.paymentTid = item.tid;
        if (item.receipt) s.paymentImg = item.receipt;
        addLog(db, `${s.name} (${s.id}) ne fee TID ${item.tid} submit ki`, s.name);
      } else if (item.type === "complaint" && !db.complaints.some(c => c.id === item.docId)) {
        db.complaints.unshift({
          id: item.docId, studentId: s.id, studentName: s.name, room: s.room,
          issue: item.issue, date: new Date().toLocaleDateString("en-GB"), status: "Open"
        });
        addLog(db, `Complaint lodged by ${s.name} (Room ${s.room})`, s.name);
      } else if (item.type === "leave" && !db.leaves.some(l => l.id === item.docId)) {
        db.leaves.unshift({
          id: item.docId, studentId: s.id, studentName: s.name, room: s.room,
          from: item.from, to: item.to, reason: item.reason, status: "Pending"
        });
        addLog(db, `Leave request by ${s.name} (${item.from} to ${item.to})`, s.name);
      }
    });

    // Pehle data save, phir inbox delete. Is order se data gum nahi hota.
    await persist(db);
    await Promise.all(items.map(i => fs().collection("hostel_inbox").doc(i.docId).delete()));
  } catch (err) {
    console.error("Inbox processing fail:", err);
  } finally {
    inboxBusy = false;
  }
}

// ============================================================================
// 8. METRICS
// ============================================================================
function getLiveMetrics() {
  const db = getDB();
  const totalCapacity = db.rooms.reduce((sum, r) => sum + num(r.capacity), 0);
  const active = db.students.filter(s => s.status === "Active");
  let collectedFee = 0, pendingFee = 0, paidCount = 0, unpaidCount = 0, totalSecurity = 0;

  active.forEach(s => {
    const total = studentTotal(s);
    if (s.feeStatus === "Paid") { collectedFee += total; totalSecurity += num(s.security); paidCount++; }
    else { pendingFee += total; if (s.securityPaid) totalSecurity += num(s.security); unpaidCount++; }
  });

  const totalExpenses = db.expenses.reduce((sum, e) => sum + num(e.amount), 0);
  return {
    totalCapacity, occupiedBeds: active.length, emptyBeds: Math.max(0, totalCapacity - active.length),
    collectedFee, pendingFee, paidCount, unpaidCount, totalExpenses,
    netProfit: collectedFee - totalExpenses, totalSecurity,
    pendingApps: db.applications.filter(a => a.status === "Pending").length,
    openComplaints: db.complaints.filter(c => c.status !== "Resolved").length
  };
}

// ============================================================================
// 9. IMAGE UPLOADS
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
    saveDB(db, "Hostel logo update hua", "Admin");
    applyBrandLogoEverywhere();
    alert("✅ Hostel logo update ho gaya.");
  });
};

function applyBrandLogoEverywhere() {
  const logo = getDB().settings.logo || "logo.png";
  let fav = document.querySelector("link[rel='icon']");
  if (!fav) { fav = document.createElement("link"); fav.rel = "icon"; document.head.appendChild(fav); }
  fav.href = logo;
}

// ============================================================================
// 10. PRINTABLE DOCUMENTS (voucher, ID card, clearance, audit, KYC, receipt)
// ============================================================================
function ensureDocModal() {
  if (document.getElementById("universalDocModal")) return;
  const div = document.createElement("div");
  div.id = "universalDocModal";
  div.className = "fixed inset-0 bg-zinc-950/85 items-center justify-center z-50 p-3 sm:p-6 overflow-y-auto";
  div.style.display = "none";
  div.innerHTML = `
    <div class="bg-zinc-900 border border-zinc-700 rounded-2xl max-w-5xl w-full p-4 sm:p-6 space-y-4 my-8 text-zinc-100 shadow-2xl">
      <div class="flex justify-between items-center border-b border-zinc-800 pb-3">
        <h3 id="uniModalTitle" class="text-sm sm:text-base font-extrabold text-white">Document</h3>
        <button type="button" onclick="closeUniModal()" class="text-zinc-400 hover:text-white text-2xl leading-none px-2">&times;</button>
      </div>
      <div id="uniPrintArea" class="bg-white text-zinc-900 p-4 sm:p-6 rounded-xl overflow-x-auto"></div>
      <div class="flex flex-wrap justify-end gap-2.5 pt-2">
        <button type="button" onclick="closeUniModal()" class="px-4 py-2.5 rounded-xl bg-zinc-800 text-zinc-200 text-xs font-bold">Close</button>
        <button type="button" onclick="window.print()" class="px-4 py-2.5 rounded-xl bg-zinc-100 text-zinc-900 text-xs font-extrabold">Print</button>
        <button type="button" id="uniDownloadBtn" class="px-5 py-2.5 rounded-xl bg-emerald-600 text-white text-xs font-extrabold">Download PDF</button>
      </div>
    </div>`;
  document.body.appendChild(div);
}

function closeUniModal() {
  const m = document.getElementById("universalDocModal");
  if (m) m.style.display = "none";
}

async function renderQRs(items) {
  if (!items.length) return;
  await loadScript(LIBS.qrcode);
  items.forEach(({ id, text }) => {
    const el = document.getElementById(id);
    if (el) { el.innerHTML = ""; new QRCode(el, { text, width: 110, height: 110 }); }
  });
}

function showDoc(title, html, filename, orientation, qrs = []) {
  ensureDocModal();
  document.getElementById("uniModalTitle").textContent = title;
  document.getElementById("uniPrintArea").innerHTML = html;
  document.getElementById("universalDocModal").style.display = "flex";
  document.getElementById("uniDownloadBtn").onclick = async () => {
    try {
      await loadScript(LIBS.html2pdf);
      html2pdf().set({
        margin: 0.25, filename,
        image: { type: "jpeg", quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true },
        jsPDF: { unit: "in", format: "a4", orientation }
      }).from(document.getElementById("uniPrintArea")).save();
    } catch (err) { alert("❌ PDF library load nahi hui. Internet check karein."); }
  };
  renderQRs(qrs).catch(() => {});
}

function openStudentVoucher(studentId) {
  const db = getDB();
  const s = db.students.find(st => st.id === studentId);
  if (!s) return alert("❌ Student nahi mila.");

  const rent = num(s.rent), mess = num(s.mess), elec = num(s.elec), other = num(s.otherCharges), disc = num(s.discount);
  const secDue = s.securityPaid ? 0 : num(s.security);
  const total = studentTotal(s);
  const challanNo = `VIP-${new Date().getFullYear()}-${String(s.id).replace("ST-", "")}`;
  const month = db.settings.currentMonth || monthLabel();
  const isPaid = s.feeStatus === "Paid";
  const payOpt1 = db.settings.jazzcash || "Not configured";
  const payOpt2 = db.settings.bankAccount || "";
  const fmt = v => (v < 0 ? "- " : "") + "Rs. " + Math.abs(v).toLocaleString();
  const rows = [
    ["01. Monthly Room Rent", rent],
    ["02. Mess Charges", mess],
    ["03. Electricity Share", elec],
    [`04. Security Deposit ${s.securityPaid ? "(already paid)" : "(1st month)"}`, secDue],
    ["05. Late Fine / Arrears", other],
    ["06. Mess-off Rebate", -disc]
  ];

  const copy = (title, accent, qrId) => `
    <div style="border:2px solid #18181b;border-radius:14px;overflow:hidden;background:#fff;">
      <div style="background:#18181b;color:#fff;padding:14px 16px;display:flex;justify-content:space-between;align-items:center;">
        <div>
          <span style="font-size:9px;letter-spacing:1.5px;color:#34d399;font-weight:800;">OFFICIAL HOSTEL FEE CHALLAN</span>
          <h4 style="font-size:15px;font-weight:800;margin:2px 0 0;text-transform:uppercase;">${esc(db.settings.hostelName)}</h4>
        </div>
        <span style="background:${accent};color:#fff;font-size:9px;font-weight:800;padding:4px 9px;border-radius:6px;">${title}</span>
      </div>
      <div style="padding:14px 16px;font-size:11px;">
        <div>Challan: <strong>${challanNo}</strong> | Month: <strong>${esc(month)}</strong> | Status: <strong>${isPaid ? "PAID" : "UNPAID"}</strong></div>
        <div style="margin:8px 0;">Resident: <strong>${esc(s.name)}</strong> | Roll ID: <strong>${esc(s.id)}</strong> | Room: <strong>${esc(s.room)}</strong></div>
        <table style="width:100%;border-collapse:collapse;margin:8px 0;">
          ${rows.map(([l, v]) => `<tr><td style="padding:5px 8px;border-bottom:1px solid #f4f4f5;">${l}</td><td style="padding:5px 8px;border-bottom:1px solid #f4f4f5;text-align:right;font-weight:700;">${fmt(v)}</td></tr>`).join("")}
        </table>
        <div style="background:#18181b;color:#fff;padding:10px 14px;border-radius:10px;display:flex;justify-content:space-between;">
          <span>Total Payable</span><strong style="color:#34d399;">${money(total)}</strong>
        </div>
        <div style="margin-top:10px;font-size:10.5px;">Pay via: <strong>${esc(payOpt1)}</strong>${payOpt2 ? ` | <strong>${esc(payOpt2)}</strong>` : ""}</div>
        ${s.paymentTid ? `<div style="margin-top:4px;font-family:monospace;font-size:10px;">Submitted TID: ${esc(s.paymentTid)}</div>` : ""}
        <div id="${qrId}" style="margin-top:8px;"></div>
      </div>
    </div>`;

  const qrText = `CHALLAN:${challanNo}|ID:${s.id}|AMT:${total}`;
  showDoc(
    `Fee Challan (${month})`,
    `<div class="grid grid-cols-1 lg:grid-cols-2 gap-5">${copy("HOSTEL OFFICE COPY", "#059669", "qrOffice")}${copy("RESIDENT COPY", "#2563eb", "qrStudent")}</div>`,
    `Fee_Voucher_${s.id}.pdf`, "landscape",
    [{ id: "qrOffice", text: qrText }, { id: "qrStudent", text: qrText }]
  );
}

function openStudentQRCard(studentId) {
  const db = getDB();
  const s = db.students.find(st => st.id === studentId);
  if (!s) return;
  const avatar = s.photo
    ? `<img src="${esc(s.photo)}" class="w-20 h-20 rounded-full object-cover mx-auto border-2 border-emerald-600" />`
    : `<div class="w-20 h-20 rounded-full bg-emerald-100 text-emerald-900 font-extrabold text-2xl flex items-center justify-center mx-auto">${esc(String(s.name || "ST").substring(0, 2).toUpperCase())}</div>`;

  showDoc(
    "Digital Student Gate Pass ID Card",
    `<div class="max-w-sm mx-auto border-2 border-zinc-900 rounded-2xl overflow-hidden bg-white text-zinc-900">
      <div class="bg-zinc-900 text-white p-4 text-center">
        <h3 class="font-extrabold text-base uppercase">${esc(db.settings.hostelName)}</h3>
        <span class="text-[10px] uppercase bg-emerald-600 px-2.5 py-0.5 rounded-full font-bold">Official Resident Gate Pass</span>
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
        <div id="qrGate" class="flex justify-center"></div>
      </div>
    </div>`,
    `ID_Card_${s.id}.pdf`, "portrait",
    [{ id: "qrGate", text: `HOSTEL:${TENANT_ID}|ID:${s.id}` }]
  );
}

function openClearanceCertificate(studentId) {
  const db = getDB();
  const s = db.students.find(st => st.id === studentId);
  if (!s) return;
  const unpaid = s.feeStatus === "Paid" ? 0 : studentTotal(s);
  const held = num(s.security);
  const netRefund = Math.max(0, held - unpaid);

  showDoc(
    "No-Dues Clearance & Security Refund",
    `<div class="border-2 border-zinc-900 p-6 rounded-xl space-y-4 text-xs max-w-2xl mx-auto">
      <div class="text-center border-b-2 border-zinc-300 pb-3">
        <h2 class="text-xl font-extrabold uppercase">${esc(db.settings.hostelName)}</h2>
        <p class="text-xs font-bold text-emerald-700 uppercase mt-1">Leaving Clearance & Security Refund Certificate</p>
      </div>
      <p class="text-sm leading-relaxed">This is to certify that <strong>${esc(s.name)}</strong> (Roll ID: <strong>${esc(s.id)}</strong>, CNIC: <strong>${esc(s.cnic)}</strong>), occupant of Room <strong>${esc(s.room)}</strong>, is checking out of the hostel.</p>
      <table class="w-full text-left border border-zinc-300"><tbody class="divide-y divide-zinc-200">
        <tr><td class="p-2 font-semibold">Refundable Security Deposit Held</td><td class="p-2 text-right font-bold text-emerald-700">${money(held)}</td></tr>
        <tr><td class="p-2 font-semibold">Pending Dues Deducted</td><td class="p-2 text-right font-bold text-rose-600">- ${money(unpaid)}</td></tr>
        <tr class="bg-zinc-900 text-white text-sm"><td class="p-2.5 font-bold">NET SECURITY REFUNDABLE</td><td class="p-2.5 text-right font-bold">${money(netRefund)}</td></tr>
      </tbody></table>
    </div>`,
    `Clearance_${s.id}.pdf`, "portrait"
  );
}

function openMonthlyAuditPDF() {
  const db = getDB();
  const m = getLiveMetrics();
  const month = db.settings.currentMonth || monthLabel();
  const expRows = db.expenses.map((e, i) =>
    `<tr><td class="p-1.5 border">${i + 1}</td><td class="p-1.5 border font-semibold">${esc(e.title || "Expense")}</td><td class="p-1.5 border">${esc(e.date || "-")}</td><td class="p-1.5 border text-right font-bold text-rose-600">${money(e.amount)}</td></tr>`
  ).join("") || `<tr><td colspan="4" class="p-2 text-center text-zinc-400">No expenses recorded</td></tr>`;

  showDoc(
    `Monthly Financial Audit (${month})`,
    `<div class="border-2 border-zinc-900 p-6 rounded-xl space-y-4 text-xs max-w-3xl mx-auto">
      <div class="flex justify-between items-start border-b-2 border-zinc-900 pb-3">
        <div><h2 class="text-xl font-extrabold uppercase">${esc(db.settings.hostelName)}</h2><p class="text-xs font-bold text-emerald-700 uppercase">Monthly P&amp;L Audit</p></div>
        <span class="bg-zinc-900 text-white px-3 py-1 rounded font-bold">${esc(month)}</span>
      </div>
      <div class="grid grid-cols-4 gap-3 text-center bg-zinc-100 p-3 rounded-xl border border-zinc-300">
        <div><span class="text-[10px] text-zinc-500 block">Occupancy</span><strong>${m.occupiedBeds} / ${m.totalCapacity}</strong></div>
        <div><span class="text-[10px] text-zinc-500 block">Collected</span><strong class="text-emerald-700">${money(m.collectedFee)}</strong></div>
        <div><span class="text-[10px] text-zinc-500 block">Expenses</span><strong class="text-rose-600">${money(m.totalExpenses)}</strong></div>
        <div><span class="text-[10px] text-zinc-500 block">Net Profit</span><strong class="text-emerald-700">${money(m.netProfit)}</strong></div>
      </div>
      <table class="w-full text-left border-collapse border border-zinc-300 text-[11px]">
        <thead class="bg-zinc-200"><tr><th class="p-1.5 border">#</th><th class="p-1.5 border">Expense Head</th><th class="p-1.5 border">Date</th><th class="p-1.5 border text-right">Amount</th></tr></thead>
        <tbody>${expRows}</tbody>
      </table>
    </div>`,
    `Audit_${month.replace(/\s+/g, "_")}.pdf`, "portrait"
  );
}

function openKYCDocumentsModal(recordId) {
  const db = getDB();
  const rec = db.applications.find(a => a.id === String(recordId)) || db.students.find(s => String(s.id) === String(recordId));
  if (!rec) return alert("❌ Record nahi mila.");
  const img = (src, label) => src
    ? `<img src="${esc(src)}" class="w-full h-56 object-contain rounded-lg bg-white" />`
    : `<div class="h-56 flex items-center justify-center text-zinc-400">No ${label}</div>`;

  showDoc(
    `Identity & KYC — ${rec.name} (${rec.id})`,
    `<div class="space-y-5 text-xs max-w-3xl mx-auto p-2">
      <div class="flex flex-wrap items-center justify-between gap-4 border-b border-zinc-200 pb-4">
        <div class="flex items-center gap-4">
          ${rec.photo ? `<img src="${esc(rec.photo)}" class="w-20 h-20 rounded-2xl object-cover border-2 border-zinc-900" />` : `<div class="w-20 h-20 rounded-2xl bg-zinc-200 flex items-center justify-center font-bold text-zinc-500">No Photo</div>`}
          <div><h3 class="text-lg font-extrabold">${esc(rec.name)}</h3>
            <p class="text-zinc-600 font-mono">ID: ${esc(rec.id)} • CNIC: ${esc(rec.cnic || "—")} • Phone: ${esc(rec.phone || "—")}</p></div>
        </div>
        <span class="bg-zinc-900 text-white px-3.5 py-1.5 rounded-xl font-bold">Room ${esc(rec.room || "—")}</span>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div class="border border-zinc-300 rounded-xl p-3 bg-zinc-50 text-center"><span class="text-[11px] font-extrabold uppercase block mb-2">CNIC Front</span>${img(rec.cnicFront, "CNIC Front")}</div>
        <div class="border border-zinc-300 rounded-xl p-3 bg-zinc-50 text-center"><span class="text-[11px] font-extrabold uppercase block mb-2">CNIC Back</span>${img(rec.cnicBack, "CNIC Back")}</div>
      </div>
    </div>`,
    `KYC_${rec.id}.pdf`, "portrait"
  );
}

function openPaymentReceiptModal(studentId) {
  const s = getDB().students.find(st => st.id === studentId);
  if (!s || !s.paymentImg) return alert("⚠️ Student ne receipt attach nahi ki.");
  showDoc(
    `Payment Receipt — ${s.name} (${s.id})`,
    `<div class="max-w-md mx-auto text-center space-y-4 p-2 text-xs">
      <div class="bg-zinc-100 border border-zinc-300 rounded-xl p-3 flex justify-between"><span>Student: <strong>${esc(s.name)}</strong></span><span>TID: <strong class="font-mono">${esc(s.paymentTid || "—")}</strong></span></div>
      <img src="${esc(s.paymentImg)}" class="w-full max-h-[480px] object-contain rounded-xl border-2 border-zinc-900 mx-auto" />
    </div>`,
    `Receipt_${s.id}.pdf`, "portrait"
  );
}

function openHostelRulesModal() {
  let modal = document.getElementById("hostelRulesImgModal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "hostelRulesImgModal";
    modal.className = "fixed inset-0 bg-zinc-950/85 items-center justify-center z-[85] p-3 sm:p-5";
    modal.style.display = "none";
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
  modal.style.display = "flex";
}

function closeHostelRulesModal() {
  const m = document.getElementById("hostelRulesImgModal");
  if (m) m.style.display = "none";
}

function acceptHostelRules() {
  const chk = document.getElementById("agreeRulesCheckbox");
  if (chk) chk.checked = true;
  closeHostelRulesModal();
}

// ============================================================================
// 11. BILLING, ROOMS, MESS, REMINDERS
// ============================================================================
function checkAndApplyAutoLateFine() {
  const today = new Date();
  if (today.getDate() <= 5) return;
  const monthKey = today.getFullYear() + "-" + (today.getMonth() + 1);
  const db = getDB();
  let updated = false;
  db.students.forEach(s => {
    if (s.status === "Active" && s.feeStatus !== "Paid" && s.lastFineMonth !== monthKey) {
      s.otherCharges = num(s.otherCharges) + 200;
      s.lastFineMonth = monthKey;
      updated = true;
    }
  });
  if (updated) saveDB(db, "Unpaid students par Rs. 200 late fine lagaya gaya", "System");
}

// Naye mahine ke liye: unpaid ka baqaya arrears ban jata hai, rebate aur sub-meter reset hote hain
function carryForwardBilling(s) {
  s.otherCharges = s.feeStatus === "Paid" ? 0 : Math.max(0, studentTotal(s));
  s.elec = 0;
  s.discount = 0;
  s.securityPaid = true;
  s.feeStatus = "Unpaid";
  s.paymentTid = "";
  s.paymentImg = "";
  s.lastFineMonth = "";
}

function startNewBillingMonth() {
  const monthName = (prompt("Naye billing month ka naam (e.g. November 2026):", "") || "").trim();
  if (!monthName) return;
  const db = getDB();
  db.settings.currentMonth = monthName;
  db.students.forEach(s => { if (s.status === "Active") carryForwardBilling(s); });
  saveDB(db, `Naya billing cycle start hua: ${monthName}`, "Admin");
  alert(`✅ ${monthName} ke vouchers generate ho gaye.`);
}

function waNumber(raw) {
  const d = digitsOnly(raw);
  return d.startsWith("92") ? d : "92" + d.replace(/^0/, "");
}

function sendStudentFeeReminder(studentId) {
  const db = getDB();
  const s = db.students.find(st => st.id === studentId);
  if (!s) return;
  const month = db.settings.currentMonth || monthLabel();
  const msg = `*FEE REMINDER — ${db.settings.hostelName}*\n\nSalam *${s.name}* (${s.id}, Room ${s.room}),\nAapki *${month}* fee *${String(s.feeStatus).toUpperCase()}* hai.\n\n💰 *Payable:* ${money(studentTotal(s))}\n💳 *Account:* ${db.settings.jazzcash || "Admin se rabta karein"}`;
  window.open(`https://wa.me/${waNumber(s.phone)}?text=${encodeURIComponent(msg)}`, "_blank");
}

function sendGuardianAlert(studentId) {
  const db = getDB();
  const s = db.students.find(st => st.id === studentId);
  if (!s) return;
  const target = s.guardian || s.phone;
  if (!target) return alert("⚠️ Guardian ka number save nahi hai.");
  const msg = `*GUARDIAN ALERT — ${db.settings.hostelName}*\n\nRespected Guardian of *${s.name}* (Room ${s.room}),\nStatus: *${String(s.feeStatus).toUpperCase()}* (${money(studentTotal(s))}).`;
  window.open(`https://wa.me/${waNumber(target)}?text=${encodeURIComponent(msg)}`, "_blank");
}

function shiftStudentRoom(studentId) {
  const db = getDB();
  const s = db.students.find(st => st.id === studentId);
  if (!s) return;
  const newRoomNo = (prompt(`🔄 ${s.name} ka naya room number (abhi: ${s.room}):`, s.room) || "").trim();
  if (!newRoomNo || newRoomNo === String(s.room)) return;
  const target = db.rooms.find(r => r.no === newRoomNo);
  if (!target) return alert(`❌ Room "${newRoomNo}" exist nahi karta.`);
  s.room = target.no;
  saveDB(db, `${s.name} ko Room ${target.no} mein shift kiya`, "Admin");
  alert(`✅ ${s.name} Room ${target.no} mein shift ho gaya.`);
}

function applyMessRebate(studentId) {
  const db = getDB();
  const s = db.students.find(st => st.id === studentId);
  if (!s) return;
  const days = Number(prompt(`🍲 ${s.name} ke mess-off days:`, "5"));
  if (!days || days <= 0) return;
  const rate = Number(prompt("Per-day mess rate (Rs.):", "250"));
  if (!rate || rate <= 0) return;
  const amount = days * rate;
  s.discount = num(s.discount) + amount;
  saveDB(db, `${s.name} ko Rs. ${amount} mess rebate diya`, "Admin");
  alert(`✅ Rs. ${amount.toLocaleString()} rebate add ho gaya.`);
}

// ============================================================================
// 12. RESET, BACKUP, STAFF
// ============================================================================
async function wipeAllData() {
  if (!confirm("Kya aap sure hain? Ye sab rooms, students, applications aur records mita dega.")) return;
  const cur = getDB();
  const fresh = emptyDB();
  fresh.settings = { ...fresh.settings, ...pick(cur.settings, PUBLIC_SETTINGS) };
  try {
    const snap = await appsCol().get();
    await Promise.all(snap.docs.map(d => d.ref.delete()));
  } catch (err) { console.error("Applications delete fail:", err); }
  saveDB(fresh, "Factory reset kiya gaya", "Admin");
  setTimeout(() => location.reload(), 800);
}

function exportHostelBackupJSON() {
  alert("⚠️ Backup file mein sensitive data hai. Ise safe jagah rakhein.");
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
      if (!confirm(`"${imported.settings?.hostelName}" ka backup restore karein?`)) return;
      const db = { ...emptyDB(), ...imported, applications: getDB().applications };
      saveDB(db, "JSON backup se data restore kiya", "Admin");
    } catch (err) { alert("❌ Invalid JSON file."); }
  };
  reader.readAsText(file);
}

// ============================================================================
// 13. PWA
// ============================================================================
window.pwaPromptEvent = null;
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); window.pwaPromptEvent = e; });

window.installHostelPWA = async function () {
  if (window.pwaPromptEvent) {
    window.pwaPromptEvent.prompt();
    const res = await window.pwaPromptEvent.userChoice;
    if (res && res.outcome === "accepted") window.pwaPromptEvent = null;
  } else {
    alert("📲 Install karne ka tareeqa:\n\n1. Browser menu (⋮ ya Share) kholein.\n2. 'Install App' ya 'Add to Home Screen' par tap karein.");
  }
};

function hidePWAButtonsIfInstalled() {
  const standalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  if (standalone) document.querySelectorAll(".pwa-install-trigger").forEach(el => el.style.display = "none");
}

// ============================================================================
// 14. CUSTOM POPUP (alert replacement)
// ============================================================================
(function initCustomPopup() {
  if (document.getElementById("saasGlobalAnimations")) return;
  const style = document.createElement("style");
  style.id = "saasGlobalAnimations";
  style.innerHTML = `
    @keyframes saasModalSpring { 0% { opacity: 0; transform: scale(0.90) translateY(14px); } 100% { opacity: 1; transform: scale(1) translateY(0); } }
    #customSaaSAlertModal:not([style*="none"]) > div { animation: saasModalSpring 0.32s cubic-bezier(0.22, 1, 0.36, 1) forwards; }`;
  document.head.appendChild(style);

  window.showSaaSPopup = function (rawMsg) {
    let modal = document.getElementById("customSaaSAlertModal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "customSaaSAlertModal";
      modal.className = "fixed inset-0 bg-zinc-950/75 items-center justify-center z-[9999] p-4";
      modal.style.display = "none";
      document.body.appendChild(modal);
    }
    const msg = String(rawMsg || "").trim();
    const isError = msg.includes("❌") || /invalid|incorrect|denied|error|failed|ghalat|fail/i.test(msg);
    const isWarn = msg.includes("⚠️") || /warning|wait|please/i.test(msg);
    const lines = msg.replace(/^[✅❌⚠️🎉🗑️📲🚫ℹ️]+\s*/, "").split("\n").filter(l => l.trim() !== "");
    const badge = isError ? "bg-rose-600 text-white" : isWarn ? "bg-amber-500 text-zinc-950" : "bg-emerald-600 text-white";
    const icon = isError ? "fa-shield-xmark" : isWarn ? "fa-triangle-exclamation" : "fa-circle-check";
    modal.innerHTML = `
      <div class="bg-white border border-zinc-200 rounded-2xl max-w-sm w-full p-6 shadow-2xl space-y-4 text-zinc-900">
        <div class="flex items-start gap-3.5 border-b border-zinc-100 pb-4">
          <div class="w-11 h-11 rounded-xl ${badge} flex items-center justify-center text-lg shrink-0"><i class="fa-solid ${icon}"></i></div>
          <h3 class="text-sm sm:text-base font-extrabold flex-1 break-words">${esc(lines[0] || "Notice")}</h3>
          <button type="button" onclick="closeSaaSPopup()" class="text-zinc-400 hover:text-zinc-800 text-xl leading-none">&times;</button>
        </div>
        ${lines.length > 1 ? `<div class="bg-zinc-50 border border-zinc-200 rounded-xl p-3.5 space-y-1 text-xs text-zinc-700 font-medium">${lines.slice(1).map(l => `<div>${esc(l)}</div>`).join("")}</div>` : ""}
        <button type="button" onclick="closeSaaSPopup()" class="w-full ${isError ? "bg-rose-600 hover:bg-rose-500" : "bg-zinc-900 hover:bg-zinc-800"} text-white py-3 rounded-xl text-xs font-extrabold uppercase tracking-wider">Continue →</button>
      </div>`;
    modal.style.display = "flex";
  };

  window.closeSaaSPopup = function () {
    const m = document.getElementById("customSaaSAlertModal");
    if (m) m.style.display = "none";
  };

  window.alert = function (message) { window.showSaaSPopup(message); };
})();

// ============================================================================
// 15. BOOT
// ============================================================================
initCloud();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

window.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll("a[href]").forEach(a => {
    const h = a.getAttribute("href");
    if (h && !/^(https?:|#|tel:|mailto:)/.test(h) && !h.includes("hostel=")) {
      a.setAttribute("href", h + (h.includes("?") ? "&" : "?") + "hostel=" + TENANT_ID);
    }
  });
  applyBrandLogoEverywhere();
  hidePWAButtonsIfInstalled();
  refreshCurrentPortalUI();
});
