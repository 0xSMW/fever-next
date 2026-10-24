"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionDTO } from "@/lib/contracts";
import { apiGet } from "@/lib/client/api";
import { describeError, type DescribedError } from "./api-errors";

export type SessionState =
  | { status: "loading" }
  | { status: "error"; error: DescribedError }
  | { status: "ready"; session: SessionDTO };

/** GET /api/session with an explicit loading/error state and retry. */
export function useFeverSession(): { state: SessionState; reload: () => void } {
  const [state, setState] = useState<SessionState>({ status: "loading" });
  const controller = useRef<AbortController | null>(null);

  // Replaces any earlier request; only the latest one may set state, and only once it settles.
  const request = useCallback(() => {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    apiGet<SessionDTO>("/api/session", { signal: abort.signal }).then(
      (session) => {
        if (!abort.signal.aborted) setState({ status: "ready", session });
      },
      (error: unknown) => {
        if (!abort.signal.aborted) setState({ status: "error", error: describeError(error, "Fever could not check your session.") });
      },
    );
  }, []);

  // The initial state is already "loading", so the first request needs no reset.
  useEffect(() => {
    request();
    return () => controller.current?.abort();
  }, [request]);

  const reload = useCallback(() => {
    setState({ status: "loading" });
    request();
  }, [request]);

  return { state, reload };
}
