"use client";
import { type FormEvent, useState } from "react";
import type { FeedDTO, GroupDTO, SharingService } from "@/lib/contracts";
import { COMMANDS, CORE_LETTERS } from "@/lib/client/commands";
import { errorMessage } from "@/lib/client/api";
import { feedTitle, groupTitle, sortByTitle } from "@/lib/client/format";
import { ReaderDialog, TextButton } from "./ui";

/**
 * Accessible alternative to dragging a feed onto groups, Sparks, or Remove.
 * Applies only the memberships that changed.
 */
export function MembershipDialog({ feed, groups, onApply, onClose }: {
  feed: FeedDTO; groups: GroupDTO[];
  onApply: (changes: { add: number[]; remove: number[]; spark: boolean | null }) => Promise<void>;
  onClose: () => void;
}) {
  const initial = new Set(groups.filter((g) => g.feedIds.includes(feed.id) || feed.groupIds.includes(g.id)).map((g) => g.id));
  const [selected, setSelected] = useState(new Set(initial));
  const [spark, setSpark] = useState(feed.isSpark);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (id: number) => setSelected((previous) => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const add = [...selected].filter((id) => !initial.has(id));
    const remove = [...initial].filter((id) => !selected.has(id));
    const sparkChange = spark !== feed.isSpark ? spark : null;
    if (!add.length && !remove.length && sparkChange === null) { onClose(); return; }
    setPending(true);
    setError(null);
    try {
      await onApply({ add, remove, spark: sparkChange });
      onClose();
    } catch (failure) {
      setError(errorMessage(failure, "The groups could not be updated."));
      setPending(false);
    }
  };

  return (
    <ReaderDialog title={`Groups for ${feedTitle(feed)}`} onClose={onClose}>
      <form onSubmit={submit}>
        <fieldset>
          <p>Choose the groups this feed belongs to. A feed can be in several groups. While it is a Spark, its groups are kept but hidden.</p>
          <ul className="check-list">
            {sortByTitle(groups, groupTitle).map((group, index) => (
              <li key={group.id}>
                <label><input type="checkbox" checked={selected.has(group.id)} onChange={() => toggle(group.id)} data-autofocus={index === 0 ? true : undefined} /> {groupTitle(group)}</label>
              </li>
            ))}
            {!groups.length ? <li>There are no custom groups yet.</li> : null}
          </ul>
          <p><label><input type="checkbox" checked={spark} onChange={(e) => setSpark(e.target.checked)} /> Spark (counts toward Hot only)</label></p>
          {error ? <ul className="errors" role="alert"><li>{error}</li></ul> : null}
          <div className="btn-row">
            <TextButton onClick={onClose}>Cancel</TextButton>
            <TextButton type="submit" primary disabled={pending}>{pending ? "Saving…" : "Save"}</TextButton>
          </div>
        </fieldset>
      </form>
    </ReaderDialog>
  );
}

function Keys({ keys }: { keys: string[][] }) {
  return (
    <>
      {keys.map((combo, index) => (
        <span key={index}>
          {index > 0 ? " or " : null}
          {combo.map((key, i) => <span key={key}>{i > 0 ? "+" : null}<kbd>{key}</kbd></span>)}
        </span>
      ))}
    </>
  );
}

/** Generated from the command registry plus configured sharing services. */
export function KeyboardHelpDialog({ services, onClose }: { services: SharingService[]; onClose: () => void }) {
  const groups = ["Sections", "Reading", "Navigation", "Managing"] as const;
  const shortcutServices = services.filter((service) => service.key);
  return (
    <ReaderDialog title="Keyboard Shortcuts" onClose={onClose} wide>
      <div className="keyboard-help">
        {groups.map((group) => (
          <section key={group}>
            <h2>{group}</h2>
            <table>
              <tbody>
                {COMMANDS.filter((command) => command.group === group).map((command) => (
                  <tr key={command.id}><th scope="row"><Keys keys={command.keys} /></th><td>{command.label}</td></tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
        {shortcutServices.length ? (
          <section>
            <h2>Sharing services</h2>
            <table>
              <tbody>
                {shortcutServices.map((service) => {
                  const conflict = CORE_LETTERS.has(service.key.toLowerCase());
                  return (
                    <tr key={`${service.name}-${service.key}`}>
                      <th scope="row"><kbd>{service.key.toUpperCase()}</kbd></th>
                      <td>
                        Send the focused item to {service.name}
                        {service.enabled === false ? ` (disabled: ${service.reason ?? "unsupported template"})` : ""}
                        {conflict ? <em className="conflict"> — conflicts with a core shortcut. With an item focused, {service.name} takes priority, as in Fever; otherwise the core command runs. Change the key in Preferences › Sharing to resolve it.</em> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        ) : null}
        <p className="note">Shortcuts are ignored while typing in a field or composing text. Control, Command, and Option combinations are left to the browser.</p>
        <div className="btn-row"><TextButton primary onClick={onClose}>Done</TextButton></div>
      </div>
    </ReaderDialog>
  );
}

export function SessionExpiredDialog({ onLogin }: { onLogin: () => void }) {
  return (
    <ReaderDialog title="Session expired" onClose={onLogin}>
      <p>Your login session has ended. Your place in the reader is kept in the address bar, so you will return here after logging in.</p>
      <div className="btn-row"><TextButton primary onClick={onLogin}>Log in again</TextButton></div>
    </ReaderDialog>
  );
}
