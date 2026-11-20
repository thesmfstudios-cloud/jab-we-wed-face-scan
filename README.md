# Jab We Wed — AI Face Scan & Free Wedding Photo Downloads

**jab ♡ we wed.. by SMF Studios**

Wedding guests scan a QR code, take or upload a selfie, find their own photos with
Amazon Rekognition, and download the full-resolution originals for free.

This is an independent app built from the SMF *Face Match* codebase
(`meharshiva2109-sketch/Face-Match-Final@7b704e8`). It also takes the matching and indexing
tuning from the live deployment's repo (`thesmfstudios-cloud/Face-match@6b256b2`). It has its own repo, its own
Supabase project, its own Rekognition collection namespace (`jab-we-wed-*`), and its own
Vercel project. The original app is not touched.

## What changed from Face Match

| Area | Face Match | Jab We Wed |
|---|---|---|
| Payments | Razorpay/UPI, orders, UTR approval, prices | **Removed completely** (routes, tables, deps, UI) |
| Events | Hard-coded `sam-college-2026` | Unlimited weddings, each with its own slug, QR, collection |
| Matching | Rekognition `SearchFacesByImage` @85 | Same, at 80 by default (live app uses 75) (`MATCH_SIMILARITY_THRESHOLD`), with checks on how confidently a face was detected in the selfie, plus DB checks that each match belongs to the event |
| Downloads | Paid order → server ZIP | Free. Server-verified match session → 5-min signed URLs → original or browser-built ZIP |
| Storage | Public previews bucket | **Both buckets private**. Previews also go through signed URLs |
| Admin auth | Code sent in a header on every call | httpOnly, SameSite=Strict HMAC session cookie; same-origin check on writes; rate-limited login |
| Indexing | Re-indexes everything | Incremental: only photos not yet indexed; face IDs are stored so deleting photos also removes their faces |

## Routes

- `/` — brand landing and gallery-name entry
- `/w/[slug]` — a wedding's guest portal (welcome → selfie → scan → gallery → download)
- `/privacy` — selfie and privacy policy
- `/admin` — studio dashboard (weddings list, create)
- `/admin/events/[id]` — overview & guest access, QR (PNG/SVG/branded card), upload, face index, library, settings

API: `/api/match`, `/api/download`, `/api/events/[slug]`, `/api/admin/*`.

## Google Drive folders

Each wedding can be linked to a Google Drive folder (Upload tab → *Google Drive folder*).

**No setup (default).** Share the folder as *Anyone with the link* (Viewer) and paste the
link. With no Google credentials set, the app reads Drive's public folder view
(`embeddedfolderview`) and public download host. After syncing, the admin runs the face
index automatically. Guests still download through `/api/download/file` (see below).

**Private folders (recommended, `GOOGLE_SERVICE_ACCOUNT_JSON`).** Create a Google Cloud
service account, enable the Google Drive API, download its JSON key and paste the whole
file into this variable. The admin shows the service account's email: share each wedding
folder with it as **Viewer**, paste the folder link, press **Connect & sync**.
Guests get originals through `/api/download/file`, which streams them from Drive only for
a valid face-match session (HMAC ticket, 30 min, gallery must be open). Downloads go
through Vercel, so they count towards Vercel bandwidth.

**API key (`GOOGLE_DRIVE_API_KEY`).** Folder shared as *Anyone with the link*; listing
and downloads use the official Drive API. Used only when no service account is set.

In every mode guests download originals through `/api/download/file` (streamed, so the
4.5 MB response limit does not apply), which counts towards Vercel bandwidth.

In both modes:
- JPG/PNG photos in the folder and its sub-folders are added; re-sync adds only new ones.
- **Face index** fetches each Drive photo once on the server, stores only a small preview
  (≤1600 px, ≤900 KB) in `jw-previews`, and indexes its faces. Originals are **not** copied.
- Needs `supabase/migrations/002_google_drive.sql`.
- Deleting a photo in the admin removes it from the portal only; the Drive file stays.

## Security model

- Guests never get table or storage access. RLS is on with no anon policies; all access goes through server routes that use the service role.
- `/api/match` processes the selfie **in memory only**. It is never saved. On a match it creates a `jw_match_sessions` row (the token is stored only as a SHA-256 hash; it expires after 2 h by default) listing the exact photo IDs that matched.
- `/api/download` only signs photos that are in that session **and** belong to that session's event. Changing photo IDs or the event in the browser gets a 403.
- Turning off guest access or archiving a wedding deletes its sessions straight away.
- Scans, downloads and admin logins are rate-limited per IP through a Postgres function.

## Setup

1. **Supabase (new project).** Run `supabase/migrations/001_jab_we_wed.sql`, then `002_google_drive.sql`. It creates the tables, functions, and the private buckets `jw-originals` (50 MB/file) and `jw-previews`.
2. **AWS.** Create a dedicated IAM user with only these permissions: `rekognition:CreateCollection`, `DescribeCollection`, `DeleteCollection`, `IndexFaces`, `SearchFacesByImage`, `DeleteFaces`, on `arn:aws:rekognition:<region>:<acct>:collection/jab-we-wed-*`.
3. **Vercel.** Set the variables from `.env.example`, then deploy.
4. Open `/admin` → New wedding → Upload → Face index → Overview: turn on *Gallery published* and *Guests can scan & download* → download the QR.

### Environment checklist

| Variable | Where | Notes |
|---|---|---|
| `NEXT_PUBLIC_SITE_URL` | all | Used in QR codes, e.g. `https://jab-we-wed-face-scan.vercel.app` |
| `NEXT_PUBLIC_SUPABASE_URL` | all | New project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | all | Publishable key; only used for signed uploads |
| `SUPABASE_SERVICE_ROLE_KEY` | server, sensitive | Never expose |
| `ADMIN_ACCESS_CODE` | server, sensitive | 12+ chars |
| `ADMIN_SESSION_SECRET` | server, sensitive | 32+ random chars |
| `AWS_REGION` | server | e.g. `ap-south-1` |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | server, sensitive | Dedicated IAM user |
| `AWS_REKOGNITION_COLLECTION_PREFIX` | server | `jab-we-wed` (must differ from `smf-face`) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | server, sensitive | Private Drive folders: whole service-account JSON key |
| `GOOGLE_DRIVE_API_KEY` | server | Public-link Drive folders only |
| `MATCH_SIMILARITY_THRESHOLD` | optional | Default 80 (70–99.5) |
| `DOWNLOAD_SESSION_MINUTES` | optional | Default 120 |
| `MATCH_RATE_LIMIT` | optional | Scans per IP per 10 min, default 12 |

## Testing

```bash
npm install
PLAYWRIGHT_PATH=/path/to/playwright node tests/e2e.mjs
```

`tests/e2e.mjs` builds the app, runs the real production server against an offline
mock of Supabase and Rekognition (`tests/mock-backend.mjs`), and drives Chrome through
the admin and guest flows on desktop and phone viewports. It covers 62 checks:
uploads, duplicates, indexing, QR, camera, matching, single/selected/all ZIP downloads
with byte-for-byte original checks, event isolation, token tampering, expiry,
rate limits, and the removed payment routes. Screenshots go to `tests/.artifacts/`.
The mock does not replace a live test against real Supabase and AWS.

`node tests/drive.mjs` tests the Google Drive import the same way (mock Drive API and
Google OAuth): private service-account mode by default, `DRIVE_MODE=public` for API-key
mode, `DRIVE_MODE=link` for the no-setup public-link mode.
