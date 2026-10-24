/**
 * Keyboard command registry. The reader dispatches from this table and the
 * help overlay renders it, so behavior and documentation cannot drift.
 * Source: firewall/app/views/default/scripts/reader.js keydown handler.
 */
interface CommandDefinition {
  id: string;
  /** Display labels, e.g. ["Shift", "A"]; alternatives are separate entries. */
  keys: string[][];
  label: string;
  group: "Sections" | "Reading" | "Navigation" | "Managing";
}

const DEFINITIONS = [
  { id: "section-hot", keys: [["1"]], label: "Hot", group: "Sections" },
  { id: "section-kindling", keys: [["2"]], label: "Kindling", group: "Sections" },
  { id: "section-saved", keys: [["3"]], label: "Saved", group: "Sections" },
  { id: "section-sparks", keys: [["4"]], label: "Sparks", group: "Sections" },
  { id: "section-search", keys: [["5"]], label: "Search results", group: "Sections" },
  { id: "focus-search", keys: [["/"]], label: "Focus the search field", group: "Sections" },
  { id: "escape", keys: [["Esc"]], label: "Clear search, close menus", group: "Sections" },

  { id: "next-item", keys: [["J"]], label: "Next item or link", group: "Reading" },
  { id: "previous-item", keys: [["K"]], label: "Previous item or link", group: "Reading" },
  { id: "page-next", keys: [["Space"]], label: "Scroll forward, then next item; loads more at the end", group: "Reading" },
  { id: "page-previous", keys: [["Shift", "Space"]], label: "Scroll back", group: "Reading" },
  { id: "toggle-content", keys: [["Enter"], ["0"]], label: "Toggle excerpt and full content", group: "Reading" },
  { id: "save", keys: [["S"]], label: "Save or unsave the focused item", group: "Reading" },
  { id: "open", keys: [["O"]], label: "Open the focused item or source", group: "Reading" },
  { id: "visit-site", keys: [["V"]], label: "Visit the focused feed's site", group: "Reading" },
  { id: "visit-site-read", keys: [["Shift", "V"]], label: "Visit the feed's site and mark the feed read", group: "Reading" },
  { id: "mark-active-read", keys: [["A"]], label: "Mark the current group or feed as read", group: "Reading" },
  { id: "mark-all-read", keys: [["Shift", "A"]], label: "Mark everything as read", group: "Reading" },
  { id: "undo", keys: [["Z"]], label: "Unread the most recently read items", group: "Reading" },
  { id: "blacklist-link", keys: [["B"]], label: "Blacklist the focused Hot link", group: "Reading" },

  { id: "pane-left", keys: [["←"], ["H"]], label: "Move focus to the pane on the left", group: "Navigation" },
  { id: "pane-right", keys: [["→"], ["L"]], label: "Move focus right; on an item, open it", group: "Navigation" },
  { id: "list-up", keys: [["↑"]], label: "Previous group or feed in the focused pane", group: "Navigation" },
  { id: "list-down", keys: [["↓"]], label: "Next group or feed in the focused pane", group: "Navigation" },
  { id: "source-up", keys: [["Shift", "↑"], ["Shift", "K"]], label: "Previous source of the focused Hot link", group: "Navigation" },
  { id: "source-down", keys: [["Shift", "↓"], ["Shift", "J"]], label: "Next source of the focused Hot link", group: "Navigation" },
  { id: "toggle-feeds", keys: [["F"]], label: "Show or hide the feeds pane", group: "Navigation" },
  { id: "toggle-read", keys: [["U"]], label: "Show or hide read groups, feeds, and items", group: "Navigation" },

  { id: "refresh-all", keys: [["R"]], label: "Refresh all feeds", group: "Managing" },
  { id: "refresh-active", keys: [["Shift", "R"]], label: "Refresh the current group or feed", group: "Managing" },
  { id: "new-feed", keys: [["N"]], label: "New feed", group: "Managing" },
  { id: "new-group", keys: [["Shift", "N"]], label: "New group", group: "Managing" },
  { id: "edit-active", keys: [["I"]], label: "Edit the current group, feed, or Sparks", group: "Managing" },
  { id: "preferences", keys: [["P"]], label: "Preferences", group: "Managing" },
  { id: "blacklist-page", keys: [["Shift", "B"]], label: "Edit the blacklist", group: "Managing" },
  { id: "help", keys: [["?"]], label: "Show this keyboard help", group: "Managing" },
] as const satisfies readonly CommandDefinition[];

export type CommandId = typeof DEFINITIONS[number]["id"];
export interface KeyBinding { key: string; shift: boolean | "any"; }
export interface CommandDef extends CommandDefinition { id: CommandId; bindings: KeyBinding[]; }
const KEY_NAMES: Record<string, string> = { "←": "ArrowLeft", "→": "ArrowRight", "↑": "ArrowUp", "↓": "ArrowDown", Space: " ", Esc: "Escape" };
export const COMMANDS: CommandDef[] = DEFINITIONS.map(definition => ({
  ...definition, keys: definition.keys.map(keys => [...keys]),
  bindings: definition.keys.map(keys => {
    const label = keys[keys.length - 1];
    const key = KEY_NAMES[label] ?? label.toLowerCase();
    const anyShift = ["0", "1", "2", "3", "4", "5", "enter", "Escape", "/", "?", "ArrowLeft", "ArrowRight"].includes(key);
    return { key, shift: anyShift ? "any" : keys.some(part => part === "Shift") };
  }),
}));

/** Core letter keys, used to report sharing-service shortcut conflicts. */
export const CORE_LETTERS = new Set(COMMANDS.flatMap(command => command.bindings.filter(binding => /^[a-z0-9]$/.test(binding.key)).map(binding => binding.key)));

/** True when the event target is a text-entry context we must never intercept. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (target as HTMLInputElement).type;
    return !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"].includes(type);
  }
  return false;
}

/** Map a keydown to a command, honoring IME and platform-shortcut guards. */
export function commandForEvent(event: KeyboardEvent): CommandId | null {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return null;
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  const alias = event.key === "Esc" ? "Escape" : event.key === "Spacebar" ? " " : event.key;
  const key = alias.length === 1 || alias === "Enter" ? alias.toLowerCase() : alias;
  return COMMANDS.find(command => command.bindings.some(binding => binding.key === key && (binding.shift === "any" || binding.shift === event.shiftKey)))?.id ?? null;
}
