"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { appHref } from "@/lib/client/api";
import "./pages.css";

export type PageWidth = "narrow" | "wide" | "xwide";

interface PageShellProps {
  /** Large light page heading (source h1). */
  title: ReactNode;
  /** Red subheading (source h2). */
  subtitle?: ReactNode;
  width?: PageWidth;
  /** Show links back to the reader and other help pages in the footer. */
  nav?: boolean;
  children: ReactNode;
}

const widthClass: Record<PageWidth, string> = { narrow: "", wide: " fp-wide", xwide: " fp-xwide" };

/** The source standalone page: one rounded box, then the logo and notice. */
export function PageShell({ title, subtitle, width = "narrow", nav = false, children }: PageShellProps) {
  const year = new Date().getUTCFullYear();
  return (
    <div className={`fp-page${widthClass[width]}`}>
      <a className="fp-skip" href="#fp-main">Skip to content</a>
      <div className="fp-frame">
        <main id="fp-main" className="fp-box" tabIndex={-1}>
          <h1>{title}</h1>
          {subtitle ? <h2>{subtitle}</h2> : null}
          {children}
        </main>
        <footer className="fp-footer">
          {/* eslint-disable-next-line @next/next/no-img-element -- fixed-size preserved source asset */}
          <img
            className="fp-logo"
            src={appHref("/fever/images/logo-fever.png")}
            srcSet={`${appHref("/fever/images/logo-fever.png")} 1x, ${appHref("/fever/images/logo-fever@2x.png")} 2x`}
            width={50}
            height={17}
            alt="Fever"
          />
          Fever &copy; 2007&ndash;{year} Shaun Inman. All rights reserved. Originally available at feedafever.com.
          {nav ? (
            <nav aria-label="Fever pages">
              <Link href="/">Reader</Link>
              <Link href="/extras">Extras</Link>
              <Link href="/shortcuts">Keyboard shortcuts</Link>
            </nav>
          ) : null}
        </footer>
      </div>
    </div>
  );
}
