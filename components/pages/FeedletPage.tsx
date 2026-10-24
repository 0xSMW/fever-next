"use client";

import { useState } from "react";
import type { SuppliedFeed } from "./feedlet-candidates";
import { FeedSubscribeFlow } from "./FeedSubscribeFlow";
import { PageShell } from "./PageShell";
import { SessionGate } from "./SessionGate";

interface FeedletPageProps {
  mode: "feedlet" | "subscribe";
  /** App-relative path including the query, for login continuation. */
  returnTo: string;
  initialUrl: string | null;
  pageTitle?: string;
  supplied?: SuppliedFeed[];
  rejected?: number;
}

export function FeedletPage({ mode, returnTo, initialUrl, pageTitle, supplied, rejected }: FeedletPageProps) {
  const [heading, setHeading] = useState(mode === "feedlet" ? "Subscribe to feeds on this page" : "Add a feed by address");
  return (
    <PageShell title={mode === "feedlet" ? "Feedlet" : "Subscribe"} subtitle={heading} width="wide">
      <SessionGate
        returnTo={returnTo}
        loginReason={mode === "feedlet" ? "Log in to subscribe to feeds from this page. You will come straight back here." : "Log in to confirm this subscription. You will come straight back here."}
      >
        {() => (
          <FeedSubscribeFlow
            mode={mode}
            initialUrl={initialUrl}
            pageTitle={pageTitle}
            supplied={supplied}
            rejected={rejected}
            onHeading={setHeading}
          />
        )}
      </SessionGate>
    </PageShell>
  );
}
