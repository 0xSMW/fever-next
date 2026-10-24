"use client";
import { type ReactNode, type TouchEvent, useEffect, useRef, useState } from "react";
import type { FeedDTO, HotLinkDTO, ItemDTO, ReaderView, ViewState } from "@/lib/contracts";
import { HOT_RANGE_OPTIONS, HOT_START_OPTIONS, ago, feedTitle, formatTemperature, groupTitle, pluralize, ucfirst, widont } from "@/lib/client/format";
import { htmlToText, safeUrl } from "@/lib/client/safe-html";
import { shareExcerpt } from "@/lib/client/services";
import { ArticleContent, Highlight } from "../ArticleContent";
import {
  STATE_LABELS, feedCount, feedCountLabel, feedRefreshFailed, groupLinksByTemperature, groupUnread, groupUnreadCountsVisible, itemStateClass,
  kindlingUnread, resolveOption, scopeTotal, showsCounts, sortedGroups, visibleScopeFeeds,
} from "../model";
import { Favicon, useDialogFocus } from "../ui";

export function Header({ back, onBack, title, titleClass = "", right, spinning }: {
  back?: string; onBack?: () => void; title: string; titleClass?: string; right?: ReactNode; spinning?: boolean;
}) {
  return (
    <header className="header">
      <div className="left">
        {back && onBack ? <button type="button" className={`btn back${spinning ? " spinning" : ""}`} onClick={onBack} aria-label={`Back to ${back}`}>{back}</button> : null}
      </div>
      <h1 className={`title ${titleClass}`.trim()}>{title}</h1>
      <div className="right">{right}</div>
    </header>
  );
}

/* ---------------- groups ---------------- */

export function GroupsScreen({ data, view, now, refreshing, onSection, onGroup, onSearch, onPreferences, onRefresh, onCancelRefresh, onLogout }: {
  data: ReaderView; view: ViewState; now: number; refreshing: string | null;
  onSection: (section: "hot" | "saved" | "sparks") => void; onGroup: (id: number) => void; onSearch: (term: string) => void;
  onPreferences: () => void; onRefresh: () => void; onCancelRefresh: () => void; onLogout: () => void;
}) {
  const [query, setQuery] = useState(view.search);
  const kindling = kindlingUnread(data.feeds);
  const rowClass = (unread: number, countsVisible: boolean) => `${unread ? "unread" : "read"}${countsVisible ? "" : " hide-unread"}`;
  return (
    <div id="fever" className={view.showRead ? undefined : "hide-read"}>
      <header className="header">
        <div className={`left logo${refreshing ? " spinning" : ""}`} aria-hidden="true" />
        <h1 className="title">Fever</h1>
        <div className="right"><button type="button" className="btn action" onClick={onPreferences} aria-label="Preferences">Preferences</button></div>
      </header>
      <div className="box">
        <ul className="list">
          <li id="section-0"><button type="button" onClick={() => onSection("hot")}>Hot</button></li>
          <li id="group-0" className={rowClass(kindling, groupUnreadCountsVisible(data.preferences, null))}>
            <button type="button" onClick={() => onGroup(0)}>Kindling{kindling ? <span className="sr-only">, {kindling} unread</span> : null}</button>
            <span className="unread-count" aria-hidden="true">{kindling}</span>
          </li>
          {sortedGroups(data.groups).map((group) => {
            const unread = groupUnread(group, data.feeds);
            return (
              <li key={group.id} id={`group-${group.id}`} className={rowClass(unread, groupUnreadCountsVisible(data.preferences, group))}>
                <button type="button" onClick={() => onGroup(group.id)}>{groupTitle(group)}{unread ? <span className="sr-only">, {unread} unread</span> : null}</button>
                <span className="unread-count" aria-hidden="true">{unread}</span>
              </li>
            );
          })}
          <li id="section-2" className={data.savedCount ? "unread" : "read"}>
            <button type="button" onClick={() => onSection("saved")}>Saved<span className="sr-only">, {data.savedCount} saved</span></button>
            <span className="saved-count" aria-hidden="true">{data.savedCount}</span>
          </li>
          <li id="section-3"><button type="button" onClick={() => onSection("sparks")}>Sparks</button></li>
          <li id="section-4">
            <form role="search" onSubmit={(event) => { event.preventDefault(); (document.activeElement as HTMLElement | null)?.blur(); onSearch(query); }}>
              <label htmlFor="mq" className="sr-only">Search</label>
              <input id="mq" type="search" value={query} onChange={(event) => setQuery(event.target.value)} enterKeyHint="search" placeholder="Search" />
            </form>
          </li>
        </ul>
      </div>
      <footer className="footer">
        <div className="left" role="status">
          {refreshing ?? <>Last refreshed <strong>{data.feeds.length}</strong> {pluralize(data.feeds.length, "feed")} <strong>{ago(data.lastRefreshedAt, now).toLowerCase()}</strong></>}
        </div>
        <div className="right">
          {refreshing
            ? <button type="button" className="btn" onClick={onCancelRefresh}>Cancel</button>
            : <button type="button" className="btn" onClick={onRefresh}>Refresh</button>}{" "}
          <button type="button" className="btn logout" onClick={onLogout}>Logout</button>
        </div>
      </footer>
    </div>
  );
}

/* ---------------- feeds ---------------- */

export function FeedsScreen({ data, view, title, titleClass, onBack, onFeed }: {
  data: ReaderView; view: ViewState; title: string; titleClass: string; onBack: () => void; onFeed: (id: number) => void;
}) {
  const feeds = visibleScopeFeeds(data, view);
  const label = feedCountLabel(view);
  const total = scopeTotal(data, view, feeds);
  const counted = showsCounts(data, label);
  return (
    <div id="feeds">
      <Header back="Fever" onBack={onBack} title={title} titleClass={titleClass} />
      <div className="box">
        <ul className="list">
          <li id="feed-0" className={total || label !== "unread" ? "unread" : "read"}>
            <button type="button" onClick={() => onFeed(0)}>All items</button>
            {counted ? <span className={`${label}-count`}>{total}</span> : null}
          </li>
          {feeds.map((feed) => {
            const count = feedCount(data, label, feed);
            const visible = label === "saved" || resolveOption("unreadCounts", data.preferences, view, data.groups, feed) === 1;
            const failed = feedRefreshFailed(feed);
            return (
              <li key={feed.id} id={`feed-${feed.id}`} className={`${label === "unread" && !feed.unreadCount ? "read" : "unread"}${visible ? "" : " hide-unread"}${failed ? " has-error" : ""}`}>
                <button type="button" onClick={() => onFeed(feed.id)}>
                  <Favicon feed={feed} /> {feedTitle(feed)}
                  {feed.requiresAuth ? <span className="sr-only">, requires authentication</span> : null}
                  {failed ? <span className="sr-only">, last refresh failed</span> : null}
                </button>
                {counted ? <span className={`${label}-count`} aria-hidden="true">{count}</span> : null}
              </li>
            );
          })}
          {!feeds.length ? <li className="empty-row">No feeds to show.</li> : null}
        </ul>
      </div>
    </div>
  );
}

/* ---------------- items ---------------- */

export function ItemsScreen({ data, view, items, back, title, onBack, onItem, loading, pageLoading, hasMore, error, pageError, onRetry, onMore, empty }: {
  data: ReaderView; view: ViewState; items: ItemDTO[]; back: string; title: string; onBack: () => void; onItem: (item: ItemDTO) => void;
  loading: boolean; pageLoading: boolean; hasMore: boolean; error: string | null; pageError: string | null;
  onRetry: () => void; onMore: () => void; empty: ReactNode;
}) {
  const feedsById = new Map(data.feeds.map((feed) => [feed.id, feed]));
  const highlight = view.section === "search" ? view.search : undefined;
  return (
    <div id="items">
      <Header back={back} onBack={onBack} title={title} spinning={loading} />
      {error && !items.length ? <div className="box message" role="alert"><p>{error}</p><button type="button" className="btn" onClick={onRetry}>Try again</button></div> : null}
      {loading && !items.length && !error ? <div className="box message" role="status"><p>Loading…</p></div> : null}
      {!loading && !error && !items.length ? <div className="box message">{empty}</div> : null}
      {items.length ? (
        <div className="box">
          <ul className="list">
            {items.map((item) => {
              const state = itemStateClass(item);
              const feed = feedsById.get(item.feedId);
              return (
                <li key={item.id} id={`item-${item.id}`} className={state === "new" ? "new unread" : state}>
                  <button type="button" className={`feed-${item.feedId}`} onClick={() => onItem(item)}>
                    <Favicon feed={feed} /> <span className="sr-only">{STATE_LABELS[state]}: </span>
                    <Highlight text={widont(item.title.trim() || "(untitled)")} term={highlight} />
                  </button>
                  <div className="item-content" aria-hidden="true">{item.excerpt}</div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      <Paging hasMore={hasMore} loading={pageLoading} error={pageError} onMore={onMore} />
    </div>
  );
}

function Paging({ hasMore, loading, error, onMore }: { hasMore: boolean; loading: boolean; error: string | null; onMore: () => void }) {
  if (!hasMore) return null;
  return (
    <div className="paging" aria-live="polite">
      {error ? <p role="alert">{error}</p> : null}
      <button type="button" className={`btn${loading ? " spinning" : ""}`} onClick={onMore} disabled={loading}>{loading ? "Loading…" : error ? "Try again" : "Load more"}</button>
    </div>
  );
}

/* ---------------- hot ---------------- */

function MobileDegree({ degree }: { degree: string }) {
  const chars = `${degree}°`.split("");
  return (
    <div className="tmp" aria-label={`${degree} degrees`} role="img">
      {chars.map((char, index) => (
        <span key={index} className={`num ${char === "." ? "np" : char === "°" ? "nd" : `n${char}`}`} aria-hidden="true">{char}</span>
      ))}
    </div>
  );
}

export function HotScreen({ data, view, links, onBack, onWindow, onItem, onExternal, loading, pageLoading, hasMore, error, pageError, onRetry, onMore, empty }: {
  data: ReaderView; view: ViewState; links: HotLinkDTO[]; onBack: () => void; onWindow: (start: number, range: number) => void;
  onItem: (itemId: number, linkId: number) => void; onExternal: (url: string, itemId?: number) => void;
  loading: boolean; pageLoading: boolean; hasMore: boolean; error: string | null; pageError: string | null;
  onRetry: () => void; onMore: () => void; empty: ReactNode;
}) {
  const feedsById = new Map(data.feeds.map((feed) => [feed.id, feed]));
  const degrees = groupLinksByTemperature(links, formatTemperature);
  return (
    <div id="hot">
      <Header back="Fever" onBack={onBack} title="Hot" spinning={loading} />
      <div className="control">
        <form onSubmit={(event) => event.preventDefault()}>
          <label htmlFor="menu-hot-range">Links from the past</label>{" "}
          <span className="btn menu">
            <select id="menu-hot-range" value={view.hotRange} onChange={(event) => onWindow(view.hotStart, Number(event.target.value))}>
              {HOT_RANGE_OPTIONS.filter(Boolean).map((entry) => <option key={entry![0]} value={entry![0]}>{entry![1]}</option>)}
            </select>
          </span>{" "}
          <label htmlFor="menu-hot-start">starting</label>{" "}
          <span className="btn menu">
            <select id="menu-hot-start" value={view.hotStart} onChange={(event) => onWindow(Number(event.target.value), view.hotRange)}>
              {HOT_START_OPTIONS.filter(Boolean).map((entry) => <option key={entry![0]} value={entry![0]}>{entry![1]}</option>)}
            </select>
          </span>
        </form>
      </div>
      {error && !links.length ? <div className="box message" role="alert"><p>{error}</p><button type="button" className="btn" onClick={onRetry}>Try again</button></div> : null}
      {loading && !links.length && !error ? <div className="box message" role="status"><p>Loading…</p></div> : null}
      {!loading && !error && !links.length ? <div className="box message">{empty}</div> : null}
      {degrees.map(({ degree, links: group }) => (
        <section className="box degree" key={`${degree}-${group[0].id}`}>
          <MobileDegree degree={degree} />
          {group.map((link) => {
            const anItem = link.isItem && link.isLocal;
            const feed = feedsById.get(link.feedId);
            return (
              <div className="link" id={`link-${link.id}`} key={link.id}>
                <h2 className="link-title">
                  {anItem
                    ? <button type="button" onClick={() => onItem(link.itemId, link.id)}>{widont(link.title.trim() || link.url)}</button>
                    : <button type="button" onClick={() => onExternal(link.url, link.isItem ? link.itemId : undefined)}>{widont(link.title.trim() || link.url)}</button>}
                </h2>
                {anItem ? (
                  <>
                    <p className="link-from"><Favicon feed={feed} /> <span>from</span> {feedTitle(feed)}</p>
                    {link.html ? <div className="item-content">{shareExcerpt(htmlToText(link.html))}</div> : null}
                  </>
                ) : null}
                {link.sources.length ? (
                  <ul className="source-list">
                    {link.sources.map((source) => (
                      <li key={source.id} className={`${source.readAt ? "read" : "unread"} item-${source.id}`}>
                        <button type="button" className={`feed-${source.feedId}`} onClick={() => onItem(source.id, link.id)}>
                          <Favicon feed={feedsById.get(source.feedId)} />
                          <span className="sr-only">{source.readAt ? "Read" : "Unread"}: </span>
                          {source.title.trim() || "(untitled)"}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            );
          })}
        </section>
      ))}
      <Paging hasMore={hasMore} loading={pageLoading} error={pageError} onMore={onMore} />
    </div>
  );
}

/* ---------------- article ---------------- */

const SWIPE_BASELINE = 150;

export function ArticleScreen({ item, feed, back, onBack, preferences, highlight, onToggleSave, onPrevious, onNext, hasPrevious, hasNext, nextLoading, onOpenExternal, onContentLink }: {
  item: ItemDTO; feed: FeedDTO | undefined; back: string; onBack: () => void;
  preferences: ReaderView["preferences"]; highlight?: string;
  onToggleSave: () => void; onPrevious: () => void; onNext: () => void; hasPrevious: boolean; hasNext: boolean; nextLoading: boolean;
  onOpenExternal: (url: string) => void; onContentLink: (url: string) => boolean;
}) {
  const state = itemStateClass(item);
  const touch = useRef<{ x: number; y: number; scrollable: boolean } | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { headingRef.current?.focus({ preventScroll: true }); }, [item.id]);

  const onTouchStart = (event: TouchEvent) => {
    const point = event.touches[0];
    const target = event.target as HTMLElement;
    // Horizontal scrolling inside wide content (tables, code) is not a swipe.
    const scroller = target.closest("pre, table, .item-content div, figure");
    const scrollable = Boolean(scroller && (scroller as HTMLElement).scrollWidth > (scroller as HTMLElement).clientWidth);
    touch.current = { x: point.clientX, y: point.clientY, scrollable };
  };
  const onTouchEnd = (event: TouchEvent) => {
    const start = touch.current;
    touch.current = null;
    if (!start || start.scrollable) return;
    const point = event.changedTouches[0];
    const dx = point.clientX - start.x;
    const dy = point.clientY - start.y;
    // Source baseline is 150px; narrow screens use 40% of the width when smaller.
    const threshold = Math.min(SWIPE_BASELINE, window.innerWidth * 0.4);
    if (Math.abs(dx) < threshold || Math.abs(dy) > Math.abs(dx)) return;
    if (dx < 0 && hasNext) onNext();
    else if (dx > 0 && hasPrevious) onPrevious();
  };

  return (
    <div id="item" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      <Header back={back} onBack={onBack} title={item.title.trim() || "(untitled)"} titleClass="unread" />
      <article className={`box item ${state}`} aria-labelledby="article-title">
        <div className="meta">
          <h1 id="article-title" tabIndex={-1} ref={headingRef}>
            <a href={safeUrl(item.url) ?? undefined} onClick={(event) => { event.preventDefault(); onOpenExternal(item.url); }}>
              <Highlight text={widont(item.title.trim() || "(untitled)")} term={highlight} />
            </a>
          </h1>
          <h2>
            <span className="feed-name"><Favicon feed={feed} /> {feedTitle(feed)}</span>
            <span className="posted">{ucfirst(ago(item.publishedAt))}{item.author ? ` by ${item.author}` : ""}</span>
          </h2>
          <button type="button" className="state" aria-pressed={item.isSaved} aria-label={item.isSaved ? "Saved. Unsave this item" : `${STATE_LABELS[state]}. Save this item`} onClick={onToggleSave}>
            {item.isSaved ? "Saved" : "Save"}
          </button>
        </div>
        {/* List and detail DTOs carry the complete html; empty means the item has no content. */}
        <ArticleContent html={item.html} preferences={preferences} highlight={highlight} onLinkClick={onContentLink} />
      </article>
      <footer className="footer article-nav">
        <div className="left">
          {hasPrevious ? <button type="button" className="btn back" id="prev-item" onClick={onPrevious}>Previous</button> : null}
        </div>
        <div className="right">
          {hasNext || nextLoading ? <button type="button" className={`btn forward${nextLoading ? " spinning" : ""}`} id="next-item" onClick={onNext} disabled={nextLoading}>Next</button> : null}
        </div>
      </footer>
    </div>
  );
}

/* ---------------- embedded view ---------------- */

export function WebviewScreen({ url, anonymize, onBack, onOpenExternal }: { url: string; anonymize: boolean; onBack: () => void; onOpenExternal: () => void }) {
  // Both flags belong to one address, so a new url starts unloaded and not slow.
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [slowUrl, setSlowUrl] = useState<string | null>(null);
  const loaded = loadedUrl === url;
  const slow = slowUrl === url;
  useEffect(() => {
    const timer = setTimeout(() => setSlowUrl(url), 8000);
    return () => clearTimeout(timer);
  }, [url]);
  return (
    <div id="webview">
      <Header back="Back" onBack={onBack} title="Elsewhere" titleClass={loaded ? "" : "spinning"}
        right={<button type="button" className="btn safari" onClick={onOpenExternal}>Open in browser</button>} />
      <p className="webview-note" role="status">
        {slow && !loaded ? "This site is slow to load or does not allow viewing inside Fever. " : "Some sites do not allow viewing inside Fever. "}
        <button type="button" className="link-button" onClick={onOpenExternal}>Open in browser</button>
      </p>
      <iframe
        id="iframe"
        title="External page"
        src={url}
        sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms"
        referrerPolicy={anonymize ? "no-referrer" : "strict-origin-when-cross-origin"}
        allow=""
        onLoad={() => setLoadedUrl(url)}
      />
    </div>
  );
}

/* ---------------- preferences ---------------- */

export interface MobileSettings { showRead: boolean; showFeeds: boolean; }

export function MobilePreferences({ settings, preferences, onChangeSettings, onSavePreferences, onUndo, onAllPreferences, onDesktop, onLogout, onClose }: {
  settings: MobileSettings; preferences: ReaderView["preferences"];
  onChangeSettings: (next: MobileSettings) => void;
  onSavePreferences: (patch: Partial<Pick<ReaderView["preferences"], "mobileReadOnScroll" | "mobileReadOnBackOut" | "mobileViewInApp">>) => Promise<void>;
  onUndo: () => void; onAllPreferences: () => void; onDesktop: () => void; onLogout: () => void; onClose: () => void;
}) {
  const [local, setLocal] = useState({
    mobileReadOnScroll: preferences.mobileReadOnScroll,
    mobileReadOnBackOut: preferences.mobileReadOnBackOut,
    mobileViewInApp: preferences.mobileViewInApp,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = local.mobileReadOnScroll !== preferences.mobileReadOnScroll || local.mobileReadOnBackOut !== preferences.mobileReadOnBackOut || local.mobileViewInApp !== preferences.mobileViewInApp;

  /** dismissPreferences: save on close. */
  const close = async () => {
    if (!dirty) { onClose(); return; }
    setSaving(true);
    setError(null);
    try { await onSavePreferences(local); onClose(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Preferences could not be saved."); setSaving(false); }
  };

  const dialogRef = useDialogFocus(() => void close());

  const check = (id: string, label: string, checked: boolean, onChange: (value: boolean) => void) => (
    <li>
      <label htmlFor={id} className={`checkbox${checked ? " checked" : ""}`}>
        <input type="checkbox" id={id} checked={checked} onChange={(event) => onChange(event.target.checked)} />
        {label}
      </label>
    </li>
  );

  return (
    <div id="dialog-container" className="open" role="dialog" aria-modal="true" aria-labelledby="mobile-prefs-title">
      <div className="box">
        <div id="dialog" ref={dialogRef}>
          <h1 id="mobile-prefs-title">Preferences</h1>
          <button type="button" className="close" onClick={() => void close()} aria-label="Close preferences">Close</button>
          <ul>
            {check("action-show-read", "Show read", settings.showRead, (value) => onChangeSettings({ ...settings, showRead: value }))}
            {check("action-show-feeds", "Show feeds", settings.showFeeds, (value) => onChangeSettings({ ...settings, showFeeds: value }))}
            {check("action-elsewhere", "View external links in app", local.mobileViewInApp, (value) => setLocal({ ...local, mobileViewInApp: value }))}
          </ul>
          <h2>Mark as read on</h2>
          <ul id="action-mark-as-read">
            {check("action-read-scroll", "scroll past headline", local.mobileReadOnScroll, (value) => setLocal({ ...local, mobileReadOnScroll: value }))}
            {check("action-read-back", "back out of group/feed", local.mobileReadOnBackOut, (value) => setLocal({ ...local, mobileReadOnBackOut: value }))}
          </ul>
          {error ? <p role="alert" className="dialog-error">{error}</p> : null}
          <button type="button" className="btn" onClick={onUndo}>Unread most recently read</button>
          <button type="button" className="btn" onClick={onAllPreferences}>All preferences…</button>
          <button type="button" className="btn" onClick={onDesktop}>Desktop layout</button>
          <button type="button" className="btn" onClick={onLogout}>Logout</button>
          <button type="button" className="btn default" onClick={() => void close()} disabled={saving}>{saving ? "Saving…" : "Done"}</button>
        </div>
      </div>
    </div>
  );
}
