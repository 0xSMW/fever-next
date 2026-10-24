"use client";
import { createContext, useContext, useId, useRef, type ReactNode } from "react";
import type { HelpTopic } from "./HelpTip";
export interface TabSpec<T extends string = string> { id: T; label: string; invalid?: boolean; help?: HelpTopic; }

export function tabId(base: string, tab: string) { return `${base}-tab-${tab}`; }
export function panelId(base: string, tab: string) { return `${base}-panel-${tab}`; }

const TabBaseContext = createContext("fm");

export function TabList<T extends string>({ tabs, active, onChange }: { tabs: readonly TabSpec<T>[]; active: T; onChange: (tab: T) => void }) {
  const base = useContext(TabBaseContext);
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const move = (index: number) => {
    const next = tabs[(index + tabs.length) % tabs.length];
    onChange(next.id);
    refs.current[next.id]?.focus();
  };
  return (
    <div className="fm-tabs" role="tablist" aria-label="Sections">
      {tabs.map((tab, index) => (
        <button
          key={tab.id}
          ref={(node) => { refs.current[tab.id] = node; }}
          type="button"
          role="tab"
          id={tabId(base, tab.id)}
          aria-controls={panelId(base, tab.id)}
          aria-selected={tab.id === active}
          tabIndex={tab.id === active ? 0 : -1}
          className={`fm-tab${tab.id === active ? " fm-tab-active" : ""}${tab.invalid ? " fm-tab-invalid" : ""}`}
          onClick={() => onChange(tab.id)}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight") { event.preventDefault(); move(index + 1); }
            else if (event.key === "ArrowLeft") { event.preventDefault(); move(index - 1); }
            else if (event.key === "Home") { event.preventDefault(); move(0); }
            else if (event.key === "End") { event.preventDefault(); move(tabs.length - 1); }
          }}
        >
          {tab.label}
          {tab.invalid && <span className="fm-tab-flag" aria-label="(has errors)">!</span>}
        </button>
      ))}
    </div>
  );
}

/** Wrap a tabbed form so its tab and panel IDs are unique on the page. */
export function TabScope({ children }: { children: ReactNode }) {
  const base = useId().replace(/:/g, "");
  return <TabBaseContext.Provider value={base}>{children}</TabBaseContext.Provider>;
}

/** Inactive panels stay mounted (hidden) so their values survive tab switches. */
export function TabPanel({ tab, active, children }: { tab: string; active: boolean; children: ReactNode }) {
  const base = useContext(TabBaseContext);
  return (
    <div role="tabpanel" id={panelId(base, tab)} aria-labelledby={tabId(base, tab)} hidden={!active} className="fm-panel">
      {children}
    </div>
  );
}

