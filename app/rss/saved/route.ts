import { savedRss } from "@/lib/integrations/rss";
import { endpoint } from "@/lib/integrations/http";
export const dynamic = "force-dynamic";
export const GET = () => endpoint(savedRss);
