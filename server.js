// ============================================================
// Tarshid (ترشيد) Smart Library — Node.js Backend Server
// ============================================================
//
// This server provides:
//   • REST API for students, books, logs, and authentication
//   • ESP32 /hardware/rfid endpoint for RFID check-in/check-out
//   • Real‑time WebSocket broadcasts (crowd level, status)
//   • File‑upload endpoint for book covers (Supabase Storage)
//   • Barcode‑based borrow/return/lookup workflow
//
// ============================================================

require('dotenv').config();
const express       = require('express');
const cors          = require('cors');
const { createClient } = require('@supabase/supabase-js');
const fs            = require('fs');
const path          = require('path');
const http          = require('http');
const WebSocket     = require('ws');

const app = express();
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

// ─── Supabase client ────────────────────────────────────────
// Requires SUPABASE_URL and SUPABASE_KEY in .env

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ─── Helper: input sanitisation ─────────────────────────────
// Prevents injection, truncates over-long values, handles
// non‑string types gracefully (ESP32 may send numbers).

function sanitizeString(value, maxLen = 255) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).trim().slice(0, maxLen);
}

function sanitizeIdentifier(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_\-\s]/g, '').trim().slice(0, 64);
}

// ─── In‑memory scan cache ───────────────────────────────────
// Hardware RFID scans are stored here and polled by the
// frontend on /scan-rfid. Cleared after one read.

let lastRfidScan = null;

// ─── WebSocket: broadcast real‑time status to all clients ───
// FIX: crowdLevel is now derived from the *actual* count of
// students whose status = 'Inside' in the database, NOT from
// a stale static `peopleCount` variable that was never updated.

async function broadcastStatusUpdate() {
  try {
    const { count: studentsInsideCount } = await supabase
      .from('students')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'Inside');

    const { count: booksTotal } = await supabase
      .from('books')
      .select('*', { count: 'exact', head: true });

    const inside = studentsInsideCount || 0;

    const payload = {
      type: "status_update",
      payload: {
        freeHeap:      process.memoryUsage().heapFree,
        uptimeSeconds: Math.floor(process.uptime()),
        studentsInside: inside,
        booksTotal:    booksTotal || 0,
        peopleCount:   inside,          // kept for backward‑compat with frontend
        crowdLevel:    inside === 0 ? "Empty" : (inside <= 12 ? "Moderate" : "Crowded"),
        serverState:   "Active"
      }
    };

    const message = JSON.stringify(payload);
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        try { client.send(message); } catch (_) { /* ignore single‑client failures */ }
      }
    });
  } catch (error) {
    console.error("❌ WebSocket broadcast error:", error);
  }
}

// FIX: notify by WebSocket when a hardware RFID scan arrives
function notifyNewRfidScan(uid) {
  const message = JSON.stringify({ type: "rfid_scan", uid });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(message); } catch (_) {}
    }
  });
}

wss.on('connection', (ws) => {
  console.log('🔗 Browser connected via WebSocket');
  broadcastStatusUpdate();
  ws.on('close', () => console.log('❌ Browser disconnected from WebSocket'));
});

// ─── Express middleware ─────────────────────────────────────

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Local fallback folder for cover images (mirrors Supabase Storage)
const coversDir = path.join(__dirname, 'public', 'covers');
if (!fs.existsSync(coversDir)) {
  fs.mkdirSync(coversDir, { recursive: true });
}
app.use('/covers', express.static(coversDir));

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// ─── Auth helpers ───────────────────────────────────────────

const SECRET_ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

const verifyToken = (req, res, next) => {
  const token = req.headers['authorization'];
  if (!token || token !== SECRET_ADMIN_TOKEN) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  next();
};

// ─── Logging helper ─────────────────────────────────────────
// Writes one row to the `logs` table for every meaningful event.

async function logMovement(uid, name, nationalId, action) {
  try {
    const { error } = await supabase.from('logs').insert({
      student_uid: uid,
      student_name: name,
      student_national_id: nationalId,
      action
    });
    if (error) throw error;
    console.log(`📝 Log: ${name} — ${action}`);
  } catch (err) {
    console.error('❌ Log write error:', err);
  }
}

// ─────────────────────────────────────────────────────────────
//  ROUTES
// ─────────────────────────────────────────────────────────────

// ─── GET / — serve the PWA entry point ──────────────────────

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index2.html'));
});

// ─── POST /api/login — authenticate admin ───────────────────

app.post('/api/login', (req, res) => {
  try {
    const body = req.body || {};
    const username = sanitizeString(body.username);
    const password = sanitizeString(body.password);
    if (username === "admin" && password === ADMIN_PASSWORD) {
      res.json({ status: "success", token: SECRET_ADMIN_TOKEN });
    } else {
      res.status(401).json({ status: "error", message: "بيانات الدخول خاطئة" });
    }
  } catch (error) {
    console.error("❌ POST /api/login error:", error);
    res.status(500).json({ message: "حدث خطأ داخلي" });
  }
});

// ─── POST /hardware/rfid — ESP32 check‑in / check‑out ───────
//
// FIX: This endpoint previously did not exist (404). It now:
//   1. Stores the raw scan in `lastRfidScan` for frontend polling
//   2. Looks up the student by uid OR national_id
//   3. Toggles status (Inside ↔ Outside)
//   4. Updates entry_time / exit_time accordingly
//   5. Writes a log entry
//   6. Broadcasts the new crowd level to all WebSocket clients
//
// Accepts both JSON and URL‑encoded bodies from the ESP32.

app.post('/hardware/rfid', async (req, res) => {
  try {
    const body = req.body || {};
    const identifier = sanitizeIdentifier(body.uid || body.id);

    if (!identifier) return res.status(400).json({ message: "Missing Identifier" });
    if (identifier.length < 2) return res.status(400).json({ message: "Identifier too short" });

    console.log(`📡 RFID scan received: ${identifier}`);

    // Notify frontend via WebSocket + polling cache
    notifyNewRfidScan(identifier);
    lastRfidScan = { uid: identifier, exists: false };

    const { data: student, error: findError } = await supabase
      .from('students')
      .select('*')
      .or(`uid.eq.${identifier},national_id.eq.${identifier}`)
      .maybeSingle();

    if (findError) throw findError;

    if (student) {
      // Toggle status
      const newStatus  = student.status === 'Inside' ? 'Outside' : 'Inside';
      const actionLabel = newStatus === 'Inside' ? 'دخول' : 'خروج';
      const nowISO = new Date().toISOString();

      const updates = {
        status:    newStatus,
        last_seen: nowISO
      };
      if (newStatus === 'Inside') {
        updates.entry_time = nowISO;
      } else {
        updates.exit_time  = nowISO;
      }

      const { error: updateError } = await supabase
        .from('students')
        .update(updates)
        .eq('uid', student.uid);

      if (updateError) throw updateError;

      lastRfidScan = { student, uid: student.uid, exists: true, name: student.name };
      await logMovement(student.uid, student.name, student.national_id, actionLabel);
      broadcastStatusUpdate();

      res.json({ message: "تم تسجيل الحركة بنجاح" });
    } else {
      await logMovement(identifier, "طالب غير معروف", "-", "محاولة مسح لبطاقة/رقم مجهول");
      broadcastStatusUpdate();
      res.status(404).json({ message: "هذا الرقم القومي غير مسجل" });
    }
  } catch (error) {
    console.error("❌ POST /hardware/rfid error:", error);
    res.status(500).json({ message: "حدث خطأ داخلي" });
  }
});

// ─── POST /scan-rfid — frontend polls the last hardware scan ─

app.post('/scan-rfid', async (req, res) => {
  try {
    const scan = lastRfidScan;
    lastRfidScan = null;
    res.json(scan || { uid: "", exists: false });
  } catch (error) {
    console.error("❌ POST /scan-rfid error:", error);
    res.status(500).json({ message: "حدث خطأ داخلي" });
  }
});

// ─── GET /students — fetch all students ─────────────────────
// FIX: Wrapped in try/catch so a schema mismatch returns a
// clean 500 JSON instead of crashing the process.
// Returns an empty array on failure.

app.get('/students', async (req, res) => {
  try {
    const { data: students, error } = await supabase
      .from('students')
      .select('*')
      .order('uid', { ascending: false });

    if (error) throw error;
    res.json(students || []);
  } catch (error) {
    console.error("❌ GET /students error:", error);
    res.status(500).json({ message: "خطأ في جلب بيانات الطلاب" });
  }
});

// ─── POST /students/add — register a new student ────────────

app.post('/students/add', verifyToken, async (req, res) => {
  try {
    const body = req.body || {};
    const uid       = sanitizeIdentifier(body.uid);
    const name      = sanitizeString(body.name, 100);
    const nationalId = sanitizeString(body.nationalId, 20);
    const gender    = sanitizeString(body.gender, 10) || "غير محدد";
    const lastSeen  = sanitizeString(body.lastSeen);

    if (!uid)       return res.status(400).json({ message: "UID مطلوب" });
    if (!name)      return res.status(400).json({ message: "الاسم مطلوب" });
    if (!nationalId) return res.status(400).json({ message: "الرقم القومي مطلوب" });

    const { data: existing } = await supabase
      .from('students')
      .select('uid')
      .eq('uid', uid)
      .maybeSingle();

    if (existing) {
      return res.status(409).json({ message: "هذا الرقم (UID) مسجل مسبقاً" });
    }

    const { error } = await supabase.from('students').insert({
      uid,
      name,
      national_id: nationalId,
      gender,
      last_seen: lastSeen || new Date().toISOString(),
      status: "Outside",
      entry_time: "",
      exit_time: ""
    });

    if (error) throw error;

    broadcastStatusUpdate();
    res.json({ message: "تم تسجيل الطالب بنجاح" });
  } catch (error) {
    console.error("❌ POST /students/add error:", error);
    res.status(500).json({ message: "حدث خطأ أثناء حفظ الطالب" });
  }
});

// ─── POST /students/update — edit an existing student ───────
// FIX: This endpoint was missing in earlier versions (404).
// Now supports partial updates: only the fields sent in the
// request body are written to the database.

app.post('/students/update', verifyToken, async (req, res) => {
  try {
    const body = req.body || {};
    const uid = sanitizeIdentifier(body.uid);

    if (!uid) return res.status(400).json({ message: "UID مطلوب" });

    const updates = {};
    if (body.name      !== undefined) updates.name       = sanitizeString(body.name, 100);
    if (body.nationalId !== undefined) updates.national_id = sanitizeString(body.nationalId, 20);
    if (body.gender    !== undefined) updates.gender      = sanitizeString(body.gender, 10);
    if (body.lastSeen  !== undefined) updates.last_seen   = sanitizeString(body.lastSeen);

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ message: "لا توجد بيانات للتحديث" });
    }

    const { data: updated, error } = await supabase
      .from('students')
      .update(updates)
      .eq('uid', uid)
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!updated) return res.status(404).json({ message: "الطالب غير موجود" });

    res.json({ message: "تم تحديث البيانات بنجاح" });
  } catch (error) {
    console.error("❌ POST /students/update error:", error);
    res.status(500).json({ message: "فشل تحديث البيانات" });
  }
});

// ─── DELETE /students/delete — remove a student ─────────────

app.delete('/students/delete', verifyToken, async (req, res) => {
  try {
    const body = req.body || {};
    const uid = sanitizeIdentifier(body.uid);

    if (!uid) return res.status(400).json({ message: "UID مطلوب" });

    const { error } = await supabase
      .from('students')
      .delete()
      .eq('uid', uid);

    if (error) throw error;

    broadcastStatusUpdate();
    res.json({ message: "تم حذف الطالب بنجاح" });
  } catch (error) {
    console.error("❌ DELETE /students/delete error:", error);
    res.status(500).json({ message: "حدث خطأ أثناء الحذف" });
  }
});

// ─── GET /books — fetch all books ───────────────────────────
// FIX: Wrapped in try/catch so a schema mismatch returns a
// clean 500 JSON instead of crashing the process.
// Returns an empty array on failure.

app.get('/books', async (req, res) => {
  try {
    const { data: books, error } = await supabase
      .from('books')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(books || []);
  } catch (error) {
    console.error("❌ GET /books error:", error);
    res.status(500).json({ message: "خطأ في جلب بيانات الكتب" });
  }
});

// ─── POST /upload-cover — upload a book cover image ─────────
// Stores image in Supabase Storage ('book-covers' bucket) and
// saves the public URL to the `cover_url` column of the book.

app.post('/upload-cover', verifyToken, async (req, res) => {
  try {
    const { code, image } = req.body;

    if (!code || !image || typeof image !== 'string') {
      return res.status(400).json({ message: "البيانات غير مكتملة" });
    }

    const base64Data = image.replace(/^data:image\/\w+;base64,/, "");
    const buffer = Buffer.from(base64Data, 'base64');
    const safeCode = String(code).replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safeCode) {
      return res.status(400).json({ message: "كود الكتاب غير صالح بعد التنظيف" });
    }

    const fileName = `${safeCode}.jpg`;
    const { error: uploadError } = await supabase.storage
      .from('book-covers')
      .upload(fileName, buffer, {
        contentType: 'image/jpeg',
        upsert: true
      });

    if (uploadError) throw uploadError;

    const { data: urlData } = supabase.storage
      .from('book-covers')
      .getPublicUrl(fileName);

    const publicUrl = urlData?.publicUrl;
    if (!publicUrl) throw new Error("فشل الحصول على رابط الصورة");

    const { error: updateError } = await supabase
      .from('books')
      .update({ cover_url: publicUrl })
      .eq('code', safeCode);

    if (updateError) throw updateError;

    console.log(`📸 Cover uploaded for book: ${safeCode}`);
    res.json({ message: "تم حفظ الصورة بنجاح", coverUrl: publicUrl });
  } catch (error) {
    console.error("❌ POST /upload-cover error:", error);
    res.status(500).json({ message: "فشل الحفظ في السيرفر" });
  }
});

// ─── GET /status — server health + crowd level ──────────────
// FIX: crowdLevel is computed from the real DB count of
// students with status = 'Inside', not from a static variable.

app.get('/status', async (req, res) => {
  try {
    const { count: studentsInsideCount } = await supabase
      .from('students')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'Inside');
    const { count: booksTotal } = await supabase
      .from('books')
      .select('*', { count: 'exact', head: true });

    const inside = studentsInsideCount || 0;

    res.json({
      freeHeap:      process.memoryUsage().heapFree,
      uptimeSeconds: Math.floor(process.uptime()),
      studentsInside: inside,
      booksTotal:    booksTotal || 0,
      peopleCount:   inside,
      crowdLevel:    inside === 0 ? "Empty" : (inside <= 12 ? "Moderate" : "Crowded"),
      serverState:   "Active"
    });
  } catch (error) {
    console.error("❌ GET /status error:", error);
    res.status(500).json({ message: "خطأ في جلب الحالة" });
  }
});

// ─── GET /logs — export logs as CSV ─────────────────────────

app.get('/logs', async (req, res) => {
  try {
    const { data: logs, error } = await supabase
      .from('logs')
      .select('*')
      .order('id', { ascending: false })
      .limit(500);

    if (error) throw error;

    let csv = "Time,UID,Name,NationalID,Action\n";
    if (logs && logs.length > 0) {
      csv += logs.map(log => {
        const timestamp = log.created_at || log.timestamp || new Date().toISOString();
        return `${timestamp},${log.student_uid},${log.student_name},${log.student_national_id},${log.action}`;
      }).join('\n');
    }

    res.type('text/csv').send(csv);
  } catch (error) {
    console.error("❌ GET /logs error:", error);
    res.type('text/csv').send("Time,UID,Name,NationalID,Action\n");
  }
});

// ─── POST /barcode — full barcode CRUD workflow ─────────────
// Supports actions: lookup, add, update, delete, borrow, return.
// The ESP32 barcode scanner or frontend simulation calls this.

app.post('/barcode', verifyToken, async (req, res) => {
  try {
    const body = req.body || {};
    const code    = sanitizeString(body.code, 64);
    const title   = sanitizeString(body.title, 200);
    const author  = sanitizeString(body.author, 100);
    const action  = sanitizeString(body.action, 20);
    const holderId = sanitizeIdentifier(body.holderId);

    if (!code) return res.status(400).json({ message: "كود الكتاب مطلوب" });

    const { data: existingBook, error: findError } = await supabase
      .from('books')
      .select('*')
      .eq('code', code)
      .maybeSingle();

    if (findError) throw findError;

    if (action === "lookup") {
      if (!existingBook) return res.json({ message: "خطأ: الكتاب غير موجود", status: "unknown" });
      return res.json({
        message: "تم العثور على الكتاب",
        code: existingBook.code,
        title: existingBook.title,
        author: existingBook.author,
        status: existingBook.status || "Available",
        holder_id: existingBook.holder_id || "-"
      });
    }

    if (action === "add") {
      if (existingBook) return res.json({ message: "خطأ: هذا الكود موجود مسبقاً" });
      const { error } = await supabase.from('books').insert({ code, title, author });
      if (error) throw error;
      return res.json({ message: "تمت إضافة الكتاب بنجاح" });
    }

    if (action === "update") {
      if (!existingBook) return res.json({ message: "خطأ: الكتاب غير موجود" });
      const { error } = await supabase
        .from('books')
        .update({ title: title || existingBook.title, author: author || existingBook.author })
        .eq('code', code);
      if (error) throw error;
      return res.json({ message: "تم تحديث بيانات الكتاب بنجاح" });
    }

    if (action === "delete") {
      if (!existingBook) return res.json({ message: "خطأ: الكتاب غير موجود" });
      const { error } = await supabase.from('books').delete().eq('code', code);
      if (error) throw error;
      return res.json({ message: "تم حذف الكتاب بنجاح" });
    }

    if (action === "borrow") {
      if (!existingBook) return res.json({ message: "خطأ: الكتاب غير موجود" });
      if (existingBook.status === "Borrowed") return res.json({ message: "خطأ: الكتاب مستعار بالفعل" });
      if (!holderId) return res.status(400).json({ message: "رقم الطالب مطلوب للاستعارة" });

      const { data: existingStudent, error: studentError } = await supabase
        .from('students')
        .select('*')
        .or(`uid.eq.${holderId},national_id.eq.${holderId}`)
        .maybeSingle();

      if (studentError) throw studentError;
      if (!existingStudent) {
        return res.status(404).json({ message: "خطأ: بيانات الطالب غير صحيحة أو غير مسجل بالنظام" });
      }

      const { error: updateError } = await supabase
        .from('books')
        .update({ status: "Borrowed", holder_id: existingStudent.uid })
        .eq('code', code);

      if (updateError) throw updateError;

      broadcastStatusUpdate();
      await logMovement(existingStudent.uid, existingStudent.name, existingStudent.national_id, `استعارة كتاب: ${code}`);
      return res.json({ message: "تمت الاستعارة بنجاح", studentName: existingStudent.name });
    }

    if (action === "return") {
      if (!existingBook) return res.status(404).json({ message: "خطأ: الكتاب غير موجود" });

      const previousHolderUid = existingBook.holder_id;
      let stuName = "طالب غير معروف";
      let stuNid  = "-";

      if (previousHolderUid && previousHolderUid !== "-") {
        const { data: ps } = await supabase
          .from('students')
          .select('name, national_id')
          .eq('uid', previousHolderUid)
          .maybeSingle();
        if (ps) {
          stuName = ps.name;
          stuNid  = ps.national_id;
        }
      }

      const { error: updateError } = await supabase
        .from('books')
        .update({ status: "Available", holder_id: "-" })
        .eq('code', code);

      if (updateError) throw updateError;

      broadcastStatusUpdate();
      await logMovement(previousHolderUid, stuName, stuNid, `إرجاع كتاب: ${code}`);
      return res.json({ message: "تم إرجاع الكتاب بنجاح", studentName: stuName });
    }

    res.json({ message: "خطأ: إجراء غير معروف" });
  } catch (error) {
    console.error("❌ POST /barcode error:", error);
    res.status(500).json({ message: "حدث خطأ في معالجة طلب الكتاب" });
  }
});

// ─── Start server ───────────────────────────────────────────
// FIX: The `peopleCount` static variable has been removed
// entirely. Crowd level is always calculated from the DB.

server.listen(PORT, () => {
  console.log(`=================================`);
  console.log(`🚀 Tarshid Server running on: http://localhost:${PORT}`);
  console.log(`🔗 WebSocket: ws://localhost:${PORT}/ws`);
  console.log(`=================================`);
});
