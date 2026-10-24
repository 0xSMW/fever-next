"use client";
import { useId } from "react";
import type { DisplayOptions, Preferences } from "@/lib/contracts";
import type { ClientError as FormError } from "@/lib/client/errors";
import { INHERITED_DISPLAY, createDefaultPreferences } from "@/lib/reader-policy";
import { HelpTip } from "./HelpTip";
export const SORT_ORDER_LABELS = ["newest first", "oldest first"] as const;
export const ITEM_ALLOWS_LABELS = ["text only", "text with images", "rich content (sanitized)"] as const;
export type DisplayValues = Pick<DisplayOptions, "sortOrder" | "itemAllows" | "itemExcerpts" | "unreadCounts">;
export const INHERIT_ALL: DisplayValues = INHERITED_DISPLAY;

export function displayFrom(source?: Partial<DisplayOptions> | null): DisplayValues {
  const pick = (value: unknown) => (typeof value === "number" && Number.isInteger(value) ? value : -1);
  return {
    sortOrder: pick(source?.sortOrder), itemAllows: pick(source?.itemAllows),
    itemExcerpts: pick(source?.itemExcerpts), unreadCounts: pick(source?.unreadCounts),
  };
}

export function globalDisplay(preferences?: Preferences | null): DisplayValues {
  const defaults = preferences ?? createDefaultPreferences();
  return { sortOrder: defaults.sortOrder, itemAllows: defaults.itemAllows,
    itemExcerpts: Number(defaults.itemExcerpts), unreadCounts: Number(defaults.unreadCounts) };
}

/**
 * The four display overrides shared by feeds and groups. Each row has an
 * explicit “inherit” checkbox (`-1`), as in Fever's display-options templates;
 * the control shows the inherited value until the user overrides it.
 */
export function DisplayOverrides({ value, onChange, inheritLabel, inherited, inheritedFrom, errors }: {
  value: DisplayValues; onChange: (value: DisplayValues) => void; inheritLabel: string;
  inherited: DisplayValues; inheritedFrom: string; errors?: FormError | null;
}) {
  const id = useId();
  const set = <K extends keyof DisplayValues>(key: K, next: number) => onChange({ ...value, [key]: next });
  const effective = (key: keyof DisplayValues) => (value[key] === -1 ? inherited[key] : value[key]);
  const inheritBox = (key: keyof DisplayValues, overrideValue: number) => (
    <label className="fm-inherit">
      <input type="checkbox" checked={value[key] === -1}
        onChange={(event) => set(key, event.currentTarget.checked ? -1 : overrideValue)} />
      {inheritLabel}
    </label>
  );
  return (
    <div className="fm-display">
      <p className="fm-hint">Settings marked “{inheritLabel}” follow {inheritedFrom}. Change a setting to override it.</p>
      <fieldset className="fm-row fm-radio-row">
        <legend className="fm-row-label">Item sort order</legend>
        <div className="fm-row-control fm-override">
          <div className="fm-radios">
            {SORT_ORDER_LABELS.map((label, index) => (
              <label key={label} className="fm-radio">
                <input type="radio" name={`${id}-sort`} checked={effective("sortOrder") === index}
                  onChange={() => set("sortOrder", index)} />
                {label}
              </label>
            ))}
          </div>
          {inheritBox("sortOrder", effective("sortOrder"))}
          {errors?.fields.sortOrder && <p className="fm-field-error">{errors?.fields.sortOrder}</p>}
        </div>
      </fieldset>
      <div className="fm-row">
        <div className="fm-row-label"><label htmlFor={`${id}-allows`}>Item content</label></div>
        <div className="fm-row-control fm-override">
          <select id={`${id}-allows`} className="fm-input fm-select" value={effective("itemAllows")}
            onChange={(event) => set("itemAllows", Number(event.currentTarget.value))}>
            {ITEM_ALLOWS_LABELS.map((label, index) => <option key={label} value={index}>{label}</option>)}
          </select>
          {inheritBox("itemAllows", effective("itemAllows"))}
          {errors?.fields.itemAllows && <p className="fm-field-error">{errors?.fields.itemAllows}</p>}
        </div>
      </div>
      <div className="fm-row">
        <div className="fm-row-label"><span>Excerpts</span><HelpTip topic="excerpts" label="Excerpts" /></div>
        <div className="fm-row-control fm-override">
          <label className="fm-check-inline">
            <input type="checkbox" checked={effective("itemExcerpts") > 0}
              onChange={(event) => set("itemExcerpts", event.currentTarget.checked ? 1 : 0)} />
            excerpt feed items
          </label>
          {inheritBox("itemExcerpts", effective("itemExcerpts"))}
        </div>
      </div>
      <div className="fm-row">
        <div className="fm-row-label"><span>Counts</span></div>
        <div className="fm-row-control fm-override">
          <label className="fm-check-inline">
            <input type="checkbox" checked={effective("unreadCounts") > 0}
              onChange={(event) => set("unreadCounts", event.currentTarget.checked ? 1 : 0)} />
            show unread counts
          </label>
          {inheritBox("unreadCounts", effective("unreadCounts"))}
        </div>
      </div>
    </div>
  );
}

