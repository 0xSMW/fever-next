"use client";

import { useId, useMemo, useState } from "react";
import { ApiRequestError, SESSION_EXPIRED_EVENT, apiPost, appHref } from "@/lib/client/api";
import type { ApiError, ImportResult, ReaderView } from "@/lib/contracts";
import {
  Checkbox, ErrorBanner, Footer, Frame, MultiSelect, RadioGroup, StatusBanner, plural, useAction, usePanel,
} from "./shared";

const MAX_OPML_BYTES = 5 * 1024 * 1024;

interface OpmlPreview { title: string; feeds: { title: string; url?: string; group?: string; isSpark: boolean }[]; groups: string[]; warnings: string[]; }

/* ------------------------------------------------------------------ import */

export function ImportOpml() {
  const panel = usePanel();
  const action = useAction();
  const id = useId();
  const [source, setSource] = useState<"file" | "paste">("file");
  const [file, setFile] = useState<File | null>(null);
  const [pasted, setPasted] = useState("");
  const [importGroups, setImportGroups] = useState(true);
  const [previewed, setPreviewed] = useState<{ value: OpmlPreview; inputs: readonly unknown[] } | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  // A preview describes one exact file and group choice; it hides once any of them changes.
  const inputs = [source, file, pasted, importGroups] as const;
  const preview = previewed && previewed.inputs.every((value, index) => value === inputs[index]) ? previewed.value : null;

  const readXml = async (): Promise<string> => {
    if (source === "file") {
      if (!file) throw new ApiRequestError("Choose an OPML file to import.", 400, "INVALID_REQUEST", { file: "Choose an OPML file." });
      if (file.size > MAX_OPML_BYTES) throw new ApiRequestError("The OPML file exceeds 5 MiB.", 413, "OPML_TOO_LARGE", { file: "Choose a file smaller than 5 MiB." });
      return file.text();
    }
    if (!pasted.trim()) throw new ApiRequestError("Paste the OPML document to import.", 400, "INVALID_REQUEST", { xml: "Paste an OPML document." });
    if (new Blob([pasted]).size > MAX_OPML_BYTES) throw new ApiRequestError("The OPML document exceeds 5 MiB.", 413, "OPML_TOO_LARGE", { xml: "Paste less than 5 MiB." });
    return pasted;
  };

  const runPreview = async () => {
    const outcome = await action.run(async () => apiPost<OpmlPreview>("/api/opml/import", { xml: await readXml(), importGroups, preview: true }));
    // `inputs` is this render's choice, so a change made while the request ran leaves the preview hidden.
    if (outcome.ok) setPreviewed({ value: outcome.value, inputs });
  };

  const submit = async () => {
    const outcome = await action.run(async () => apiPost<ImportResult>("/api/opml/import", { xml: await readXml(), importGroups }));
    if (!outcome.ok) return;
    setResult(outcome.value);
    await panel.changed();
  };

  if (result) {
    return (
      <Frame title="Import feeds from OPML" size="normal" footer={<Footer cancelLabel="Done" />}>
        <StatusBanner tone={result.warnings.length ? "warning" : "success"}>
          Import finished. New feeds are being refreshed in the background.
        </StatusBanner>
        <dl className="fm-impact">
          <dt>Feeds added</dt><dd>{result.feedsAdded.toLocaleString()}</dd>
          <dt>Groups added</dt><dd>{result.groupsAdded.toLocaleString()}</dd>
          <dt>Memberships</dt><dd>{result.membershipsAdded.toLocaleString()} added</dd>
          <dt>Skipped</dt><dd>{result.skipped.toLocaleString()} {result.skipped ? "(already subscribed or not importable)" : ""}</dd>
        </dl>
        {result.warnings.length > 0 && (
          <div className="fm-warnings">
            <h3>Warnings</h3>
            <ul>{result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
          </div>
        )}
      </Frame>
    );
  }

  const fileError = action.error?.fields.file;
  const xmlError = action.error?.fields.xml;

  return (
    <Frame title="Import feeds from OPML" size="normal" onSubmit={submit} busy={action.pending}
      footer={(
        <Footer submitLabel="Import" pendingLabel="Importing…" pending={action.pending}
          extra={(
            <button type="button" className="fm-btn fm-btn-plain" onClick={runPreview} disabled={action.pending}>Preview</button>
          )} />
      )}>
      <ErrorBanner error={action.error} />
      <p className="fm-hint fm-panel-intro">Most feed readers can export your subscriptions as an OPML file. Feeds you already follow are skipped.</p>
      <RadioGroup legend="Source" value={source} onChange={setSource}
        options={[{ value: "file", label: "OPML file" }, { value: "paste", label: "paste OPML" }]} />
      {source === "file" ? (
        <div className={`fm-row${fileError ? " fm-row-invalid" : ""}`}>
          <div className="fm-row-label"><label htmlFor={`${id}-file`}>File</label></div>
          <div className="fm-row-control">
            <input id={`${id}-file`} type="file" className="fm-file" accept=".opml,.xml,text/x-opml,text/xml,application/xml"
              aria-invalid={fileError ? true : undefined} aria-describedby={fileError ? `${id}-file-error` : undefined} data-autofocus=""
              onChange={(event) => setFile(event.currentTarget.files?.[0] ?? null)} />
            {file && <p className="fm-hint">{file.name} ({Math.max(1, Math.round(file.size / 1024)).toLocaleString()} KB)</p>}
            {fileError && <p className="fm-field-error" id={`${id}-file-error`}>{fileError}</p>}
          </div>
        </div>
      ) : (
        <div className={`fm-row${xmlError ? " fm-row-invalid" : ""}`}>
          <div className="fm-row-label"><label htmlFor={`${id}-xml`}>OPML</label></div>
          <div className="fm-row-control">
            <textarea id={`${id}-xml`} className="fm-input fm-textarea" rows={8} spellCheck={false} value={pasted}
              placeholder={'<opml version="1.0">…</opml>'} data-autofocus=""
              aria-invalid={xmlError ? true : undefined} aria-describedby={xmlError ? `${id}-xml-error` : undefined}
              onChange={(event) => setPasted(event.currentTarget.value)} />
            {xmlError && <p className="fm-field-error" id={`${id}-xml-error`}>{xmlError}</p>}
          </div>
        </div>
      )}
      <Checkbox label="import groups" checked={importGroups} onChange={setImportGroups}
        hint={importGroups
          ? "Folders in the file become Fever groups. A folder named Sparks becomes Sparks."
          : "All new feeds go into one group named after the file's title, followed by “(imported)”."} />
      {preview && (
        <div className="fm-preview" aria-live="polite">
          <StatusBanner>
            {preview.title ? <><strong>{preview.title}</strong>: </> : null}
            {plural(preview.feeds.length, "feed")}
            {preview.feeds.some((feed) => feed.isSpark) ? `, ${plural(preview.feeds.filter((feed) => feed.isSpark).length, "Spark")}` : ""}
            {preview.groups.length ? ` in ${plural(preview.groups.length, "group")}: ${preview.groups.slice(0, 8).join(", ")}${preview.groups.length > 8 ? "…" : ""}` : ", no groups"}.
          </StatusBanner>
          {preview.warnings.length > 0 && <ul className="fm-warnings">{preview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
        </div>
      )}
    </Frame>
  );
}

/* ------------------------------------------------------------------ export */

function filenameFrom(disposition: string | null): string {
  const match = disposition?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  if (!match) return "fever.opml";
  try { return decodeURIComponent(match[1]); } catch { return match[1]; }
}

export function ExportOpml({ view }: { view: ReaderView }) {
  const action = useAction();
  const selectedGroup = view.view.groupId > 0 ? [view.view.groupId] : [];
  const [scope, setScope] = useState<"all" | "selected">("all");
  const [groupIds, setGroupIds] = useState<number[]>(selectedGroup);
  const [flatten, setFlatten] = useState(false);
  const [includeSparks, setIncludeSparks] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const options = useMemo(
    () => view.groups.filter((group) => group.id > 0)
      .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }))
      .map((group) => ({ id: group.id, label: group.title, hint: `(${plural(group.feedIds.length, "feed")})` })),
    [view.groups],
  );
  const sparkCount = view.feeds.filter((feed) => feed.isSpark).length;
  const singleGroup = scope === "selected" && groupIds.length === 1;

  const submit = async () => {
    setDone(null);
    if (scope === "selected" && groupIds.length === 0) {
      action.setError({ message: "Choose at least one group to export.", fields: { groupIds: "Choose at least one group." } });
      return;
    }
    const params = new URLSearchParams();
    if (scope === "selected") params.set("groupIds", groupIds.join(","));
    if (flatten) params.set("flatten", "1");
    if (includeSparks) params.set("includeSparks", "1");
    const query = params.toString();
    const outcome = await action.run(async () => {
      let response: Response;
      try {
        response = await fetch(appHref(`/api/opml/export${query ? `?${query}` : ""}`), {
          method: "GET", credentials: "same-origin", cache: "no-store", redirect: "manual",
          headers: { Accept: "text/x-opml, application/xml, application/json" },
        });
      } catch {
        throw new ApiRequestError("Fever could not be reached. Check your connection and try again.", 0, "NETWORK_ERROR");
      }
      if (response.type === "opaqueredirect" || response.status === 401) {
        window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
        throw new ApiRequestError("Your session has expired. Log in again.", 401, "UNAUTHENTICATED");
      }
      if (!response.ok) {
        let body: Partial<ApiError> = {};
        try { body = (await response.json()) as Partial<ApiError>; } catch { body = {}; }
        throw new ApiRequestError(body.error || "The export could not be created.", response.status, body.code, body.fields);
      }
      const blob = await response.blob();
      const filename = filenameFrom(response.headers.get("content-disposition"));
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = filename;
      anchor.rel = "noopener";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(href), 30_000);
      return filename;
    });
    if (outcome.ok) setDone(`Downloaded ${outcome.value}.`);
  };

  return (
    <Frame title="Export OPML" size="normal" onSubmit={submit} busy={action.pending}
      footer={<Footer submitLabel="Export" pendingLabel="Exporting…" pending={action.pending} cancelLabel={done ? "Done" : "Cancel"} />}>
      <ErrorBanner error={action.error} />
      {done && <StatusBanner tone="success">{done}</StatusBanner>}
      <RadioGroup legend="Groups" value={scope} onChange={setScope}
        options={[{ value: "all", label: "all groups" }, { value: "selected", label: "just the selected groups" }]} />
      {scope === "selected" && (
        <MultiSelect legend="Selected groups" options={options} selected={groupIds} onChange={setGroupIds}
          emptyText="You have no groups. Export all groups instead." error={action.error?.fields.groupIds} />
      )}
      <Checkbox label="flatten groups" checked={flatten || singleGroup} disabled={singleGroup} onChange={setFlatten}
        hint={singleGroup ? "A single group is always exported without folders." : "List every feed once, without group folders."} />
      <Checkbox label="include Sparks" checked={includeSparks} onChange={setIncludeSparks}
        hint={sparkCount ? `Adds your ${plural(sparkCount, "Spark")}${flatten || singleGroup ? "" : " in a Sparks folder"}.` : "You have no Sparks."} />
      <p className="fm-hint">
        OPML holds your subscriptions and groups only. Items, saved items and preferences are not included, so it is not a
        backup of what you have read or saved. The file downloads through your logged-in session; it is not stored on the server.
      </p>
    </Frame>
  );
}
