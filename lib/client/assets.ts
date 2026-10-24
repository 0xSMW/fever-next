import { BASE_PATH } from "./api";

/**
 * Original Fever artwork copied by the manager to public/fever/. CSS cannot
 * prefix a base path, so the layout publishes one custom property per image
 * (e.g. --d-bg-box) and swaps in the @2x file on high-density screens.
 */
const DEFAULT_IMAGES: Array<[name: string, ext: string, retina: boolean]> = [
  ["bg", "png", false], ["bg-box", "png", true], ["bg-box-content-0", "png", true],
  ["bg-box-content-1", "png", true], ["bg-box-content-2", "png", true], ["bg-box-list", "png", true],
  ["bg-box-list-top", "png", true], ["bg-box-list-bottom", "png", true], ["bg-favicon", "png", true],
  ["icon-favicon", "png", true], ["icon-favicon-locked", "png", true], ["icon-hot", "png", true],
  ["icon-kindling", "png", true], ["icon-saved", "png", true], ["icon-spark", "png", true],
  ["icon-search", "png", true], ["icon-unread", "png", true], ["icon-trash", "png", true],
  ["bg-search", "png", true], ["bg-blacklist", "png", true], ["bg-state", "png", true],
  ["bg-mercury", "gif", true], ["bg-thermometer", "png", true], ["bg-temperature", "png", true],
  ["bg-alpha", "png", true], ["spinner", "gif", true], ["bg-status", "png", true],
  ["bg-notice", "png", true], ["bg-error", "png", true], ["btn-text", "png", true],
  ["btn-help", "png", true], ["btn-refresh", "png", true], ["btn-cancel", "png", true],
  ["btn-add", "png", true], ["btn-menu-text", "png", true], ["btn-menu-action", "png", true],
  ["btn-menu-group", "png", true], ["btn-menu-feed", "png", true], ["btn-menu-item", "png", true],
  ["icon-check", "png", true], ["icon-shift", "png", true], ["bg-help", "png", true],
  ["bg-dialog-screen", "png", false], ["bg-dialog", "png", true], ["bg-form-divider", "png", true],
  ["bg-dialog-form", "gif", true],
];
const MOBILE_IMAGES: Array<[name: string, ext: string, retina: boolean]> = [
  ["bg-row", "gif", true], ["bg-btn", "gif", true], ["icon-back", "png", true],
  ["icon-forward", "png", true], ["icon-menu", "png", true], ["spinner", "gif", true],
  ["spinner-dark", "gif", true], ["icon-action", "png", true], ["icon-safari", "png", true],
  ["logo", "png", true], ["logo-spinner", "gif", true], ["icon-unread", "png", true],
  ["icon-hot", "png", true], ["icon-kindling", "png", true], ["icon-saved", "png", true],
  ["icon-sparks", "png", true], ["icon-search", "png", true], ["icon-group", "png", true],
  ["icon-feed", "png", true], ["txt-tmp", "gif", true], ["bg-temperature", "gif", true],
  ["bg-temperature-landscape", "gif", true], ["icon-favicon", "png", true], ["bg-state", "png", true],
  ["bg-form", "png", true], ["form-close", "png", true], ["form-checkbox", "png", true],
];
const APP_IMAGES: Array<[name: string, ext: string, retina: boolean]> = [["logo-fever", "png", true]];

const ROOTS = {
  d: "/fever/default/styles/images/",
  m: "/fever/mobile/styles/images/",
  i: "/fever/images/",
} as const;

function cssUrl(path: string): string {
  return `url("${(BASE_PATH + path).replace(/["\\\n\r]/g, "")}")`;
}

export function assetPath(path: string): string {
  return `${BASE_PATH}${path}`;
}
export const LOGO_SRC = assetPath("/fever/images/logo-fever.png");
export const LOGO_SRC_2X = assetPath("/fever/images/logo-fever@2x.png");
export const SPINNER_SRC = assetPath("/fever/default/styles/images/spinner.gif");

/**
 * Operator stylesheets (PHP override_link: override.css, override-mobile.css).
 * Fixed same-origin files under public/, linked only when FEVER_CUSTOM_CSS=1.
 * See docs/CUSTOM_STYLES.md.
 */
export const CUSTOM_CSS_DEFAULT = assetPath("/fever/overrides/default.css");
export const CUSTOM_CSS_MOBILE = assetPath("/fever/overrides/mobile.css");

/** The :root rule embedded by app/layout.tsx. Static input; no user data. */
export function assetCssVariables(): string {
  const normal: string[] = [];
  const retina: string[] = [];
  const add = (prefix: keyof typeof ROOTS, list: Array<[string, string, boolean]>) => {
    for (const [name, ext, hasRetina] of list) {
      const variable = `--${prefix}-${name}`;
      normal.push(`${variable}:${cssUrl(`${ROOTS[prefix]}${name}.${ext}`)}`);
      if (hasRetina) retina.push(`${variable}:${cssUrl(`${ROOTS[prefix]}${name}@2x.${ext}`)}`);
    }
  };
  add("d", DEFAULT_IMAGES);
  add("m", MOBILE_IMAGES);
  add("i", APP_IMAGES);
  return `:root{${normal.join(";")}}@media (-webkit-min-device-pixel-ratio:2),(min-resolution:192dpi){:root{${retina.join(";")}}}`;
}
