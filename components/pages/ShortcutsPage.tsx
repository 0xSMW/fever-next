"use client";
import { useReaderData } from "@/lib/client/useReaderData";

import Link from "next/link";
import { Fragment } from "react";
import { appHref } from "@/lib/client/api";
import { COMMANDS, CORE_LETTERS, type CommandDef } from "@/lib/client/commands";
import { PageShell } from "./PageShell";
import { ErrorNotice, Loading } from "./Status";
import { useFeverSession } from "./useFeverSession";

/** Spoken names for registry keys that are symbols. */
const KEY_LABELS: Record<string, string> = {
  "←": "Left arrow", "→": "Right arrow", "↑": "Up arrow", "↓": "Down arrow",
  "/": "Slash", "?": "Question mark", ".": "Period", "⌘": "Command", Esc: "Escape",
};

/** Command groups in the order the reader registry first uses them. */
const COMMAND_GROUPS = [...new Set(COMMANDS.map((command) => command.group))];

function KeyCombo({ keys }: { keys: string[] }) {
  return (
    <span className="fp-nowrap">
      {keys.map((key, index) => (
        <Fragment key={index}>
          {index > 0 ? " + " : null}
          <kbd>
            {KEY_LABELS[key] ? <><span aria-hidden="true">{key}</span><span className="fp-sr-only">{KEY_LABELS[key]}</span></> : key}
          </kbd>
        </Fragment>
      ))}
    </span>
  );
}

function CommandTable({ group }: { group: CommandDef["group"] }) {
  return (
    <table className="fp-shortcuts">
      <caption>{group}</caption>
      <thead>
        <tr><th scope="col">Shortcut</th><th scope="col">Command</th></tr>
      </thead>
      <tbody>
        {COMMANDS.filter((command) => command.group === group).map((command) => (
          <tr key={command.id}>
            <th scope="row">
              {command.keys.map((combo, index) => (
                <Fragment key={index}>
                  {index > 0 ? <span className="fp-or">or</span> : null}
                  <KeyCombo keys={combo} />
                </Fragment>
              ))}
            </th>
            <td>{command.label}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ServiceShortcuts() {
  const { view, error, reload: retryLoad } = useReaderData();
  const services = view?.preferences.services;

  if (error) return <ErrorNotice title="Send-to shortcuts unavailable" error={error} onRetry={retryLoad} />;
  if (!services) return <Loading>Loading your sharing services…</Loading>;
  const withKeys = services.filter((service) => service.key);
  if (!withKeys.length) {
    return <p>No sharing service has a shortcut key. Add keys under Preferences → Sharing.</p>;
  }
  const counts = new Map<string, number>();
  for (const service of withKeys) counts.set(service.key.toLowerCase(), (counts.get(service.key.toLowerCase()) ?? 0) + 1);
  const anyConflict = withKeys.some((service) => CORE_LETTERS.has(service.key.toLowerCase()));

  return (
    <>
      <table className="fp-shortcuts">
        <caption>Send to</caption>
        <thead>
          <tr><th scope="col">Shortcut</th><th scope="col">Service</th></tr>
        </thead>
        <tbody>
          {withKeys.map((service, index) => {
            const key = service.key.toLowerCase();
            const notes: string[] = [];
            if (CORE_LETTERS.has(key)) notes.push(`Also a core command. While an item has focus, ${service.name} takes priority.`);
            if ((counts.get(key) ?? 0) > 1) notes.push("Another service uses the same key; only the first one listed runs.");
            if (service.enabled === false) notes.push(service.reason ? `Disabled: ${service.reason}` : "Disabled.");
            return (
              <tr key={`${service.name}-${index}`}>
                <th scope="row"><kbd>{service.key.toUpperCase()}</kbd></th>
                <td>
                  {service.name}
                  {notes.length ? <span className="fp-hint">{notes.join(" ")}</span> : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {anyConflict ? (
        <p className="fp-small">
          Fever keeps your existing service keys. To give a core command back its key, change the service&rsquo;s key in Preferences → Sharing.
        </p>
      ) : null}
    </>
  );
}

export function ShortcutsPage() {
  const { state, reload } = useFeverSession();
  return (
    <PageShell title="Keyboard Shortcuts" subtitle="Keep your hands on the keys" width="wide" nav>
      <p>
        Shortcuts work in the reader whenever focus is not in a text field. Fever ignores them while you type, while an
        input method is composing text, and when Ctrl, ⌘, or Alt is held, so browser shortcuts keep working.
      </p>
      {COMMAND_GROUPS.map((group) => <CommandTable key={group} group={group} />)}
      <p className="fp-small">
        In a dialog, <kbd>Esc</kbd> or <KeyCombo keys={["Ctrl", "."]} /> (<KeyCombo keys={["⌘", "."]} /> on a Mac) closes it.
      </p>

      {state.status === "loading" ? <Loading>Checking your session…</Loading> : null}
      {state.status === "error" ? <ErrorNotice title="Send-to shortcuts unavailable" error={state.error} onRetry={reload} /> : null}
      {state.status === "ready" && state.session.authenticated ? <ServiceShortcuts /> : null}
      {state.status === "ready" && !state.session.authenticated ? (
        <p>
          <Link className="fp-link" href="/login?return=%2Fshortcuts">Log in</Link> to see the keys for your sharing services.
        </p>
      ) : null}

      <div className="fp-actions">
        <a className="fp-btn fp-default" href={appHref("/")}>Done</a>
      </div>
    </PageShell>
  );
}
