"use client";

import { useId, useState } from "react";
import { command, resetSession } from "@/lib/client/api";
import {
  ErrorBanner, Footer, Frame, RadioGroup, StatusBanner, TextField, fieldError, localError, useAction, usePanel,
} from "./shared";
import { MAINTENANCE_OPERATIONS, type MaintenanceOperation } from "./types";

/**
 * Fever keeps an encrypted recovery snapshot before every operation, but only
 * the server operator can restore one; nothing in the browser undoes these.
 */
const OPERATOR_RECOVERY = "You cannot undo this from Fever. Fever keeps an encrypted recovery snapshot of the affected data, and only whoever runs this server can restore it.";

export const MAINTENANCE_COPY: Record<MaintenanceOperation, {
  title: string; label: string; description: string; saved: string; recovery: string; exportFirst: boolean;
}> = {
  empty: {
    title: "Empty",
    label: "Empty: unsubscribe from everything",
    description: "Unsubscribes from all feeds and deletes all groups, items and Hot links. Your preferences and login are kept.",
    saved: "Every saved item is deleted, and the public saved items feed becomes empty.",
    recovery: OPERATOR_RECOVERY,
    exportFirst: true,
  },
  flush: {
    title: "Flush",
    label: "Flush: delete unsaved items and cached data",
    description: "Deletes unsaved items, Hot links, favicons and the details Fever fetched from each feed. Your groups, feeds, their settings and preferences are kept, and feeds fill up again on their next refresh.",
    saved: "Saved items are kept, and “[SURVIVED FLUSH]” is added to the end of each saved item's title.",
    recovery: OPERATOR_RECOVERY,
    exportFirst: false,
  },
  unorphan: {
    title: "Remove orphans",
    label: "Remove orphans: clean up items from deleted feeds",
    description: "Deletes items and links that belong to feeds you are no longer subscribed to. Current subscriptions and their items are not affected.",
    saved: "Saved items from feeds you no longer follow are deleted too. The preview shows how many.",
    recovery: OPERATOR_RECOVERY,
    exportFirst: false,
  },
  uninstall: {
    title: "Uninstall",
    label: "Uninstall: delete all Fever data and lock this installation",
    description: "Deletes your feeds, groups, items, preferences and Fever API access, and signs out every browser and device. The installation then stays locked: Fever keeps a record of the uninstalled installation and its owner, so it cannot be set up again or reactivated from a browser. The application files on the server are not removed.",
    saved: "Every saved item is deleted, and the public saved items feed stops working.",
    recovery: "You cannot undo this from Fever. To use Fever again, whoever runs this server must restore the encrypted recovery snapshot that Fever keeps, or connect Fever to a separately provisioned, empty database.",
    exportFirst: true,
  },
};

const COUNT_LABELS: Record<string, string> = {
  feeds: "Feeds unsubscribed",
  groups: "Groups deleted",
  items: "Items deleted",
  savedItems: "Saved items deleted (included above)",
  retainedSavedItems: "Saved items kept",
  links: "Hot links deleted",
  favicons: "Favicons deleted",
};

interface Preview { token: string; summary: string; counts: Record<string, number>; confirmation: string; }

function readPreview(value: Record<string, unknown>, operation: MaintenanceOperation): Preview {
  const token = typeof value.token === "string" ? value.token : "";
  if (!token) throw new Error("Fever did not return a confirmation token. Try the preview again.");
  const counts = readCounts(value.counts);
  const phrase = [value.confirmation, value.confirmationPhrase].find((entry) => typeof entry === "string" && entry.trim());
  return {
    token,
    summary: typeof value.summary === "string" ? value.summary : "",
    counts,
    confirmation: typeof phrase === "string" ? phrase : operation,
  };
}

function countLabel(key: string): string {
  return COUNT_LABELS[key] ?? key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase();
}

function readCounts(value: unknown): Record<string, number> {
  const counts: Record<string, number> = {};
  if (value && typeof value === "object") {
    for (const [key, count] of Object.entries(value as Record<string, unknown>)) {
      if (typeof count === "number" && Number.isFinite(count)) counts[key] = count;
    }
  }
  return counts;
}

function CountsTable({ counts, caption }: { counts: Record<string, number>; caption: string }) {
  if (Object.keys(counts).length === 0) return null;
  return (
    <table className="fm-table fm-counts">
      <caption className="fm-visually-hidden">{caption}</caption>
      <tbody>
        {Object.entries(counts).map(([key, count]) => (
          <tr key={key}><th scope="row">{countLabel(key)}</th><td>{count.toLocaleString()}</td></tr>
        ))}
      </tbody>
    </table>
  );
}

/** What the operation deletes, what happens to saved items, and who can recover the data. */
function Consequences({ operation }: { operation: MaintenanceOperation }) {
  const copy = MAINTENANCE_COPY[operation];
  return (
    <dl className="fm-impact">
      <dt>Deletes</dt><dd>{copy.description}</dd>
      <dt>Saved items</dt><dd>{copy.saved}</dd>
      <dt>Recovery</dt><dd>{copy.recovery}</dd>
    </dl>
  );
}

function ExportHint({ onExport }: { onExport: () => void }) {
  return (
    <p className="fm-hint">
      <button type="button" className="fm-link" onClick={onExport}>Export your feeds as OPML</button> before you continue.
      OPML holds your subscriptions and groups only. It does not include items, saved items or preferences, so it is not a
      backup of what you have read or saved.
    </p>
  );
}

export function MaintenanceForm({ initialOperation }: { initialOperation?: MaintenanceOperation }) {
  const panel = usePanel();
  const previewAction = useAction();
  const executeAction = useAction();
  const id = useId();
  const [operation, setOperation] = useState<MaintenanceOperation>(initialOperation ?? "flush");
  const [password, setPassword] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [typed, setTyped] = useState("");
  const [finished, setFinished] = useState<{ summary: string; counts: Record<string, number> } | null>(null);
  const copy = MAINTENANCE_COPY[operation];
  const pending = previewAction.pending || executeAction.pending;

  const choose = (next: MaintenanceOperation) => {
    setOperation(next);
    setPreview(null);
    setTyped("");
    previewAction.clearError();
    executeAction.clearError();
  };

  const startOver = () => {
    setPreview(null);
    setTyped("");
    setPassword("");
    executeAction.clearError();
  };

  const runPreview = async () => {
    if (!password) {
      previewAction.setError(localError({ currentPassword: "Enter your current password to continue." }));
      return;
    }
    const result = await previewAction.run(async () => readPreview(await command("maintenance.preview", { operation, currentPassword: password }), operation));
    if (!result.ok) return;
    setPassword("");
    setTyped("");
    setPreview(result.value);
  };

  const runExecute = async () => {
    if (!preview) return;
    if (typed !== preview.confirmation) {
      executeAction.setError(localError({ confirmation: `Type ${preview.confirmation} exactly to confirm.` }));
      return;
    }
    const result = await executeAction.run(() => command("maintenance.execute", { operation, token: preview.token, confirmation: typed }));
    if (!result.ok) {
      // An expired or used token cannot be retried; ask for a fresh preview.
      const code = result.error?.code ?? "";
      if (/TOKEN|EXPIRED|CONFIRM/i.test(code)) setPreview(null);
      return;
    }
    const summary = typeof result.value.summary === "string" && result.value.summary ? result.value.summary : `${copy.title} finished.`;
    setFinished({ summary, counts: readCounts(result.value.counts) });
    setPreview(null);
    if (operation === "uninstall") {
      // Every session, including this one, ended with the installation.
      resetSession();
      return;
    }
    await panel.changed();
  };

  if (finished) {
    return (
      <Frame title={copy.title} size="normal" footer={<Footer cancelLabel="Done" />}>
        <StatusBanner tone="success">{finished.summary}</StatusBanner>
        <CountsTable counts={finished.counts} caption={`What ${copy.title.toLowerCase()} deleted or kept`} />
        {operation === "uninstall" ? (
          <p className="fm-lead">
            Fever&apos;s data has been deleted and you are signed out. This installation is locked and cannot be set up again or
            reactivated from a browser. To use Fever again, whoever runs this server must restore the encrypted recovery
            snapshot or connect Fever to a separately provisioned, empty database.
          </p>
        ) : (
          <p className="fm-hint">{copy.recovery}</p>
        )}
      </Frame>
    );
  }

  return (
    <Frame
      title={preview ? `${copy.title}: confirmation` : "Maintenance"}
      size="normal"
      onSubmit={preview ? runExecute : runPreview}
      busy={pending}
      footer={(
        <Footer
          submitLabel={preview ? copy.title : "Preview"}
          pendingLabel={preview ? "Working…" : "Checking…"}
          pending={pending}
          danger={!!preview}
          disabled={!!preview && typed !== preview.confirmation}
          extra={preview ? <button type="button" className="fm-btn fm-btn-plain" onClick={startOver} disabled={pending}>Start over</button> : undefined}
        />
      )}
    >
      <ErrorBanner error={preview ? executeAction.error : previewAction.error} />
      {!preview ? (
        <>
          <RadioGroup legend="Operation" value={operation} onChange={choose}
            options={MAINTENANCE_OPERATIONS.map((value) => ({ value, label: MAINTENANCE_COPY[value].label }))} />
          <div id={`${id}-description`}><Consequences operation={operation} /></div>
          {copy.exportFirst && <ExportHint onExport={() => panel.navigate({ kind: "export" })} />}
          <TextField label="Current password" type="password" value={password} autoComplete="current-password" data-autofocus=""
            hint="Fever checks your password, then shows exactly what will be deleted. Nothing changes until you confirm."
            onChange={(event) => setPassword(event.currentTarget.value)}
            error={fieldError(previewAction.error, "currentPassword", "password")} />
        </>
      ) : (
        <>
          {/* The server summary adds detail; the local consequences always show, so saved-item and recovery effects are never hidden. */}
          {preview.summary && <StatusBanner tone="warning">{preview.summary}</StatusBanner>}
          <Consequences operation={operation} />
          <CountsTable counts={preview.counts} caption={`What ${copy.title.toLowerCase()} will delete or keep`} />
          <TextField
            label={<>Type <code>{preview.confirmation}</code> to confirm</>}
            value={typed}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            data-autofocus=""
            onChange={(event) => setTyped(event.currentTarget.value)}
            error={fieldError(executeAction.error, "confirmation")}
            hint="This confirmation expires after a short time. Cancel leaves everything unchanged."
          />
        </>
      )}
    </Frame>
  );
}
