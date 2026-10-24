"use client";
import { useSyncExternalStore } from "react";
import { CUSTOM_CSS_DEFAULT, CUSTOM_CSS_MOBILE } from "@/lib/client/assets";

/**
 * The operator stylesheets, linked after the app styles (PHP override_link).
 * default.css applies to the desktop reader and the standalone pages;
 * mobile.css applies while the reader uses the compact layout
 * (html[data-layout="compact"], set by ReaderApp). Only the active file is
 * linked, so only it is requested.
 *
 * ?overrideCss=off on any page turns both off in this browser until a page
 * is loaded with ?overrideCss=on. The choice is read once per page load.
 */
const PARAM = "overrideCss";
const STORAGE_KEY = "fever.overrideCss";

type Mode = "off" | "default" | "mobile";

let turnedOff: boolean | null = null;
function userTurnedOff(): boolean {
  if (turnedOff === null) {
    const param = new URLSearchParams(window.location.search).get(PARAM);
    let stored: string | null = null;
    try {
      if (param === "off") window.localStorage.setItem(STORAGE_KEY, "off");
      else if (param === "on") window.localStorage.removeItem(STORAGE_KEY);
      stored = window.localStorage.getItem(STORAGE_KEY);
    } catch { /* storage may be disabled; the query parameter still applies to this page */ }
    turnedOff = param === "off" || (param !== "on" && stored === "off");
  }
  return turnedOff;
}

function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-layout"] });
  return () => observer.disconnect();
}
function clientMode(): Mode {
  if (userTurnedOff()) return "off";
  return document.documentElement.dataset.layout === "compact" ? "mobile" : "default";
}
const serverMode = (): Mode => "default";

export function CustomStyles() {
  const mode = useSyncExternalStore(subscribe, clientMode, serverMode);
  if (mode === "off") return null;
  // No precedence prop: React renders the link in place, after the app stylesheets in <head>.
  // The files are operator-edited static files, so they cannot be bundled imports.
  return mode === "mobile"
    ? <link key="mobile" rel="stylesheet" href={CUSTOM_CSS_MOBILE} data-fever-override="mobile" />
    : <link key="default" rel="stylesheet" href={CUSTOM_CSS_DEFAULT} data-fever-override="default" />;
}
