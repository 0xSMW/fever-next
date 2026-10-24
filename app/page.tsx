import ReaderApp from "@/components/reader/ReaderApp";

/**
 * The reader is a client application: it checks /api/session and loads
 * authenticated data through the API, so this page imports no server modules.
 */
export default function Home() {
  return (
    <>
      <noscript>
        <div className="fever-boot"><p>Fever needs JavaScript enabled to show your feeds.</p></div>
      </noscript>
      <ReaderApp />
    </>
  );
}
