# Fever homepage recreation

A static copy of the original Fever marketing homepage, rebuilt from the Wayback Machine capture at https://web.archive.org/web/20230701094819/https://feedafever.com/. It uses plain HTML, CSS and JavaScript with no build step and no framework.

## Viewing

Open `index.html` in a browser, or serve the folder from the repository root:

```sh
python3 -m http.server 4173 --directory website
```

Then visit http://localhost:4173/.

## Sources

The text, layout, colors and Helvetica typography come from the archived page and its stylesheets (`reset.css`, `shared.css`, `home.css`). Images in `assets/` were downloaded from the same archive and are Shaun Inman's original artwork. All styles, scripts, images and video are local; rendering does not depend on remote services. Links to Fluid.app, Shaun Inman, Mint and Media Temple keep their original targets, and "More answers", "API Public Beta" and "Forgot?" point to archived copies.

Left out on purpose: the 2016 notice about sales and support ending, the archive toolbar, analytics, and the QuickTime plugin scripts.

## Limitations

There is no backend. The Create an Account, Login and Contact forms check their input in the browser, then stop and print a message saying nothing was sent. The page sends no data and stores no passwords. It clears password fields after each attempt. Without JavaScript the submit buttons stay disabled.

The original 5-minute-19-second demo is included as `assets/screencast.mp4`, with native browser controls and no preload. It was recovered from the [archived desktop screencast](https://web.archive.org/web/20160506235850id_/http://feedafever.com/screencast/screencast-desktop.m4v) referenced by the original QuickTime movie and remuxed to MP4 without re-encoding the H.264 video or AAC audio. If a browser cannot play it, an inline message reports the failure.
