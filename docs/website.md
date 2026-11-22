# The project website

The website is published with GitHub Pages straight from the `docs/` folder of the `main` branch
(_Settings → Pages → Deploy from a branch → `main` / `/docs`_). There is no build step.

- `docs/index.html`, `docs/style.css` — the page, hand-written, no framework, no external requests.
- `docs/404.html` — self-contained (inline styles, absolute links) so it works at any path depth.
- `docs/favicon.svg`, `docs/assets/site/` — the mark and the page's images (WebP) plus `og.png`.
- `docs/.nojekyll` — tells Pages to serve the folder as it is, without running Jekyll.

The Markdown documentation lives in the same folder. GitHub renders it in the repository view;
on the website the `.md` files are served as plain text, so the page links to the docs on
GitHub rather than to the files next to it.

The site is expected at <https://graemer-org.github.io/freilauf/>. All asset URLs are relative,
so it also works from another sub-path or a custom domain; only the Open Graph image URL is
absolute and must be changed if the address changes.

## Changing the site

Edit the files and merge to `main`; Pages redeploys on its own. To preview locally:

```bash
python3 -m http.server --directory docs 8000
```

Then open <http://localhost:8000/>.

## Things to check in the repository settings

- Pages on a private repository needs a paid GitHub plan.
- A branch deployment runs as a GitHub-managed job. Whether it counts against the Actions
  minutes of a private repository, or is held back while they are used up, is shown under
  _Settings → Billing_; it has not been verified for this repository.
