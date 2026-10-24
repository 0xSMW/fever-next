"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet } from "@/lib/client/api";
import type { ReaderView } from "@/lib/contracts";
import { describeError, type ClientError } from "./errors";

/**
 * Feeds, groups and preferences for a management form. The reader passes its
 * current view, which is reused as-is; a standalone page has none, so the
 * view is read from GET /api/reader?capture=false. `view.feeds` and
 * `view.groups` are complete lists regardless of the current section.
 */
export function useReaderData({ initial, enabled = true }: { initial?: ReaderView; enabled?: boolean } = {}) {
  const [view, setView] = useState<ReaderView | undefined>(initial);
  // A newly passed view replaces the shown one; dropping it keeps the last view shown.
  const [passed, setPassed] = useState(initial);
  if (passed !== initial) {
    setPassed(initial);
    if (initial) setView(initial);
  }
  const fetching = !initial && enabled;
  const [loading, setLoading] = useState(fetching);
  const [error, setError] = useState<ClientError | null>(null);
  // Starting to fetch again (enabled turned on, or the passed view dropped)
  // shows the loading state from the same render the effect starts in.
  const [wasFetching, setWasFetching] = useState(fetching);
  if (wasFetching !== fetching) {
    setWasFetching(fetching);
    if (fetching) {
      setLoading(true);
      setError(null);
    }
  }
  const controller = useRef<AbortController | null>(null);

  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; controller.current?.abort(); };
  }, []);

  // Replaces any earlier request; only the latest one sets state, and only once it settles.
  const fetchView = useCallback(async () => {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    try {
      // capture=false reads without recording a visit: the reading session
      // timestamps and the stored section, group and feed stay as they are.
      const next = await apiGet<ReaderView>("/api/reader?capture=false", { signal: abort.signal });
      if (mounted.current && controller.current === abort && !abort.signal.aborted) {
        setView(next);
        setError(null);
      }
    } catch (caught) {
      if (mounted.current && controller.current === abort && !abort.signal.aborted) setError(describeError(caught, "Your feeds and groups could not be loaded."));
    } finally {
      if (mounted.current && controller.current === abort && !abort.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!fetching) { controller.current?.abort(); return; }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- This starts an abortable read; all setters run after its await.
    void fetchView();
    return () => controller.current?.abort();
  }, [fetching, fetchView]);

  // Retry and post-mutation refresh: show the loading state, then fetch.
  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    return fetchView();
  }, [fetchView]);

  return { view, loading: enabled && loading, error, reload };
}
