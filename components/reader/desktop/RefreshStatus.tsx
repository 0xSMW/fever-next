"use client";
import type { ReaderView, RefreshJobDTO } from "@/lib/contracts";
import { ago, pluralize } from "@/lib/client/format";
import type { Notice } from "../useReader";
import { Favicon } from "../ui";

interface Props {
  data: ReaderView;
  job: RefreshJobDTO | null;
  error: string | null;
  now: number;
  notice: Notice | null;
  freshCount: number;
  onRefresh: () => void;
  onCancel: () => void;
  onShowFresh: () => void;
  onDismissNotice: () => void;
}

/** #status: the refreshed line, the refreshing thermometer, and notices. */
export function RefreshStatus({ data, job, error, now, notice, freshCount, onRefresh, onCancel, onShowFresh, onDismissNotice }: Props) {
  const active = job && (job.status === "queued" || job.status === "running");
  const total = active ? Math.max(job.totalFeeds, 0) : data.feeds.length;
  const done = active ? Math.min(job.completedFeeds, total || job.completedFeeds) : 0;
  const percent = active && total ? Math.floor((done / total) * 100) : 0;
  const currentFeed = active && job.currentFeedId ? data.feeds.find((feed) => feed.id === job.currentFeedId) : undefined;

  return (
    <div id="status">
      {!active ? (
        <div id="refreshed" className="status">
          <div className="content" role="status">
            <button type="button" className="btn refresh" aria-label="Refresh all feeds" title="Refresh all feeds" onClick={onRefresh}>Refresh</button>
            Last refreshed <strong id="total-feeds">{data.feeds.length}</strong> {pluralize(data.feeds.length, "feed")}{" "}
            <strong id="last-refresh" className="timestamp">{ago(data.lastRefreshedAt, now).toLowerCase()}</strong>
          </div>
          <s aria-hidden="true" />
        </div>
      ) : (
        <div id="refreshing" className="active">
          <div className="status">
            <div className="content" role="status">
              <span id="refreshing-feed">
                {job.status === "queued" ? "Waiting to refresh " : "Refreshing "}
                <strong>{currentFeed ? <Favicon feed={currentFeed} /> : <i className="favicon icon" aria-hidden="true"><i /></i>} {job.currentFeedTitle || currentFeed?.title || pluralize(total, "feed")}</strong>
              </span>
              <button type="button" className="btn cancel" aria-label="Cancel refresh" title="Cancel refresh" onClick={onCancel}>Cancel</button>
            </div>
            <s aria-hidden="true" />
          </div>
          <div className="thermometer" role="progressbar" aria-label="Refresh progress" aria-valuemin={0} aria-valuemax={total || 1} aria-valuenow={done}
            aria-valuetext={total ? `${done} of ${total} feeds` : "Starting"}>
            <div className="groove">
              <div id="mercury" style={{ height: `${percent}%` }}>
                <div className="label"><strong id="x-feeds">{done}</strong> of <span id="y-feeds">{total}</span></div>
              </div>
            </div>
            <u /><b />
          </div>
        </div>
      )}

      {!active && job?.status === "failed" ? (
        <div className="status notice error" role="alert">
          <div className="content">The last refresh failed{job.error ? `: ${job.error}` : "."} <button type="button" className="link-button" onClick={onRefresh}>Try again</button></div>
          <s aria-hidden="true" />
        </div>
      ) : null}
      {!active && job?.status === "cancelled" && job.finishedAt && now / 1000 - job.finishedAt < 120 ? (
        <div className="status notice" role="status">
          <div className="content">Refresh cancelled after {job.completedFeeds} of {job.totalFeeds} {pluralize(job.totalFeeds, "feed")}.</div>
          <s aria-hidden="true" />
        </div>
      ) : null}
      {error ? (
        <div className="status notice error" role="alert">
          <div className="content">{error}</div>
          <s aria-hidden="true" />
        </div>
      ) : null}
      {freshCount > 0 ? (
        <div className="status notice" role="status">
          <div className="content">{freshCount} new {pluralize(freshCount, "item")}. <button type="button" className="link-button" onClick={onShowFresh}>Show</button></div>
          <s aria-hidden="true" />
        </div>
      ) : null}
      {notice ? (
        <div className={`status notice${notice.kind === "error" ? " error" : ""}`} role={notice.kind === "error" ? "alert" : "status"}>
          <div className="content">
            {notice.text}
            {notice.action ? <> <button type="button" className="link-button" onClick={() => { onDismissNotice(); notice.action?.(); }}>{notice.actionLabel ?? "Retry"}</button></> : null}
            <button type="button" className="btn cancel notice-dismiss" aria-label="Dismiss" onClick={onDismissNotice}>Dismiss</button>
          </div>
          <s aria-hidden="true" />
        </div>
      ) : null}
    </div>
  );
}
