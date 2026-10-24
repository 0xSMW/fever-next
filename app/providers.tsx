"use client";
import { SessionProvider } from "next-auth/react";
import { BASE_PATH } from "@/lib/client/api";

/** NextAuth lives at <base path>/api/auth; the reader checks /api/session itself. */
export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider basePath={`${BASE_PATH}/api/auth`} refetchOnWindowFocus={false}>
      {children}
    </SessionProvider>
  );
}
