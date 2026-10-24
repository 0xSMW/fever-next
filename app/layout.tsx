import type { Metadata, Viewport } from "next";
import "./globals.css";
import Providers from "./providers";
import { assetCssVariables, assetPath } from "@/lib/client/assets";
import { CustomStyles } from "@/components/reader/CustomStyles";

// Operator stylesheets are off unless FEVER_CUSTOM_CSS is exactly "1" (docs/CUSTOM_STYLES.md).
// The value is read when a page renders; prerendered pages read it at build time.
const customCss = process.env.FEVER_CUSTOM_CSS === "1";

export const metadata: Metadata = {
  title: "Fever°",
  description: "Fever, a self-hosted feed reader.",
  applicationName: "Fever",
  robots: { index: false, follow: false },
  referrer: "strict-origin-when-cross-origin",
  // The scaffold file-based favicon is retired; original Fever artwork owns these links.
  icons: {
    icon: [{ url: assetPath("/fever/images/favicon.png"), type: "image/png" }],
    shortcut: [{ url: assetPath("/fever/images/favicon.png"), type: "image/png" }],
    apple: [
      { url: assetPath("/fever/images/webclip.png") },
      { url: assetPath("/fever/images/webclip-ipad.png"), sizes: "72x72" },
      { url: assetPath("/fever/images/webclip@2x.png"), sizes: "114x114" },
      { url: assetPath("/fever/images/webclip-ipad@2x.png"), sizes: "144x144" },
    ],
  },
  appleWebApp: { capable: true, title: "Fever", statusBarStyle: "black" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#e9e9e9",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <head>
        {/* Base-path-aware URLs for the original Fever artwork (static, no user data). */}
        <style id="fever-assets" dangerouslySetInnerHTML={{ __html: assetCssVariables() }} />
        {customCss ? <CustomStyles /> : null}
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
