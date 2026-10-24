import { changeCredentials, requireMutation } from "@/lib/auth";
import { executeDomainCommand, isDomainCommandAction } from "@/lib/domain/commands";
import { endpoint, HttpError, integer, json, readJson, record } from "@/lib/integrations/http";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const POST = (request: Request) => endpoint(async () => {
  const owner = await requireMutation(request), body = await readJson(request);
  if (typeof body.action !== "string") throw new HttpError("A command is required.");
  const payload = record(body.payload);
  if (isDomainCommandAction(body.action)) {
    if (body.action === "feed.create" || body.action === "feed.authenticate") {
      const { changeSubscription } = await import("@/lib/integrations/subscriptions");
      return json({ ok: true, ...await changeSubscription(owner, body.action, payload) });
    }
    return json({ ok: true, ...await executeDomainCommand(owner, body.action, payload) });
  }
  switch (body.action) {
    case "account.update": return json(await changeCredentials(owner, payload));
    case "maintenance.preview": {
      const { previewMaintenance } = await import("@/lib/maintenance");
      return json({ ok: true, ...await previewMaintenance(owner, payload) });
    }
    case "maintenance.execute": {
      const { executeMaintenance } = await import("@/lib/maintenance");
      return json({ ok: true, ...await executeMaintenance(owner, payload) });
    }
    case "favicons.clear": {
      const { clearFavicons } = await import("@/lib/maintenance");
      const result = await clearFavicons(owner);
      const { refreshAfterChange } = await import("@/lib/integrations/refresh");
      const refresh = await refreshAfterChange(owner, { scope: "all", force: true, faviconOnly: true });
      return json({ ok: true, ...result, ...refresh });
    }
    case "refresh.cancel": {
      const id = integer(payload.id, "id", 1);
      const { cancelRefresh } = await import("@/lib/jobs");
      return json({ ok: true, job: await cancelRefresh(owner, id) });
    }
    case "refresh.start": {
      if (!["all", "group", "feed"].includes(String(payload.scope))) throw new HttpError("Choose a refresh scope.");
      if (payload.force !== undefined && typeof payload.force !== "boolean") throw new HttpError("force must be a boolean.");
      if (payload.faviconOnly !== undefined && typeof payload.faviconOnly !== "boolean") throw new HttpError("faviconOnly must be a boolean.");
      const scope = payload.scope as "all" | "group" | "feed";
      const { enqueueRefresh } = await import("@/lib/jobs");
      const job = await enqueueRefresh(owner, { scope, ...(scope === "all" ? {} : { id: integer(payload.id, "id", 1) }), force: payload.force as boolean | undefined, faviconOnly: payload.faviconOnly as boolean | undefined });
      return json({ ok: true, job });
    }
    default: throw new HttpError("This command is not supported.", 400, "UNKNOWN_COMMAND");
  }
});
