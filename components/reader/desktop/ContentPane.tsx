"use client";
import type { MouseEvent } from "react";
import type { FeedDTO, HotLinkDTO, ItemDTO, ReaderView, ViewState } from "@/lib/contracts";
import { readerHref } from "@/lib/client/url-state";
import { absoluteDate, ago, feedTitle, formatTemperature, ucfirst, widont } from "@/lib/client/format";
import { htmlToText } from "@/lib/client/safe-html";
import { shareExcerpt } from "@/lib/client/services";
import { ArticleContent, ExcerptContent, Highlight } from "../ArticleContent";
import type { ReaderController } from "../controller";
import { externalLinkProps } from "../external";
import { STATE_LABELS, feedRefreshFailed, groupLinksByTemperature, itemStateClass, resolveOption, scopeFeeds } from "../model";
import type { ListState, ReaderStore } from "../useReader";
import { Favicon, Frame, MenuButton, type MenuItem, TextButton } from "../ui";
import { FEED_DRAG_TYPE } from "./GroupsPane";

export interface BoxHandlers {
  onBoxClick: (boxId: string, event: MouseEvent, itemId: number | null) => void;
  onToggleContent: (boxId: string, itemId: number | null) => void;
  onToggleSave: (itemId: number) => void;
  onBlacklist: (link: HotLinkDTO) => void;
  /** An article link was followed natively; mark its item read. */
  onOpened: (itemId: number) => void;
  openMenu: (anchor: HTMLElement, label: string, items: MenuItem[]) => void;
  onDragState: (dragging: boolean) => void;
}

function stop(event: MouseEvent) { event.stopPropagation(); }

function InlineFeed({ feed, ctl, view, onDragState, className = "inline-feed" }: {
  feed: FeedDTO | undefined; ctl: ReaderController; view: ViewState; onDragState: (dragging: boolean) => void; className?: string;
}) {
  if (!feed) return <span className={className}>Unknown feed</span>;
  return (
    <a
      href={readerHref({ ...view, feedId: feed.id })}
      className={`${className} feed-${feed.id}${feed.unreadCount ? "" : " read"}`}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData(FEED_DRAG_TYPE, String(feed.id));
        event.dataTransfer.setData("text/plain", feedTitle(feed));
        onDragState(true);
      }}
      onDragEnd={() => onDragState(false)}
      onClick={(event) => {
        event.stopPropagation();
        if (event.button !== 0 || event.metaKey || event.ctrlKey) return;
        event.preventDefault();
        ctl.loadFeed(feed.id, true);
      }}
    >
      <Favicon feed={feed} /> {feedTitle(feed)}
    </a>
  );
}

// List and Hot DTOs carry the complete sanitized html (lib/domain/reader.ts itemDTO,
// lib/domain/hot.ts), as reader/items.php rendered content inline. An empty string
// is an item without content, so full mode renders it at once and fetches nothing.

export function ItemBox({ item, feed, ctl, view, data, focused, full, handlers }: {
  item: ItemDTO; feed: FeedDTO | undefined; ctl: ReaderController; view: ViewState; data: ReaderView;
  focused: boolean; full: boolean; handlers: BoxHandlers;
}) {
  const boxId = `item-${item.id}`;
  const state = itemStateClass(item);
  const highlight = view.section === "search" ? view.search : undefined;
  const link = externalLinkProps(item.url, data.preferences);
  const title = item.title.trim() || "(untitled)";

  return (
    <article
      id={boxId}
      className={`box item ${state}${full ? " full" : ""}${focused ? " has-focus" : ""}`}
      aria-labelledby={`${boxId}-title`}
      onClick={(event) => handlers.onBoxClick(boxId, event, item.id)}
    >
      <div className="content">
        <div className="meta">
          <h1 id={`${boxId}-title`}>
            <span className="sr-only">{STATE_LABELS[state]}: </span>
            {link ? (
              <a {...link} onClick={(event) => { stop(event); handlers.onOpened(item.id); }}>
                <Highlight text={widont(title)} term={highlight} />
              </a>
            ) : <Highlight text={widont(title)} term={highlight} />}
          </h1>
          <h2>
            <InlineFeed feed={feed} ctl={ctl} view={view} onDragState={handlers.onDragState} />
            <span className="posted">
              <time dateTime={item.publishedAt ? new Date(item.publishedAt * 1000).toISOString() : undefined} title={absoluteDate(item.publishedAt)}>
                {ucfirst(ago(item.publishedAt))}
              </time>
              {item.author ? <> by {item.author}</> : null}
            </span>
            {feed ? <MenuButton kind="feed" label={`${feedTitle(feed)} actions`} onOpen={(anchor) => handlers.openMenu(anchor, `${feedTitle(feed)} actions`, ctl.feedMenu(feed.id))} /> : null}
          </h2>
          <button
            type="button"
            className="state"
            aria-pressed={item.isSaved}
            aria-label={item.isSaved ? "Saved. Unsave this item" : "Save this item"}
            title="Toggle item save state"
            onClick={(event) => { stop(event); handlers.onToggleSave(item.id); }}
          >{STATE_LABELS[state]}</button>
          <MenuButton kind="item" label="Item actions" onOpen={(anchor) => handlers.openMenu(anchor, "Item actions", ctl.itemMenu(item, full, () => handlers.onToggleContent(boxId, item.id)))} />
        </div>
        {full
          ? <ArticleContent html={item.html} preferences={data.preferences} highlight={highlight} />
          : <ExcerptContent text={item.excerpt} highlight={highlight} />}
      </div>
      <Frame />
    </article>
  );
}

function Degree({ degree }: { degree: string }) {
  const [integer, decimal = "0"] = degree.split(".");
  const kern = (value: string) => value.split("").map((char, index) => char === "1" ? <span key={index} className="kern-1">1</span> : char);
  return (
    <div className="temperature" aria-hidden="true">
      <span className="integer">{kern(integer)}</span>
      <span className="decimal">.{kern(decimal)}<em>°</em></span>
    </div>
  );
}

export function LinkBox({ link, ctl, view, data, focused, sourceFocus, full, handlers }: {
  link: HotLinkDTO; ctl: ReaderController; view: ViewState; data: ReaderView; focused: boolean; sourceFocus: number;
  full: boolean; handlers: BoxHandlers;
}) {
  const boxId = `link-${link.id}`;
  const anItem = link.isItem && link.isLocal;
  const feed = data.feeds.find((row) => row.id === link.feedId);
  const href = externalLinkProps(link.url, data.preferences);
  const excerpt = link.html ? shareExcerpt(htmlToText(link.html)) : "";
  const backing = anItem ? link.sources.find((source) => source.id === link.itemId) : undefined;

  return (
    <article
      id={boxId}
      className={`box link${anItem ? ` an-item item-${link.itemId}` : ""}${full ? " full" : ""}${link.isSaved ? " saved" : ""}${focused ? " has-focus" : ""}`}
      aria-labelledby={`${boxId}-title`}
      onClick={(event) => handlers.onBoxClick(boxId, event, anItem ? link.itemId : null)}
    >
      <div className="content">
        <div className="meta">
          <h1 id={`${boxId}-title`}>
            {href ? (
              <a {...href} onClick={(event) => { stop(event); if (link.isItem) handlers.onOpened(link.itemId); }}>
                {widont(link.title.trim() || link.url)}
              </a>
            ) : widont(link.title.trim() || link.url)}
          </h1>
          {anItem ? (
            <h2>from <InlineFeed feed={feed} ctl={ctl} view={view} onDragState={handlers.onDragState} className="inline-feed" /></h2>
          ) : null}
          {anItem ? (
            <button
              type="button"
              className="state"
              aria-pressed={link.isSaved}
              aria-label={link.isSaved ? "Saved. Unsave this item" : "Save this item"}
              title="Toggle link save state"
              onClick={(event) => { stop(event); handlers.onToggleSave(link.itemId); }}
            >{link.isSaved ? "Saved" : backing && !backing.readAt ? "Unread" : "Read"}</button>
          ) : null}
          <button type="button" className="btn blacklist" aria-label="Add link to blacklist" title="Add link to blacklist"
            onClick={(event) => { stop(event); handlers.onBlacklist(link); }}>Blacklist</button>
          {anItem && backing ? (
            <MenuButton kind="item" label="Item actions" onOpen={(anchor) => handlers.openMenu(anchor, "Item actions", ctl.itemMenu(backing, full, () => handlers.onToggleContent(boxId, link.itemId)))} />
          ) : null}
        </div>
        {full && anItem
          ? <ArticleContent html={link.html} preferences={data.preferences} />
          : excerpt ? <ExcerptContent text={excerpt} /> : null}
        {link.sources.length ? (
          <ul className={`source-list${focused ? " has-focus" : ""}`} aria-label={`Sources linking to ${link.title || link.url}`}>
            {link.sources.map((source, index) => {
              const sourceFeed = data.feeds.find((row) => row.id === source.feedId);
              const sourceHref = externalLinkProps(source.url, data.preferences);
              return (
                <li key={source.id} className={focused && sourceFocus === index ? "has-focus" : undefined}>
                  <span className={`source item-${source.id} ${source.readAt ? "read" : "unread"}`}>
                    <span className="sr-only">{source.readAt ? "Read" : "Unread"}: </span>
                    {sourceHref ? (
                      <a {...sourceHref} onClick={(event) => { stop(event); handlers.onOpened(source.id); }}>{source.title.trim() || "(untitled)"}</a>
                    ) : <span>{source.title.trim() || "(untitled)"}</span>}
                    {" "}from{" "}
                    <InlineFeed feed={sourceFeed} ctl={ctl} view={view} onDragState={handlers.onDragState} />
                  </span>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
      <Frame />
    </article>
  );
}

/* ---------------- empty states ---------------- */

function EmptyMessage({ children }: { children: React.ReactNode }) {
  return <div className="empty-state" role="status">{children}</div>;
}

export function EmptyState({ ctl, data, view, onManage, onFocusSearch }: {
  ctl: ReaderController; data: ReaderView; view: ViewState;
  onManage: (kind: "add-feed" | "import" | "auth-feed" | "edit-feed", feed?: FeedDTO) => void;
  onFocusSearch: () => void;
}) {
  const noFeeds = data.feeds.length === 0;
  if (noFeeds && view.section !== "saved" && view.section !== "search") {
    return (
      <EmptyMessage>
        You are not subscribed to any feeds yet.{" "}
        <TextButton onClick={() => onManage("add-feed")}>New feed…</TextButton>
        <TextButton onClick={() => onManage("import")}>Import OPML…</TextButton>
      </EmptyMessage>
    );
  }
  switch (view.section) {
    case "hot":
      if (view.hotRange < 7) return <EmptyMessage>Nothing to report for this time period. Try the <TextButton onClick={() => ctl.setHotWindow(0, 7)}>past week starting now</TextButton></EmptyMessage>;
      if (view.hotRange < 31) return <EmptyMessage>Nothing to report for this time period. Try the <TextButton onClick={() => ctl.setHotWindow(0, 31)}>past month starting now</TextButton></EmptyMessage>;
      return <EmptyMessage>Try subscribing to more feeds with overlapping focuses to increase Fever&rsquo;s effectiveness. <TextButton onClick={() => onManage("add-feed")}>New feed…</TextButton></EmptyMessage>;
    case "search":
      if (!view.search) return <EmptyMessage>Please enter a search term. <TextButton onClick={onFocusSearch}>Search…</TextButton></EmptyMessage>;
      return <EmptyMessage>No items matched your search for &ldquo;{view.search}&rdquo;. <TextButton onClick={ctl.clearSearch}>Clear search</TextButton></EmptyMessage>;
    case "saved":
      return <EmptyMessage>There are no saved items. Save an item with the plus icon beside its title, or press S.</EmptyMessage>;
    default: {
      const label = view.feedId ? "feed" : "group";
      const feed = view.feedId ? data.feeds.find((row) => row.id === view.feedId) : undefined;
      if (feed?.requiresAuth) {
        return <EmptyMessage>This feed requires authentication. <TextButton onClick={() => onManage("auth-feed", feed)}>Authenticate feed…</TextButton></EmptyMessage>;
      }
      if (!view.showRead) {
        return (
          <EmptyMessage>
            There are no unread items in this {label}.{" "}
            <TextButton onClick={ctl.toggleRead}>Show read</TextButton>
            <TextButton onClick={() => (feed ? ctl.refreshFeed(feed.id) : ctl.refreshGroup(view.section === "kindling" ? view.groupId : 0))}>Refresh {label}</TextButton>
          </EmptyMessage>
        );
      }
      if (feed) {
        if (feedRefreshFailed(feed)) {
          return (
            <EmptyMessage>
              The last refresh of this feed failed: {feed.lastError}{" "}
              <TextButton onClick={() => ctl.refreshFeed(feed.id)}>Refresh feed</TextButton>
              <TextButton onClick={() => onManage("edit-feed", feed)}>Edit feed…</TextButton>
            </EmptyMessage>
          );
        }
        return <EmptyMessage>There are no items in this feed. It may not have been updated in the past {data.preferences.itemExpiration} weeks. <TextButton onClick={() => ctl.refreshFeed(feed.id)}>Refresh feed</TextButton></EmptyMessage>;
      }
      if (scopeFeeds(data, view, []).length > 0) {
        return <EmptyMessage>There are no items in this group. <TextButton onClick={() => ctl.refreshGroup(view.section === "kindling" ? view.groupId : 0)}>Refresh group</TextButton></EmptyMessage>;
      }
      return <EmptyMessage>There are no feeds in this {view.section === "sparks" ? "section" : "group"}. <TextButton onClick={() => onManage("add-feed")}>New feed…</TextButton></EmptyMessage>;
    }
  }
}

/* ---------------- the pane ---------------- */

export function ContentPane({ ctl, store, data, view, list, focus, sourceFocus, expanded, handlers, onManage, onFocusSearch }: {
  ctl: ReaderController; store: ReaderStore; data: ReaderView; view: ViewState; list: ListState;
  focus: string; sourceFocus: number; expanded: Record<string, boolean>; handlers: BoxHandlers;
  onManage: (kind: "add-feed" | "import" | "auth-feed" | "edit-feed", feed?: FeedDTO) => void;
  onFocusSearch: () => void;
}) {
  const feedsById = new Map(data.feeds.map((feed) => [feed.id, feed]));
  const isFull = (boxId: string, feed: FeedDTO | undefined, forceExcerptDefault = false) => {
    const toggled = expanded[boxId];
    if (toggled !== undefined) return toggled;
    if (forceExcerptDefault) return false;
    return resolveOption("itemExcerpts", data.preferences, view, data.groups, feed) === 0;
  };
  const empty = view.section === "hot" ? list.links.length === 0 : list.items.length === 0;
  const scopeLabel = view.feedId ? "feed" : view.section === "sparks" ? "Sparks" : "group";

  if (store.viewError && empty) {
    return (
      <div className="empty-state error" role="alert">
        {store.viewError} <TextButton onClick={() => void store.reload()}>Try again</TextButton>
      </div>
    );
  }
  if (store.loading && empty) return <div className="empty-state loading" role="status">Loading…</div>;
  if (empty) return <EmptyState ctl={ctl} data={data} view={view} onManage={onManage} onFocusSearch={onFocusSearch} />;

  return (
    <>
      {store.viewError ? (
        <div className="status notice error inline" role="alert">
          <div className="content">{store.viewError} <button type="button" className="link-button" onClick={() => void store.reload()}>Try again</button></div><s aria-hidden="true" />
        </div>
      ) : null}
      {view.section === "hot" ? (
        groupLinksByTemperature(list.links, formatTemperature).map(({ degree, links }) => (
          <section className="degree" key={`${degree}-${links[0].id}`} aria-label={`${degree} degrees`}>
            <div className="notches" aria-hidden="true"><b /></div>
            <Degree degree={degree} />
            {links.map((link) => {
              const boxId = `link-${link.id}`;
              return (
                <LinkBox key={link.id} link={link} ctl={ctl} view={view} data={data} focused={focus === boxId} sourceFocus={sourceFocus}
                  full={isFull(boxId, feedsById.get(link.feedId), true)} handlers={handlers} />
              );
            })}
          </section>
        ))
      ) : (
        list.items.map((item) => {
          const boxId = `item-${item.id}`;
          const feed = feedsById.get(item.feedId);
          return (
            <ItemBox key={item.id} item={item} feed={feed} ctl={ctl} view={view} data={data} focused={focus === boxId}
              full={isFull(boxId, feed)} handlers={handlers} />
          );
        })
      )}
      <div className="paging" aria-live="polite">
        {list.hasMore ? (
          store.pageError ? (
            <div className="status notice error inline" role="alert"><div className="content">{store.pageError} <button type="button" className="link-button" onClick={() => void store.loadNextPage()}>Try again</button></div><s aria-hidden="true" /></div>
          ) : store.pageLoading ? (
            <div className="status inline" role="status"><div className="content">Loading more…</div><s aria-hidden="true" /></div>
          ) : (
            <button type="button" id="load-more" className="status inline" onClick={() => void store.loadNextPage()}><span className="content">Load more</span><s aria-hidden="true" /></button>
          )
        ) : (view.section === "kindling" || view.section === "sparks") && ctl.activeScope() ? (
          <button type="button" id="inline-read" onClick={() => { ctl.markActiveRead(); window.scrollTo(0, 0); }}>
            Mark {scopeLabel} as read<s aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </>
  );
}
