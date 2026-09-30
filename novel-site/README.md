# Novel site

A web novel hosting site for fan translations. The layout is modelled on ranobes: dark top bar, story cards with covers, a "latest updates" feed, a right sidebar, and a configurable chapter reader. It has a **separate admin panel** built for fast batch uploads.

- **Stack:** Node.js 22 + Express + SQLite (built into Node, nothing to install) + EJS templates.
- **Storage:** one database file plus an uploads folder for covers. Back up those two and you have everything.

## Features

**Readers**
- Home page: popular shelf, latest chapter updates, new novels, top rated, genre list
- Catalog with search, genre/status filters and sorting (updated, new, popular, rating, chapters, A–Z)
- Novel page: cover, info table, rating, synopsis, tags, paginated table of contents, "Continue reading"
- Reader:
  - 5 themes (light, sepia, green, dark, OLED black); font, size, line spacing, width and alignment settings
  - ← → keys to change chapter, C for contents, S for settings
  - Progress bar, searchable contents panel, read-chapter markers
- Accounts: library/bookmarks with "N new chapters" badges and automatic progress saving, ratings, chapter comments
- Night mode for the whole site; works on mobile

**Admin panel** (`/admin`), a separate app with its own login, look and navigation
- First visit to `/admin` creates your **owner account**, so no setup files are needed
- Dashboard with stats and one-click actions
- **Batch upload** in three modes:
  1. *One file per chapter:* drop many `.txt`, `.docx`, `.md` or `.html` files, a whole folder, a **`.zip`** of chapter files, or an **`.epub`** (each section becomes a chapter, titled from its heading or the book's table of contents)
  2. *One big file, auto-split:* splits at lines like "Chapter 12", "Ch. 12 - Title", "第12章", "Prologue", "Epilogue"
  3. *Paste text:* paste many chapters at once
- The preview is editable before anything is saved:
  - Fix numbers and titles, and preview each chapter
  - Renumber, sort, or strip "Chapter N:" from titles
  - Choose to skip or replace chapters that already exist
- Large batches are sent in chunks with a progress bar
- Chapter manager:
  - Edit numbers and titles inline (click, type, Enter)
  - Shift-click to select a range; bulk delete; shift numbers; renumber 1…N
- Chapter editor (plain text, Markdown or HTML); novel editor with drag-and-drop cover
- Users: create translator accounts, change roles, reset passwords. Translators can only manage their own novels.
- Site settings in the browser: site name, tagline, announcement banner, footer, sign-ups on/off, comments on/off
- Comment moderation

**Added in v2**
- **View counter per novel:** total, this week, this month, popularity rank and library count on every novel page. Views are counted once per reader per chapter, and bots are ignored.
- **Trending:** "Trending this week" ranking in the sidebar, catalog sorts for trending, popular this month and all time, and a 🔥 weekly count on story cards
- **Admin stats:** 30-day views chart on the dashboard and per novel, most-read chapters, reader retention, views today/this week
- **Scheduled releases:** batch upload can "release gradually" (e.g. one chapter every 24 hours from a start time). You can schedule, release now or unschedule single chapters or selections. Readers see a "Coming soon" list and "next chapter releases on…".
- **One-click updates:** Admin → Update & backup → Check for updates → Install update. It pulls the latest code from GitHub and restarts, with no terminal needed. The same page has a database backup download.
- **Discovery:**
  - Live search suggestions, random novel button, "You may also like", clickable tags, completed-novels shelf
  - "Continue reading" row on the home page and a reading history page (works without an account)
- **Sharing & SEO:** RSS feeds (site-wide and per novel), link previews for Discord/Twitter (Open Graph), sitemap.xml and robots.txt

**Added in v3 (ranobes-style UI)**
- Library lists: Reading / Plan to read / Completed / On hold / Dropped, with tabs, progress bars and a "move to list" menu
- Reviews on novel pages, rating breakdown bars, Chapters/Reviews tabs, "NEW" badges on fresh chapters
- User profile pages (translations, reviews, comments, currently reading)
- Genres dropdown and mobile ☰ menu in the header, back-to-top button, bigger footer
- Protected 👑 owner account: only the owner can manage admins, and nobody else can change the owner's account

**Added in v4**
- **Undo last update:** every update first saves the previous version and a database snapshot, and Update & backup has a one-click "Undo last update"
- **Report a problem:** readers flag typos, wrong names or missing text (selected text is quoted automatically). Reports land in an admin **Reports** inbox with a sidebar badge; "Fix in editor" opens the chapter with the reported text selected.
- **🔔 New-chapter notifications** for novels on a reader's Reading / Plan to read lists
- **Emoji reactions** under each chapter
- **Volumes:** detected from "Volume 2 Chapter 5" / "V2C5" headings, standalone "Volume 2" lines, or folder names like `Volume 2/`. Editable in the upload preview, chapter editor and bulk "Set volume"; shown as groups in the table of contents.

**Genres**
Admins can create, rename and delete genres under **Admin → 🏷 Genres** (comma-separate to add several), or type a new genre straight into the novel editor. Changes show up site-wide immediately.

**Novels included with updates**
Novels in `content/novels/<name>/` (a `novel.json` with metadata and chapters, plus an optional `cover.png`) are published automatically when the site starts, so installing an update is enough to add them. Later versions only add new chapter numbers. Edits made on the site are kept, and deleted novels are not re-imported. The list is shown under Update & backup.

All uploaded HTML is sanitized, so scripts and event handlers are stripped. Forms are CSRF-protected.

## Run it on your computer

```bash
cd novel-site
npm install
npm run seed     # optional: 3 demo novels so you can see the layout
npm start
```

- Site: http://localhost:3000
- Admin: http://localhost:3000/admin (the first visit creates your owner account)

## Put it online on Hetzner (no command line needed)

1. In the Hetzner Cloud console, click **Add Server**.
   - **Location:** Germany (Falkenstein or Nuremberg) for worldwide readers
   - **Image:** Ubuntu 24.04
   - **Type:** the cheapest shared x86 plan with about 4 GB of RAM is plenty
   - **Networking:** keep public IPv4 on
2. Open **Cloud config** and paste the contents of [`deploy/hetzner-cloud-config.yaml`](deploy/hetzner-cloud-config.yaml). If you have a domain, replace `yourdomain.com` in it first.
3. Click **Create & Buy now** and wait about 5 minutes.
4. Open `http://<server IP>/admin` (or `https://yourdomain.com/admin` once your domain's A record points to the server IP) and create your owner account.

The install log is at `/var/log/novel-site-install.log` on the server if anything goes wrong.

## Put it online (VPS such as Contabo, Ubuntu 22.04/24.04)

1. At your domain registrar (or Cloudflare), add an **A record** for `yourdomain.com` pointing to the VPS IP address. Also add one for `www` if you want it.
2. SSH into the VPS and run:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/fenzsly/travelers-rest-site/main/novel-site/deploy/install.sh | sudo bash -s -- yourdomain.com
   ```
   If the repository is private, clone it first and run `sudo bash novel-site/deploy/install.sh yourdomain.com` from the clone. Set `REPO=<clone URL>` so updates can pull from it.
3. Open `https://yourdomain.com/admin` and create your owner account.

The script installs Node 22 and Caddy (automatic HTTPS), runs the site as a `novel-site` systemd service, opens the firewall for web traffic, and keeps 14 days of nightly backups in `/var/lib/novel-site/backups`.

- **Update after new code is pushed:** `sudo bash /opt/novel-site/repo/novel-site/deploy/update.sh`
- **Logs:** `journalctl -u novel-site -f`
- **Your data:** `/var/lib/novel-site` (`site.db` plus `uploads/`)

**Cloudflare (recommended):** set the DNS record to "Proxied" and SSL mode to **Full (strict)**. Covers and assets are then cached near readers worldwide.

Docker is also supported: `docker build -t novel-site . && docker run -p 3000:3000 -v novel-data:/data novel-site`.

## Configuration (environment variables, all optional)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Public site port |
| `ADMIN_PORT` | unset | If set, the admin panel runs **only** on this separate port instead of `/admin` (e.g. to keep it off the internet and reach it over an SSH tunnel) |
| `ADMIN_URL` | unset | With `ADMIN_PORT`: where the "Admin" button on the public site points |
| `PUBLIC_URL` | `http://localhost:PORT` | With `ADMIN_PORT`: public site address used for "View" links |
| `DATA_DIR` | `./data` | Database and session secret |
| `UPLOAD_DIR` | `./uploads` | Cover images |
| `COOKIE_SECURE` | unset | `1` when served over HTTPS |
| `TRUST_PROXY` | unset | `1` behind Caddy, nginx or Cloudflare |
| `SESSION_SECRET` | auto-generated | Cookie signing key |

## Tips for uploading

- Name files so they sort naturally (`001.txt`, `002.txt`, or `Chapter 12 - Title.docx`).
- In text files, leave a blank line between paragraphs. `***` on its own line becomes a scene break.
- A first line like `Chapter 12: The Gate` becomes the chapter number and title, and is removed from the body.
- If headings in a big file look unusual, open "Advanced" on the upload page and give a pattern, e.g. `^Episode \d+`.

## Tests

```bash
npm test
```
