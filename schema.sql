-- ============================================================
-- Tarshid (ترشيد) Smart Library — Supabase SQL Schema
-- Run this in your Supabase SQL Editor to create/reconcile
-- the three required tables: students, books, logs
-- ============================================================

-- ─── Students ───────────────────────────────────────────────
-- Stores each RFID card holder (student/staff) with their
-- current status (Inside / Outside) and entry/exit timestamps.

CREATE TABLE IF NOT EXISTS public.students (
  uid          TEXT PRIMARY KEY,          -- RFID UID or national ID
  name         TEXT NOT NULL,             -- full name
  national_id  TEXT UNIQUE DEFAULT '',    -- national ID number
  gender       TEXT DEFAULT 'غير محدد',   -- gender label
  status       TEXT DEFAULT 'Outside' CHECK (status IN ('Inside', 'Outside')),
  entry_time   TEXT DEFAULT '',           -- ISO timestamp of last entry
  exit_time    TEXT DEFAULT '',           -- ISO timestamp of last exit
  last_seen    TEXT DEFAULT '',           -- ISO timestamp of last activity
  created_at   TIMESTAMPTZ DEFAULT now()
);

-- Index for fast lookup by national_id (used in RFID scan fallback)
CREATE INDEX IF NOT EXISTS idx_students_national_id ON public.students (national_id);
-- Index for fast crowd-count queries
CREATE INDEX IF NOT EXISTS idx_students_status ON public.students (status);


-- ─── Books ──────────────────────────────────────────────────
-- Stores barcode-scanned books with borrow status.

CREATE TABLE IF NOT EXISTS public.books (
  code       TEXT PRIMARY KEY,            -- barcode (unique)
  title      TEXT NOT NULL,               -- book title
  author     TEXT DEFAULT 'Unknown Author',
  status     TEXT DEFAULT 'Available' CHECK (status IN ('Available', 'Borrowed')),
  holder_id  TEXT DEFAULT '-',            -- UID of current borrower
  cover_url  TEXT DEFAULT '',             -- Supabase Storage public URL
  updated_at TIMESTAMPTZ DEFAULT now(),   -- last borrow/return timestamp
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Index for fast borrow-lookup by status
CREATE INDEX IF NOT EXISTS idx_books_status ON public.books (status);


-- ─── Logs ───────────────────────────────────────────────────
-- Chronological event log for all RFID scans, borrows, returns.

CREATE TABLE IF NOT EXISTS public.logs (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  student_uid         TEXT DEFAULT '',
  student_name        TEXT DEFAULT '',
  student_national_id TEXT DEFAULT '',
  action              TEXT NOT NULL,       -- 'دخول', 'خروج', 'استعارة كتاب: xxx', 'إرجاع كتاب: xxx', etc.
  created_at          TIMESTAMPTZ DEFAULT now()
);

-- Index for reverse-chronological listing (most recent first)
CREATE INDEX IF NOT EXISTS idx_logs_created_at ON public.logs (created_at DESC);
-- Index for per-student history lookup
CREATE INDEX IF NOT EXISTS idx_logs_student_uid ON public.logs (student_uid);


-- ─── Storage bucket (run once via Supabase Dashboard too) ───
-- INSERT INTO storage.buckets (id, name, public)
-- VALUES ('book-covers', 'book-covers', true)
-- ON CONFLICT (id) DO NOTHING;
-- Then set bucket policy:
--   Allow PUBLIC to SELECT
--   Allow authenticated (service_role) to INSERT/UPDATE/DELETE
