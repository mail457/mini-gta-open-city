# Publishing MINI GTA — OPEN CITY on the web (HTTPS)

> **Current live site:** <https://mini-gta-open-city.onrender.com> — Render static site, deployed from the
> `render-build` branch of <https://github.com/mail457/mini-gta-open-city>. Render credentials are kept in
> `~/.config/mini-gta/render.env` (never committed). Free static sites sleep after inactivity: the first
> visit can take 30–60 s, later loads are instant. The options below remain as alternatives.

The production build in `dist/` is a **plain static site**: HTML + JS + CSS, no server logic,
no accounts, no database. Anything that serves files over HTTPS will host it.

Vite is configured with `base: './'`, so the same `dist/` works at a domain root
(`https://example.com/`) **or** in any sub-folder (`https://example.com/games/mini-gta/`).

Build first:

```bash
cd /Users/axel/code/mini-gta
npm install
npm run build          # -> dist/
npm run package        # -> release/MINI-GTA-OPEN-CITY-v1.0.0.zip (dist + docs)
```

Pick one of the options below.

---

## Option A — GitHub Pages (free, permanent HTTPS URL)

```bash
cd /Users/axel/code/mini-gta
gh auth login                     # once, if not already logged in
gh repo create mini-gta-open-city --public --source=. --remote=origin --push

# Publish the production build to a gh-pages branch (no extra tools needed):
git subtree push --prefix dist origin gh-pages
#   (alternative, faster rebuilds:)
#   npx gh-pages -d dist

# Turn on Pages for the gh-pages branch:
gh api -X POST repos/{owner}/mini-gta-open-city/pages \
  -f 'source[branch]=gh-pages' -f 'source[path]=/'
gh api repos/{owner}/mini-gta-open-city/pages --jq .html_url
```

The site is live at `https://<your-github-username>.github.io/mini-gta-open-city/`
(first build takes 1–2 minutes). Add it to the repo's **About → Website** field.

> A GitHub Actions workflow is included at `.github/workflows/deploy.yml`: if you push the
> repository to GitHub and choose **Settings → Pages → Source: GitHub Actions**, every push
> to `main` rebuilds and deploys automatically — no manual `gh-pages` push needed.

---

## Option B — Netlify drop (no CLI, ~30 seconds)

1. Open <https://app.netlify.com/drop>.
2. Drag the **`dist` folder** (not the ZIP, not the repo) onto the page.
3. Netlify returns an HTTPS URL like `https://quirky-otter-1234.netlify.app`.
4. Optional: **Site settings → Change site name** to get a nicer URL.

Later updates: drag the new `dist` folder onto the same site (`Deploys → Drag and drop`).

---

## Option C — Cloudflare Pages

```bash
npx wrangler pages deploy dist --project-name mini-gta-open-city
```
URL: `https://mini-gta-open-city.pages.dev`.

---

## Option D — Vercel

```bash
npx vercel deploy dist --prod
```
(or connect the repo and set **Output Directory** to `dist`, framework preset **Vite**).

---

## Option E — itch.io (HTML5 game)

1. `npm run package`, then upload `release/MINI-GTA-OPEN-CITY-v1.0.0.zip`? **No** — for itch, zip the
   *contents* of `dist/` so `index.html` sits at the ZIP root:
   ```bash
   cd dist && zip -r ../release/mini-gta-itch.zip . && cd ..
   ```
2. On itch.io: **Create new project → Kind of project: HTML → Uploads**, upload the ZIP,
   tick **“This file will be played in the browser”**, set the viewport to **1280 × 720**,
   then **Save & view page**.

---

## Option F — Any static host / your own server

Copy the contents of `dist/` to any web root, e.g.

```bash
rsync -av dist/ user@server:/var/www/mini-gta/
```

Serve it over HTTPS. No special headers or rewrites are required (it is a single page).

---

## Local check before you publish

```bash
npm run build && npm run preview     # http://127.0.0.1:4173
```

Open the URL, press **PLAY**, and run the manual checklist in
[docs/QA_MANUAL_CHECKLIST.md](QA_MANUAL_CHECKLIST.md).

## After publishing — verify the live URL

1. Open the HTTPS URL in Chrome and in Safari on the Mac.
2. Press PLAY → the city renders and the HUD appears within a couple of seconds.
3. Walk with W, enter the car with E, drive, complete the mission.
4. Check the browser console for errors (View → Developer → JavaScript Console in Safari).
