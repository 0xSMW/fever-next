import { useSyncExternalStore } from "react";

const subscribe = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

/**
 * False on the server and during hydration, true afterwards. A component that
 * first mounts after hydration sees true on its first render, so browser-only
 * markup (portals, window reads) needs no extra effect pass.
 */
export function useIsClient(): boolean {
  return useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot);
}
