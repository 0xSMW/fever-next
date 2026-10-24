"use client";

import Link from "next/link";
import { useState } from "react";
import { ManagementDialog } from "@/components/manage/ManagementDialog";
import { appHref } from "@/lib/client/api";
import { CopyField, FeedletBookmarklet, useInstallUrls } from "./FeedletTools";
import { Notice } from "./Status";

/**
 * Onboarding after setup: the source install/info.php "Get started" page
 * (OPML import, Feedlet, subscription URL, Sparks) as separate choices.
 */
export function GetStarted() {
  const urls = useInstallUrls();
  const [dialog, setDialog] = useState<null | "import" | "add-feed">(null);
  const [changed, setChanged] = useState<string | null>(null);

  return (
    <>
      {changed ? <Notice tone="success" live><p>{changed}</p></Notice> : null}

      <section className="fp-section" aria-labelledby="fp-start-feed">
        <h2 id="fp-start-feed">Feed a Fever</h2>
        <p className="fp-text">
          Conventional wisdom be damned, Fever needs fuel to burn. Import your feeds from an existing OPML file, add a
          feed by address, or drag the Feedlet onto your bookmarks bar. The Feedlet lets you subscribe to any feed
          embedded in a page.
        </p>
        <div className="fp-actions fp-start fp-flush">
          <button type="button" className="fp-btn fp-default" onClick={() => setDialog("import")}>Import OPML</button>
          <button type="button" className="fp-btn" onClick={() => setDialog("add-feed")}>Add a feed</button>
          <FeedletBookmarklet />
        </div>
      </section>

      <section className="fp-section" aria-labelledby="fp-start-url">
        <h2 id="fp-start-url">Subscribe from other apps</h2>
        <p>Many browsers and apps can hand a feed address to a reader. Give them this subscription address; the feed address is added to the end. Fever always asks you to confirm before subscribing.</p>
        {urls ? <CopyField label="Subscription URL" value={urls.subscribe} /> : null}
      </section>

      <section className="fp-section" aria-labelledby="fp-start-heat">
        <h2 id="fp-start-heat">Crank up the heat</h2>
        <p>
          In order to get the most out of Fever you need to take advantage of Sparks. Your regular subscriptions are
          like kindling. Sparks are feeds that you subscribe to solely to increase the temperature of the information
          you are most interested in.
        </p>
      </section>

      <div className="fp-actions">
        <Link className="fp-btn" href="/extras">More extras</Link>
        <a className="fp-btn fp-default" href={appHref("/")}>Start reading</a>
      </div>

      {dialog ? (
        <ManagementDialog
          request={{ kind: dialog }}
          onClose={() => setDialog(null)}
          onChanged={() => setChanged(dialog === "import"
            ? "Import finished. Fever is fetching the new feeds in the background."
            : "Feed added. Fever is fetching it in the background.")}
        />
      ) : null}
    </>
  );
}
