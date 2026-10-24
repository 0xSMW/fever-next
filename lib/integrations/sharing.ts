import "server-only";
import type { ItemDTO, SharingService } from "@/lib/contracts";
import type { OwnerContext } from "@/lib/auth";
import { getItem, getPreferences } from "@/lib/domain";
import { safeFetch } from "@/lib/ingest";
import { HttpError } from "./http";

export function expandSharingTemplate(service: SharingService, item: Pick<ItemDTO, "title" | "url" | "excerpt">): { url: string; background: boolean } {
  if (service.enabled === false) throw new HttpError(service.reason || "This sharing service is disabled.", 409, "SERVICE_DISABLED");
  const background = service.url.startsWith("#");
  const template = background ? service.url.slice(1) : service.url;
  const values: Record<string, string> = { t: item.title, u: item.url, e: item.excerpt };
  const expanded = template.replace(/%([tue])/g, (_, key: string) => encodeURIComponent(values[key]));
  let url: URL;
  try { url = new URL(expanded); } catch { throw new HttpError("The sharing service URL is invalid."); }
  if (!(background ? ["http:", "https:"] : ["http:", "https:", "mailto:"]).includes(url.protocol) || url.username || url.password || expanded.length > 16384) throw new HttpError("The sharing service URL is not permitted.");
  return { url: url.href, background };
}
export async function shareItem(owner: OwnerContext, serviceId: number, itemId: number) {
  const prefs = await getPreferences(owner);
  const service = prefs.services.find(service => service.id === serviceId);
  if (!service) throw new HttpError("The sharing service no longer exists.", 404, "SERVICE_NOT_FOUND");
  const expanded = expandSharingTemplate(service, await getItem(owner, itemId));
  if (!expanded.background) return { url: expanded.url, background: false };
  const response = await safeFetch(expanded.url, { purpose: "discovery", privateOrigins: [], maxBytes: 65_536, maxCompressedBytes: 65_536, deadlineMs: 10_000 });
  if (response.status < 200 || response.status >= 300) throw new HttpError("The sharing service did not accept the request.", 502, "SHARING_FAILED");
  return { background: true, delivered: true };
}
