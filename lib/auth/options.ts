import type { NextAuthOptions } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { and, eq } from "drizzle-orm";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { installation, owners } from "@/lib/db/schema";
import { consumeDummyPasswordWork, passwordHasSupportedSize, verifyPassword } from "./password";
import { consumeRateLimit } from "./rate-limit";
import { getAuthRuntime, safeRedirect } from "./runtime";
import { normalizeLoginEmail } from "./security";

/** Credentials + signed/encrypted JWTs do not require an ORM account/session adapter. */
export function getAuthOptions(): NextAuthOptions {
  const runtime = getAuthRuntime();
  const maxAge = getConfig().sessionMaxAgeSeconds;
  const cookie = { httpOnly: true, sameSite: "lax" as const, path: runtime.cookiePath, secure: runtime.secure };
  return {
    secret: runtime.secret,
    useSecureCookies: runtime.secure,
    session: { strategy: "jwt", maxAge },
    jwt: { maxAge },
    pages: { signIn: `${runtime.basePath}/login`, error: `${runtime.basePath}/login` },
    cookies: {
      sessionToken: { name: runtime.sessionCookieName, options: cookie },
      callbackUrl: { name: `${runtime.authCookiePrefix}.callback-url`, options: cookie },
      csrfToken: { name: `${runtime.authCookiePrefix}.nextauth-csrf-token`, options: cookie },
    },
    providers: [Credentials({
      name: "Fever",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        // The public NextAuth result is always a generic credentials failure.
        await consumeRateLimit("login");
        if (!credentials || !passwordHasSupportedSize(credentials.password)) return null;
        let emailKey: string;
        try { emailKey = normalizeLoginEmail(credentials.email); } catch { return null; }
        const [owner] = await getDb().select({
          id: owners.id, email: owners.email, passwordHash: owners.passwordHash, authEpoch: owners.authEpoch,
        }).from(owners).innerJoin(installation, eq(installation.id, 1))
          .where(and(eq(owners.emailKey, emailKey), eq(owners.recoveryRequired, false), eq(installation.status, "ready"))).limit(1);
        if (!owner) {
          await consumeDummyPasswordWork(credentials.password);
          return null;
        }
        if (!await verifyPassword(credentials.password, owner.passwordHash)) return null;
        return { id: String(owner.id), email: owner.email, authEpoch: owner.authEpoch };
      },
    })],
    callbacks: {
      async jwt({ token, user }) {
        if (user) {
          token.sub = user.id;
          token.email = user.email;
          token.authEpoch = user.authEpoch;
          token.authenticatedUntil = Math.floor(Date.now() / 1000) + maxAge;
          token.installationUrl = runtime.baseUrl;
          token.revoked = false;
        }
        const id = Number(token.sub);
        if (token.installationUrl !== runtime.baseUrl || !Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(token.authEpoch) ||
            typeof token.authenticatedUntil !== "number" || token.authenticatedUntil <= Math.floor(Date.now() / 1000)) {
          return { ...token, revoked: true, sub: undefined, email: undefined };
        }
        const [owner] = await getDb().select({ email: owners.email }).from(owners)
          .innerJoin(installation, eq(installation.id, 1))
          .where(and(eq(owners.id, id), eq(owners.authEpoch, token.authEpoch!), eq(owners.recoveryRequired, false), eq(installation.status, "ready"))).limit(1);
        if (!owner) return { ...token, revoked: true, sub: undefined, email: undefined };
        token.email = owner.email;
        return token;
      },
      async session({ session, token }) {
        if (token.revoked || !token.sub) return { ...session, user: undefined };
        return {
          ...session,
          expires: new Date(Math.min(new Date(session.expires).getTime(), (token.authenticatedUntil ?? 0) * 1000)).toISOString(),
          user: { id: token.sub, email: token.email },
        };
      },
      async redirect({ url }) { return safeRedirect(url); },
    },
    // Never print NextAuth metadata: request bodies and credential values can occur there.
    logger: {
      error() { console.error("Fever authentication request failed."); },
      warn() { console.warn("Fever authentication configuration needs attention."); },
      debug() {},
    },
    debug: false,
  };
}
