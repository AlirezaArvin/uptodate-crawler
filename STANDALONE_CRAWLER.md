# Standalone article crawler

This crawler runs directly on your computer. It does not use Codex or model
tokens. It uses a normal visible browser for the first login, stores that login
in a private local browser profile, writes a checkpoint after every article,
and resumes automatically after interruption.

Use it only with an account and content you are authorized to access, and keep
the request delay compatible with the site's terms and access rules.

## One-time setup

Install Node.js 20 or newer, open PowerShell in this directory, and run:

```powershell
npm install
```

The crawler first tries installed Google Chrome, then Microsoft Edge, then
Playwright Chromium. If none is available, install Playwright Chromium:

```powershell
npx playwright install chromium
```

## First login

For Anaphylaxis (directory 683), run:

```powershell
node .\crawl_uptodate_articles.mjs --directory-id 683 --login-only
```

A browser opens. Sign in to MediLib, return to PowerShell, and press Enter. The
session is kept in `.medilib-browser-profile`. Treat that directory as a
password-equivalent secret: do not share, upload, or commit it.

## Crawl Anaphylaxis

```powershell
node .\crawl_uptodate_articles.mjs --directory-id 683 --output-dir .\anaphylaxis_articles_standalone
```

The output directory contains one self-contained JSON file per article and a
small manifest:

```text
anaphylaxis_articles_standalone/
├── manifest.json
└── articles/
    ├── 384.json
    ├── 385.json
    └── ...
```

Each article file is written atomically and is also its own checkpoint. The
manifest contains progress, aggregate statistics, failures, and a lightweight
index—never article bodies. If the run is stopped, run the exact same command
again; completed article files are detected and skipped. A stale manifest is
automatically reconciled with files already present in `articles/`.

After the first successful login, unattended/headless operation is available:

```powershell
node .\crawl_uptodate_articles.mjs --directory-id 683 --output-dir .\anaphylaxis_articles_standalone --headless
```

## Select other content

Preview targets without opening the browser:

```powershell
node .\crawl_uptodate_articles.mjs --directory-id 683 --list-targets
```

Crawl a directory recursively:

```powershell
node .\crawl_uptodate_articles.mjs --directory-id 716 --output-dir .\directory_716
```

Crawl only articles directly linked by a directory:

```powershell
node .\crawl_uptodate_articles.mjs --directory-id 683 --direct-only --output-dir .\directory_683_direct
```

Crawl selected article IDs:

```powershell
node .\crawl_uptodate_articles.mjs --article-id 13529 --article-id 393 --output-dir .\selected_articles
```

Crawl every unique article in the graph (a long-running operation):

```powershell
node .\crawl_uptodate_articles.mjs --all --output-dir .\all_uptodate_articles --headless
```

Use Ctrl+C once to stop safely after the current page. The default delay is
1.5 seconds, concurrency is deliberately one page at a time, and failed pages
remain recorded for retry on the next run. The lightweight manifest is updated
after every 100 successful articles by default; change this with
`--checkpoint-every N`. Article files are always saved immediately.

Run `node .\crawl_uptodate_articles.mjs --help` for all options.
