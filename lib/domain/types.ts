import type { getDb } from "../db/client";

/** Auth supplies this context. Every service still scopes all rows to its ID. */
export type { OwnerContext } from "../auth/owner";
export type DomainDb = Pick<ReturnType<typeof getDb>, "select" | "insert" | "update" | "delete" | "execute">;
export type MutationOrigin = "ui" | "api";
export interface ItemState { id: number; readAt: number; isSaved: boolean; }
export interface ScopeReadInput { scope: "all" | "group" | "feed" | "sparks"; id?: number; before: number; }
