"use client";

import { useId, useMemo, useState } from "react";
import { command } from "@/lib/client/api";
import {
  Button, ErrorBanner, Footer, Frame, RadioGroup, Row, StatusBanner, numberResult, plural, useAction, usePanel,
} from "./shared";

type RuleKind = "exact" | "domain" | "regex";
interface ParsedRule { index: number; raw: string; kind: RuleKind; problem: string | null; }

const RULE_LIMIT = 512;

/**
 * Fever splits rules on any whitespace, not only line breaks. A rule starting
 * with # is a case-insensitive regular expression (every # is removed),
 * `domain:` is an explicit host rule, and anything else is an exact URL.
 */
export function parseRules(raw: string): ParsedRule[] {
  return raw.split(/[\t\n\r\f\v ]+/).filter((token) => token !== "" && token !== "0").map((raw, index) => {
    const kind: RuleKind = raw.startsWith("#") ? "regex" : raw.startsWith("domain:") ? "domain" : "exact";
    let problem: string | null = null;
    if (kind === "regex") {
      try { new RegExp(raw.replace(/#/g, ""), "i"); } catch { problem = "This regular expression is not valid."; }
      if (/\(\?[<=!]|\\[1-9]/.test(raw)) problem = "Look-around and back-references are not supported; Fever keeps the rule but does not use it.";
    } else if (kind === "domain") {
      const domain = raw.slice(7).toLowerCase().replace(/\.$/, "");
      if (!domain || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain) || domain.includes("..")) {
        problem = "Use a host name only, such as domain:example.com, with no scheme, path or port.";
      }
    }
    return { index, raw, kind, problem };
  });
}

/** Host of a link for a `domain:` rule, ignoring a leading www. */
function hostOf(value: string): string | null {
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(value.trim()) ? value.trim() : `http://${value.trim()}`);
    return url.hostname.replace(/^www\./i, "").replace(/\.$/, "").toLowerCase() || null;
  } catch {
    return null;
  }
}

const KIND_LABEL: Record<RuleKind, string> = { exact: "exact link", domain: "domain", regex: "regex" };

export function BlacklistEditor({ initialRules, link }: { initialRules: string; link?: string }) {
  const panel = usePanel();
  const action = useAction();
  const id = useId();
  const [rules, setRules] = useState(initialRules);
  const [entry, setEntry] = useState(link ?? "");
  const [kind, setKind] = useState<RuleKind>("exact");
  const [entryError, setEntryError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const parsed = useMemo(() => parseRules(rules), [rules]);
  const problems = parsed.filter((rule) => rule.problem);
  const changed = rules.trim() !== initialRules.trim();

  const ruleFromEntry = (): string | null => {
    const value = entry.trim();
    if (!value) { setEntryError("Enter a link, domain or regular expression."); return null; }
    if (/\s/.test(value)) { setEntryError("Rules cannot contain spaces. Use %20 or \\s in a regular expression."); return null; }
    if (kind === "domain") {
      const host = hostOf(value.replace(/^domain:/, ""));
      if (!host) { setEntryError("Enter a link or host name to block its whole domain."); return null; }
      return `domain:${host}`;
    }
    if (kind === "regex") {
      const pattern = value.replace(/^#|#$/g, "");
      try { new RegExp(pattern, "i"); } catch { setEntryError("This regular expression is not valid."); return null; }
      return `#${pattern}#`;
    }
    return value;
  };

  const addRule = () => {
    setEntryError(null);
    const rule = ruleFromEntry();
    if (!rule) return;
    if (parsed.some((existing) => existing.raw === rule)) { setEntryError("That rule is already in the blacklist."); return; }
    setRules((current) => (current.trim() ? `${current.replace(/\s+$/, "")}\n${rule}` : rule));
    setEntry("");
  };

  const removeRule = (index: number) => {
    setRules(parsed.filter((rule) => rule.index !== index).map((rule) => rule.raw).join("\n"));
  };

  const submit = async () => {
    setResult(null);
    if (parsed.length > RULE_LIMIT) {
      action.setError({ message: `The blacklist can hold at most ${RULE_LIMIT} rules.`, fields: { rules: `Remove ${parsed.length - RULE_LIMIT} rules.` } });
      return;
    }
    let text = rules.trim();
    // A pending entry the user typed but did not add would otherwise be lost.
    if (entry.trim()) {
      const rule = ruleFromEntry();
      if (!rule) return;
      if (!parsed.some((existing) => existing.raw === rule)) text = text ? `${text}\n${rule}` : rule;
    }
    const outcome = await action.run(() => command("blacklist.save", { rules: text }));
    if (!outcome.ok) return;
    setRules(text);
    setEntry("");
    const ruleCount = numberResult(outcome.value, "ruleCount") ?? parseRules(text).length;
    const matched = numberResult(outcome.value, "matched");
    const scanned = numberResult(outcome.value, "scanned");
    await panel.changed();
    setResult(
      `${plural(ruleCount, "rule")} saved.` +
      (matched !== undefined && scanned !== undefined ? ` ${plural(matched, "link")} out of ${scanned.toLocaleString()} ${matched === 1 ? "is" : "are"} now kept out of Hot.` : " Hot has been filtered again."),
    );
  };

  return (
    <Frame title="Blacklist" subtitle="Prevent specific links from heating up" size="wide" onSubmit={submit} busy={action.pending}
      footer={<Footer submitLabel="Save and Filter" pendingLabel="Saving and filtering…" pending={action.pending}
        cancelLabel={result ? "Done" : "Cancel"}
        extra={action.pending ? <span className="fm-muted" role="status">Filtering existing links. This can take a moment.</span> : undefined} />}>
      <ErrorBanner error={action.error} />
      {result && <StatusBanner tone="success">{result}</StatusBanner>}

      <fieldset className="fm-group">
        <legend>Add a rule</legend>
        <Row label="Link" htmlFor={`${id}-entry`} error={entryError ?? undefined} errorId={`${id}-entry-error`}>
          <div className="fm-input-with-button">
            <input id={`${id}-entry`} className="fm-input" value={entry} spellCheck={false} inputMode="url" data-autofocus=""
              aria-invalid={entryError ? true : undefined} aria-describedby={entryError ? `${id}-entry-error` : undefined}
              placeholder={kind === "regex" ? "example\\.com/ads/" : "https://example.com/page"}
              onChange={(event) => { setEntry(event.currentTarget.value); setEntryError(null); }}
              onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); addRule(); } }} />
            <Button onClick={addRule}>Add rule</Button>
          </div>
        </Row>
        <RadioGroup legend="Match" value={kind} onChange={(value) => { setKind(value); setEntryError(null); }}
          options={[
            { value: "exact", label: "exact link" },
            { value: "domain", label: "any link from this domain" },
            { value: "regex", label: "regular expression" },
          ]} />
      </fieldset>

      <Row label="Rules" htmlFor={`${id}-rules`} errorId={`${id}-rules-error`}
        error={action.error?.fields.rules}
        hint={<>Put each exact link or regular expression on its own line. Spaces also separate rules. Regular expressions use <code>#</code> as the delimiter and ignore case; <code>domain:example.com</code> blocks a whole site.</>}>
        <textarea id={`${id}-rules`} className="fm-input fm-textarea" rows={8} spellCheck={false} value={rules}
          aria-invalid={action.error?.fields.rules ? true : undefined}
          aria-describedby={action.error?.fields.rules ? `${id}-rules-error` : undefined}
          onChange={(event) => setRules(event.currentTarget.value)} />
      </Row>

      {parsed.length === 0 ? (
        <p className="fm-empty">The blacklist is empty. Every link can heat up in Hot.</p>
      ) : (
        <div className="fm-rules">
          <p className="fm-muted" aria-live="polite">
            {plural(parsed.length, "rule")}{problems.length ? `, ${plural(problems.length, "needs", "need")} attention` : ""}{changed ? " (not saved yet)" : ""}
          </p>
          <ul className="fm-rule-list">
            {parsed.map((rule) => (
              <li key={`${rule.index}-${rule.raw}`} className={rule.problem ? "fm-rule-problem" : undefined}>
                <span className="fm-tag">{KIND_LABEL[rule.kind]}</span>
                <code className="fm-break">{rule.raw}</code>
                {rule.problem && <span className="fm-rule-issue">{rule.problem}</span>}
                <button type="button" className="fm-link fm-danger-text" onClick={() => removeRule(rule.index)}>
                  Remove<span className="fm-visually-hidden"> rule {rule.raw}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Frame>
  );
}
