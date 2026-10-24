"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import type { ReaderView } from "@/lib/contracts";
import { apiGet, appHref, command } from "@/lib/client/api";
import { describeError, isSessionError, type DescribedError } from "./api-errors";
import { PageShell } from "./PageShell";
import { SessionGate } from "./SessionGate";
import { ErrorNotice, Loading, Notice } from "./Status";

/** Same limits and token rules as lib/domain/blacklist.ts. */
const MAX_BYTES = 65_536;
const MAX_RULES = 512;
const DOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i;

function tokens(text: string): string[] {
  return text.split(/[\t\n\r\f\v ]+/).filter((token) => token !== "" && token !== "0");
}

interface RuleIssue { rule: number; raw: string; message: string }

function localIssues(text: string): { issues: RuleIssue[]; summary?: string } {
  if (new TextEncoder().encode(text).length > MAX_BYTES) return { issues: [], summary: "The blacklist is larger than 64 KB. Remove some rules." };
  const list = tokens(text);
  if (list.length > MAX_RULES) return { issues: [], summary: `The blacklist has ${list.length} rules; the limit is ${MAX_RULES}.` };
  const issues: RuleIssue[] = [];
  list.forEach((raw, index) => {
    if (raw.startsWith("domain:")) {
      const domain = raw.slice(7).replace(/\.$/, "");
      if (!domain || domain.length > 253 || !DOMAIN_PATTERN.test(domain) || domain.includes("..")) {
        issues.push({ rule: index + 1, raw, message: "domain: needs a hostname only, without http://, a path, a port, or *." });
      }
    } else if (raw.startsWith("#") && !raw.replace(/#/g, "")) {
      issues.push({ rule: index + 1, raw, message: "This regular expression is empty." });
    }
  });
  return { issues };
}

/** Server message format: "Rule 3: reason; Rule 7: reason". */
function serverIssues(message: string, text: string): RuleIssue[] {
  const list = tokens(text);
  const issues: RuleIssue[] = [];
  for (const part of message.split(/;\s*/)) {
    const match = /^Rule (\d+):\s*(.+)$/.exec(part.trim());
    if (match) issues.push({ rule: Number(match[1]), raw: list[Number(match[1]) - 1] ?? "", message: match[2] });
  }
  return issues;
}

interface SaveResult { ruleCount?: number; matched?: number; scanned?: number }

function BlacklistForm() {
  const id = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [rules, setRules] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<DescribedError | null>(null);
  const [issues, setIssues] = useState<RuleIssue[]>([]);
  const [summary, setSummary] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<DescribedError | null>(null);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<SaveResult | null>(null);

  const fetchRules = useCallback(() => {
    apiGet<ReaderView>("/api/reader?capture=false").then(
      (view) => { setRules(view.preferences?.blacklist ?? ""); setSaved(view.preferences?.blacklist ?? ""); },
      (error: unknown) => setLoadError(describeError(error, "The blacklist could not be loaded.")),
    );
  }, []);
  useEffect(fetchRules, [fetchRules]);
  const retryLoad = () => { setLoadError(null); fetchRules(); };

  const ruleCount = useMemo(() => (rules === null ? 0 : tokens(rules).length), [rules]);
  const dirty = rules !== null && rules !== saved;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (rules === null || pending) return;
    const local = localIssues(rules);
    setIssues(local.issues);
    setSummary(local.summary ?? null);
    setSaveError(null);
    setResult(null);
    if (local.issues.length || local.summary) { textareaRef.current?.focus(); return; }
    setPending(true);
    try {
      const response = (await command("blacklist.save", { rules })) as SaveResult | undefined;
      setSaved(rules);
      setResult(response ?? {});
    } catch (error) {
      const described = describeError(error, "The blacklist was not saved.");
      const parsed = serverIssues(described.message, rules);
      if (parsed.length) {
        setIssues(parsed);
        setSummary("Fever could not use some rules. Nothing was saved.");
        textareaRef.current?.focus();
      } else {
        setSaveError(described);
      }
    } finally {
      setPending(false);
    }
  }

  if (loadError) {
    return isSessionError(loadError)
      ? <ErrorNotice title="Your session ended" error="Reload the page to log in again." onRetry={() => window.location.reload()} retryLabel="Reload" />
      : <ErrorNotice title="Blacklist unavailable" error={loadError} onRetry={retryLoad} />;
  }
  if (rules === null) return <Loading>Loading your blacklist…</Loading>;

  const describedBy = [`${id}-help`, issues.length || summary ? `${id}-issues` : ""].filter(Boolean).join(" ");

  return (
    <form method="post" action="" onSubmit={submit} noValidate>
      <div id={`${id}-help`}>
        <p>Links matching these rules never heat up in Hot. Put each rule on its own line:</p>
        <ul className="fp-list">
          <li>an exact address, such as <code>http://example.com/page</code></li>
          <li>a whole site, such as <code>domain:example.com</code> (also matches its subdomains)</li>
          <li>a regular expression that starts with <code>#</code>, such as <code>#example\.com/ads/#</code>; matching ignores case</li>
        </ul>
        <p className="fp-small fp-muted">Rules are separated by spaces or line breaks, so a rule cannot contain a space.</p>
      </div>

      {summary || issues.length ? (
        <div className="fp-notice fp-error" role="alert" id={`${id}-issues`}>
          <p><strong>Check the blacklist.</strong> {summary ?? "Some rules need fixing before Fever can save them."}</p>
          {issues.length ? (
            <ul>
              {issues.map((issue) => (
                <li key={`${issue.rule}-${issue.raw}`}>Rule {issue.rule}{issue.raw ? <> (<code className="fp-break">{issue.raw}</code>)</> : null}: {issue.message}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {saveError ? <ErrorNotice title="Not saved" error={saveError} /> : null}
      {result ? (
        <Notice tone="success" live>
          <p>
            Saved {result.ruleCount ?? ruleCount} {(result.ruleCount ?? ruleCount) === 1 ? "rule" : "rules"}.
            {typeof result.scanned === "number" ? ` Checked ${result.scanned.toLocaleString()} links; ${(result.matched ?? 0).toLocaleString()} ${result.matched === 1 ? "is" : "are"} now blacklisted.` : ""}
          </p>
        </Notice>
      ) : null}
      {pending ? <Loading>Saving rules and filtering existing links. Large collections can take a minute…</Loading> : null}

      <div className="fp-rows">
        <div className="fp-row fp-row-stack">
          <label className="fp-label" htmlFor={`${id}-rules`}>Blacklist rules <span className="fp-muted fp-small">({ruleCount})</span></label>
          <div className="fp-field">
            <textarea
              ref={textareaRef}
              id={`${id}-rules`}
              name="blacklist"
              rows={10}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              value={rules}
              onChange={(event) => { setRules(event.target.value); setResult(null); }}
              aria-invalid={issues.length || summary ? true : undefined}
              aria-describedby={describedBy}
              disabled={pending}
            />
          </div>
        </div>
      </div>
      <div className="fp-actions">
        <a className="fp-btn" href={appHref("/")}>{dirty ? "Cancel" : "Done"}</a>
        <button type="submit" className="fp-btn fp-default" disabled={pending} aria-busy={pending || undefined}>
          {pending ? "Filtering…" : "Save and Filter"}
        </button>
      </div>
    </form>
  );
}

export function BlacklistPage() {
  return (
    <PageShell title="Blacklist" subtitle="Prevent specific urls from heating up" width="wide" nav>
      <SessionGate returnTo="/blacklist">{() => <BlacklistForm />}</SessionGate>
    </PageShell>
  );
}
