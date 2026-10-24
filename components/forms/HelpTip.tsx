"use client";
import { useId, useState } from "react";
export const HELP = {
  hotlinking: "Some sites block images that are shown on other sites, returning a 403 Forbidden error or a different image. Fever can load those images through your installation instead.",
  multiple: "Check each item you want. Use the filter to narrow a long list. You can also drag feeds onto groups and Sparks in the reader, or use a feed's menu.",
  "feed-auth": "Some feeds require a username and password. If a feed needs them and they are missing, Fever asks when it refreshes the feed. Saved credentials are never shown again.",
  "feed-title": "Optional. Leave blank to use the title the feed provides.",
  excerpts: "Some feeds link straight to the page the author is commenting on. If excerpted, you might miss their commentary.",
  sparks: "Sparks are inessential feeds that raise the temperature of links in Hot. Their unread items never appear in Kindling or your groups. Link blogs and sites that repost a lot are good Sparks.",
  "service-url": "Most services have an address for adding new items. Fever replaces %t with the title, %u with the address and %e with the excerpt, each encoded, before opening it. Put # before an http or https address to have Fever's server request it in the background instead; nothing is sent until you choose the service on an item.",
  "saved-feed": "When enabled, the saved items feed is listed on your Fever login page so feed readers can find it.",
  "item-expiration": "Fever deletes unsaved items older than this. A shorter period uses less database space, but older Hot time ranges have less to work with. Saved items are never expired.",
} as const;
export type HelpTopic = keyof typeof HELP;

export function HelpTip({ topic, label }: { topic: HelpTopic; label?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className="fm-help">
      <button
        type="button"
        className="fm-help-toggle"
        aria-expanded={open}
        aria-controls={id}
        aria-label={`Help${label ? `: ${label}` : ""}`}
        onClick={() => setOpen((value) => !value)}
      >?</button>
      <span id={id} className="fm-help-text" role="note" hidden={!open}>{HELP[topic]}</span>
    </span>
  );
}

