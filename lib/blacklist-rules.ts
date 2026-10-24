/** Browser-safe lexical policy; only the server decides whether RE2 can compile a pattern. */
export const BLACKLIST_LIMITS = Object.freeze({ bytes: 65_536, rules: 512, patternBytes: 2_048, urlBytes: 65_536 });
export type RuleKind = "exact" | "domain" | "regex";
export interface RuleToken { position: number; raw: string; kind: RuleKind; pattern: string; }
export const utf8Bytes = (value: string): number => new TextEncoder().encode(value).length;
export function tokenizeBlacklist(raw: string): RuleToken[] {
  return raw.split(/[\t\n\r\f\v ]+/).filter(token => token !== "" && token !== "0").map((raw, position) => {
    const kind: RuleKind = raw.startsWith("#") ? "regex" : raw.startsWith("domain:") ? "domain" : "exact";
    return { position, raw, kind, pattern: kind === "regex" ? raw.replace(/#/g, "") : kind === "domain" ? raw.slice(7) : raw };
  });
}
export function ruleProblem(rule: RuleToken): string | null {
  if (utf8Bytes(rule.pattern) > BLACKLIST_LIMITS.patternBytes) return "Rule exceeds 2 KiB";
  if (rule.kind === "domain") {
    const domain = rule.pattern.replace(/[A-Z]/g, letter => letter.toLowerCase()).replace(/\.$/, "");
    if (!domain || domain.length > 253 || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain) || domain.includes("..")) return "domain: requires a hostname without a scheme, path, port, or wildcard";
  }
  return null;
}
