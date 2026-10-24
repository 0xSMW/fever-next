# Custom stylesheets

Fever 1.x let the owner restyle the reader by placing `override.css` (desktop) or `override-mobile.css` (mobile) in the install directory. The original app linked these files after its own stylesheets when they existed.

The Next.js app keeps this as an opt-in operator setting. The files are static, same-origin, and live at fixed paths. Their URLs cannot be changed, and readers cannot supply CSS.

## Turning it on

1. Edit the sample files in the app's `public/` directory:
   - `public/fever/overrides/default.css` for the desktop reader and the standalone pages (login, setup, Feedlet, subscribe, shortcuts, extras, blacklist, updated, diagnostics, maintenance, recovery).
   - `public/fever/overrides/mobile.css` for the compact reader.
2. Set `FEVER_CUSTOM_CSS=1` in the environment. It is a plain on/off value, not a secret. Any other value, or no value, leaves the hook off.
3. Build and deploy. The reader page is prerendered, so it reads `FEVER_CUSTOM_CSS` and the file contents at build time. After changing either one, rebuild and redeploy. On Vercel, set the variable in the project settings and deploy a new build.

With the setting off, no link is rendered and neither file is requested. The samples contain only comments, so turning the setting on without editing them changes nothing and causes no 404.

## Loading order

`app/layout.tsx` renders `components/reader/CustomStyles.tsx` in `<head>` after the bundled app CSS (`app/globals.css`, plus `components/pages/pages.css` and `components/manage/manage.css` where those pages use them) and the `#fever-assets` style element. The order in the document is:

1. Bundled app stylesheets.
2. `<style id="fever-assets">`: the image URL custom properties (`--d-*`, `--m-*`, `--i-*`).
3. One `<link rel="stylesheet" data-fever-override="default|mobile">`.

Because the override comes last, a rule in it wins over an app rule of equal specificity. Use selectors at least as specific as the app rule you are changing. App CSS chunks that load later during client navigation are inserted with the bundled styles, before the override link. `next dev` can order CSS differently from a production build, so check overrides against `next build` output.

Only one file is linked at a time:

| State | File linked |
|---|---|
| Compact reader (`html[data-layout="compact"]`) | `mobile.css` |
| Desktop reader, or a standalone page (no `data-layout`) | `default.css` |
| Turned off with `?overrideCss=off` | none |

The server always renders the `default.css` link. After hydration the browser switches it to `mobile.css` when the reader picks the compact layout, or removes it when the hook is turned off. PHP chose the file by user agent on the server, so standalone pages on a phone used `override-mobile.css`. Here they use `default.css`.

## Turning it off in one browser

If an override hides or breaks the interface, open any page with `overrideCss=off`, for example:

```
https://reader.example.com/login?overrideCss=off
```

If Fever runs under a base path, put it first: `https://example.com/fever/login?overrideCss=off`. The login page works without signing in. The choice is stored in this browser's `localStorage` under `fever.overrideCss`, so the hook stays off on later pages and visits. To turn it back on, load any page with `?overrideCss=on`. The parameter is read once per page load, so type the URL and load it fully; a link followed inside the reader does not re-read it.

This only affects the one browser. To turn the hook off for everyone, unset `FEVER_CUSTOM_CSS` and redeploy.

## Selector mapping from PHP

Most PHP IDs and classes are kept. The body classes moved to the reader's root element, and the compact layout has its own root.

| PHP selector | Next.js selector |
|---|---|
| `body` (desktop reader) | `.fever-desktop` |
| `body.show-feeds` | `.fever-desktop.show-feeds` |
| `body.hot` | `.fever-desktop.hot` |
| `body.fluid` | `.fever-desktop.fluid` |
| `body` while dragging a feed | `.fever-desktop.dragging` |
| `#fever`, `#logo`, `#groups`, `#feeds`, `#content-container`, `#feeds-alpha`, `#refreshing` | unchanged, inside `.fever-desktop` |
| `.box`, `.box-list li`, `.item`, `.link`, `.meta`, `.item-content`, `.source-list` | unchanged, inside `.fever-desktop` |
| `body` (mobile) | `html[data-layout="compact"] body` and `.fever-mobile` |
| `body.landscape` | `@media (orientation: landscape)` |
| `#screens .screen` | `.fever-mobile .screen`, with `.screen-groups`, `.screen-feeds`, `.screen-items`, `.screen-hot`, `.screen-article`, `.screen-webview` |
| `#fever`, `#feeds`, `#items`, `#hot`, `#item`, `#webview` (mobile screens) | unchanged, inside `.fever-mobile` |
| `.header`, `.footer`, `.btn`, `.btn.back`, `ul.list li` (mobile) | unchanged, inside `.fever-mobile`; list rows are `<button>` elements, not `<a>` |
| `body.action #action` (mobile action sheet) | `.fever-mobile.dialog #dialog-container` |
| `#dialog-container`, `#dialog` (desktop dialogs) | `.fever-reader > #dialog-container`; management dialogs use `.fm-overlay`, `.fm-root`, `.fm-dialog` |
| Standalone pages (`page/*.php`) | `.fp-page`, `.fp-frame`, `.fp-box` |

Original images are referenced through custom properties, for example `background-image: var(--d-bg-box)` for `default/styles/images/bg-box.png`. These URLs already include the base path, and the high-density files are used on 2x screens. Images added for an override can go in `public/fever/overrides/` and be referenced with a relative URL such as `url(logo.png)`, which resolves against the stylesheet.
