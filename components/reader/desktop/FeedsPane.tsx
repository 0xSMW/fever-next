"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FeedDTO, ItemDTO, ReaderView, ViewState } from "@/lib/contracts";
import { readerHref } from "@/lib/client/url-state";
import { alphaKey, feedTitle } from "@/lib/client/format";
import type { ReaderController } from "../controller";
import { feedCount, feedCountLabel, feedRefreshFailed, resolveOption, scopeTotal, showsCounts, visibleScopeFeeds } from "../model";
import { Favicon, Frame, HelpButton, MenuButton, type MenuItem } from "../ui";
import { FEED_DRAG_TYPE } from "./GroupsPane";

interface Props {
  ctl: ReaderController;
  data: ReaderView;
  view: ViewState;
  items: ItemDTO[];
  paneFocused: boolean;
  cursor: string | null;
  openMenu: (anchor: HTMLElement, label: string, items: MenuItem[]) => void;
  onDragState: (dragging: boolean) => void;
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

export function feedStatusText(feed: FeedDTO): string {
  const parts: string[] = [];
  if (feed.requiresAuth) parts.push("requires authentication");
  if (feedRefreshFailed(feed)) parts.push(`last refresh failed: ${feed.lastError}`);
  else if (feed.lastError) parts.push(`last refresh reported: ${feed.lastError}`);
  if (!feed.totalCount) parts.push("no items in the retention period");
  return parts.join("; ");
}

export function FeedsPane({ ctl, data, view, items, paneFocused, cursor, openMenu, onDragState }: Props) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  // reader.js marks #feeds-container .scrollable only when the list overflows;
  // reader.css shows the alphabet strip only then.
  const [scrollable, setScrollable] = useState(false);
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || typeof ResizeObserver === "undefined") return;
    // ResizeObserver reports each observed element once on observe(), so this also takes the first measurement.
    const observer = new ResizeObserver(() => setScrollable(scroller.scrollHeight > scroller.clientHeight + 1));
    observer.observe(scroller);
    if (scroller.firstElementChild) observer.observe(scroller.firstElementChild);
    return () => observer.disconnect();
  }, []);
  const feeds = useMemo(() => visibleScopeFeeds(data, view, items), [data, view, items]);
  const label = feedCountLabel(view);
  const total = scopeTotal(data, view, feeds);
  const counted = showsCounts(data, label);
  const firstByLetter = useMemo(() => {
    const map = new Map<string, number>();
    for (const feed of feeds) {
      const key = alphaKey(feedTitle(feed));
      if (!map.has(key) && feed.title) map.set(key, feed.id);
    }
    return map;
  }, [feeds]);

  const selected = (key: string, id: number) => cursor ? cursor === key : view.feedId === id;
  const allUnreadVisible = resolveOption("unreadCounts", data.preferences, view, data.groups, null) === 1;
  const jump = (feedId: number) => {
    const row = document.getElementById(`feed-${feedId}`);
    const scroller = scrollerRef.current;
    if (row && scroller) scroller.scrollTop = row.offsetTop - scroller.offsetTop;
    row?.querySelector("a")?.focus({ preventScroll: true });
  };

  return (
    <div id="feeds-container" className={scrollable ? "scrollable" : undefined}>
      <div id="feeds" className={`box${paneFocused ? " has-focus" : ""}`}>
        <div className="content">
          <div id="feeds-scroller-container">
            <div id="feeds-scroller" ref={scrollerRef} tabIndex={-1}>
              <ul className="box-list" aria-label="Feeds">
                <li id="feed-0" className={selected("feed-0", 0) ? "has-focus" : undefined}>
                  <a
                    href={readerHref({ ...view, feedId: 0 })}
                    aria-current={!cursor && view.feedId === 0 ? "page" : undefined}
                    className={`feed-0 ${total || label !== "unread" ? "unread" : "read"}${label === "unread" && !allUnreadVisible ? " hide-unread" : ""}`}
                    onClick={(event) => { if (event.button === 0 && !event.metaKey && !event.ctrlKey) { event.preventDefault(); ctl.loadFeed(0); } }}
                  >
                    <i className="icon unread" aria-hidden="true" /> All items{" "}
                    {counted ? <em className={`${label}-count`}>{total}</em> : null}
                    {total && counted ? <span className="sr-only">, {total} {label === "search" ? "matching" : label}</span> : null}
                  </a>
                  {view.section === "kindling" ? (
                    <MenuButton kind="group" label="Group actions" onOpen={(anchor) => openMenu(anchor, "Group actions", ctl.groupMenu(view.groupId))} />
                  ) : view.section === "sparks" ? (
                    <MenuButton kind="group" label="Sparks actions" onOpen={(anchor) => openMenu(anchor, "Sparks actions", ctl.sparksMenu())} />
                  ) : null}
                  <HelpButton topic="all-items" />
                </li>
                {feeds.map((feed) => {
                  const key = `feed-${feed.id}`;
                  const count = feedCount(data, label, feed);
                  const isRead = label === "unread" && !feed.unreadCount;
                  const countsVisible = label === "saved" || resolveOption("unreadCounts", data.preferences, view, data.groups, feed) === 1;
                  const status = feedStatusText(feed);
                  const failed = feedRefreshFailed(feed);
                  const title = feedTitle(feed);
                  return (
                    <li key={feed.id} id={key} className={`${selected(key, feed.id) ? "has-focus" : ""}${failed ? " has-error" : ""}`.trim() || undefined}>
                      <a
                        href={readerHref({ ...view, feedId: feed.id })}
                        aria-current={!cursor && view.feedId === feed.id ? "page" : undefined}
                        className={`feed-${feed.id} proper ${isRead ? "read" : "unread"}${!feed.totalCount ? " abandoned" : ""}${countsVisible ? "" : " hide-unread"}`}
                        title={status ? `${title} — ${status}` : title}
                        draggable
                        onDragStart={(event) => {
                          event.dataTransfer.setData(FEED_DRAG_TYPE, String(feed.id));
                          event.dataTransfer.setData("text/plain", title);
                          event.dataTransfer.effectAllowed = "copyMove";
                          onDragState(true);
                        }}
                        onDragEnd={() => onDragState(false)}
                        onClick={(event) => { if (event.button === 0 && !event.metaKey && !event.ctrlKey) { event.preventDefault(); ctl.loadFeed(feed.id); } }}
                      >
                        <Favicon feed={feed} /> {title}{" "}
                        {counted ? <em className={`${label}-count`}>{count}</em> : null}
                        {count && counted ? <span className="sr-only">, {count} {label === "search" ? "matching" : label}</span> : null}
                        {status ? <span className="sr-only">, {status}</span> : null}
                        {failed ? <span className="feed-error-mark" aria-hidden="true">!</span> : null}
                      </a>
                      <MenuButton kind="feed" label={`${title} actions`} onOpen={(anchor) => openMenu(anchor, `${title} actions`, ctl.feedMenu(feed.id))} />
                      <button type="button" className="btn refresh" aria-label={`Refresh ${title}`} title="Refresh feed" onClick={() => ctl.refreshFeed(feed.id)}>Refresh</button>
                    </li>
                  );
                })}
              </ul>
              {!feeds.length ? (
                <p className="pane-empty">
                  {view.section === "saved" ? "No feeds have saved items."
                    : view.section === "search" ? "No feeds match."
                      : view.showRead ? "No feeds in this group." : "No feeds with unread items."}
                </p>
              ) : null}
            </div>
          </div>
        </div>
        <Frame />
      </div>

      <nav id="feeds-alpha" aria-label="Jump to feeds by letter">
        <ul>
          <li><button type="button" className="btn cancel" aria-label="Hide feeds" onClick={ctl.toggleFeeds}>Hide feeds</button></li>
          <li><button type="button" aria-label="Jump to All items" onClick={() => jump(0)}>#</button></li>
          {LETTERS.map((letter) => {
            const id = firstByLetter.get(letter);
            return (
              <li key={letter}>
                {id ? <button type="button" aria-label={`Jump to feeds starting with ${letter}`} onClick={() => jump(id)}>{letter}</button> : <span aria-hidden="true">{letter}</span>}
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
