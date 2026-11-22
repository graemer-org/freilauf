# Project website

The website lives in [`site/`](../site): one hand-written page (`index.html`, `style.css`), a
self-contained `404.html`, `favicon.svg`, images in `site/assets/` and an empty `.nojekyll`
(so GitHub Pages serves the files as they are, without Jekyll). There is no build step and the
page loads nothing from other hosts. All URLs inside the site are relative, so it works at
`https://graemer-org.github.io/freilauf/` as well as at a domain root. The Open Graph image
and the 404 page's "home" link use absolute URLs, because they must.

To preview it locally:

```sh
python3 -m http.server -d site 8000     # then open http://localhost:8000/
```

## Publishing to GitHub Pages

GitHub Pages has two sources (_Settings → Pages → Build and deployment → Source_):

- **Deploy from a branch** — serves either the root (`/`) or `/docs` of one branch. Nothing
  else: a folder called `site/` cannot be selected.
- **GitHub Actions** — a workflow uploads any folder. This repository's Actions minutes are
  currently used up, so no Pages workflow is committed (see the optional workflow below).

Options for publishing `site/` without a build under those constraints:

| Option                                               | Effort                 | Downside                                                                                                                      |
| ---------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **A. A `gh-pages` branch with the site at its root** | One command per update | The live site is only as new as the last push to `gh-pages`                                                                   |
| B. Move the site to `/docs` on `main`                | Once                   | `/docs` already holds the Markdown documentation; Pages would serve it too (and run Jekyll on it unless `.nojekyll` is there) |
| C. Serve the repository root and link to `site/`     | None                   | The URL becomes `…/freilauf/site/`, and the whole repository is published                                                     |

**Recommendation: A**, a `gh-pages` branch made from `site/` with `git subtree split`. The site
stays in `site/` next to the code, the docs stay Markdown, and publishing is explicit.

### First publish

From a clean checkout of `main` (the site must be committed there):

```sh
git subtree split --prefix site -b gh-pages     # branch whose root is the content of site/
git push origin gh-pages
```

Then on GitHub: _Settings → Pages → Source: Deploy from a branch → Branch: `gh-pages`, folder
`/ (root)` → Save_. After a minute or two the site is at
<https://graemer-org.github.io/freilauf/>.

### Updating

After the site changed on `main`:

```sh
git checkout main && git pull
git subtree split --prefix site -b gh-pages-new
git push --force origin gh-pages-new:gh-pages
git branch -D gh-pages-new
```

`git subtree split` produces the same commits for the same history, so the push is usually a
fast-forward; `--force` only matters if `gh-pages` was ever edited by hand. Do not edit
`gh-pages` directly — it is generated.

If `git subtree` is not installed (it ships in git's `contrib`, and some distributions package
it separately), a worktree does the same:

```sh
git worktree add --orphan -B gh-pages ../freilauf-pages   # first time only (git ≥ 2.42)
# later: git worktree add ../freilauf-pages gh-pages
rsync -a --delete --exclude .git site/ ../freilauf-pages/
cd ../freilauf-pages && git add -A && git commit -m "Publish site" && git push origin gh-pages
cd - && git worktree remove ../freilauf-pages
```

### Things to check (not verified here)

- **Pages on a private repository** needs a paid plan (GitHub Pro, Team or Enterprise); on a
  public repository it is free.
- **Branch deployments also run as a job.** With "Deploy from a branch", GitHub runs its own
  `pages build and deployment` workflow. Whether that job counts against the repository's
  Actions minutes, and whether it still runs once the minutes are used up, is not documented
  clearly enough to state here — check _Settings → Billing_ (or the organisation's billing
  page) and the _Actions_ tab after the first push to `gh-pages`. If it is blocked, the site
  is simply not updated until minutes are available again.
- After the first publish, open the site and check that the images and the 404 page load
  (any missing path, e.g. `…/freilauf/nope`).

### Optional workflow, for when minutes are available

Not committed on purpose. Saved as `.github/workflows/pages.yml`, with _Settings → Pages →
Source: GitHub Actions_, it would publish `site/` on every push to `main` that touches it (and
replace the `gh-pages` branch):

```yaml
name: Pages

on:
  push:
    branches: [main]
    paths: ['site/**']
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: site
      - id: deployment
        uses: actions/deploy-pages@v4
```

## Editing the site

- Keep it dependency-free: no frameworks, fonts, scripts or analytics from other hosts.
- Colours are CSS custom properties at the top of `style.css`, with a dark set under
  `prefers-color-scheme: dark`; the accent matches the app.
- Images: WebP, at most about 1280 px wide, with `width`/`height` and `loading="lazy"` below
  the fold. The whole site should stay well under 600 kB.
- Every claim on the page must be true of the repository; the status section in particular
  mirrors the [README](../README.md#status). Product names only to state compatibility, with
  the disclaimer.
