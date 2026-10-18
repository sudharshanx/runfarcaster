import type { APIRoute } from "astro";
import { pages, toMarkdown } from "../llms";

export const GET: APIRoute = async () => {
  const parts = (await pages()).map((e) => `# ${e.data.title}\n\n${e.data.description ? `> ${e.data.description}\n\n` : ""}${toMarkdown(e.body ?? "")}`);
  return new Response(parts.join("\n\n---\n\n") + "\n", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
