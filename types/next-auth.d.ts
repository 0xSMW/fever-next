import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface User {
    authEpoch: number;
  }
  interface Session {
    user?: DefaultSession["user"] & { id: string };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    authEpoch?: number;
    authenticatedUntil?: number;
    installationUrl?: string;
    revoked?: boolean;
  }
}
