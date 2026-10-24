import { xmlText } from "@/lib/integrations/http";
export type FeverValue = string | number | false | null | FeverValue[] | { [key: string]: FeverValue };
/** Preserve legacy plural containers while emitting well-formed XML. */
export function feverXml(data: Record<string, FeverValue>): string {
  function element(name: string, value: FeverValue): string {
    if (Array.isArray(value)) return `<${name}>${value.map(row => element(name.replace(/s$/, ""), row)).join("")}</${name}>`;
    if (value && typeof value === "object") return `<${name}>${Object.entries(value).map(([key, child]) => element(key, child)).join("")}</${name}>`;
    return `<${name}>${xmlText(value === false ? "" : value)}</${name}>`;
  }
  return `<?xml version="1.0" encoding="utf-8"?><response>${Object.entries(data).map(([key, value]) => element(key, value)).join("")}</response>`;
}
