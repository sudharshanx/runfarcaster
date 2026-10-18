// SPDX-License-Identifier: MIT
// One Markdown file per docs page (/<slug>.md), built from the MDX source with the components
// flattened to plain text and code (see toMarkdown in ../llms.ts). The "Copy page" menu links here.
import type { APIRoute, GetStaticPaths } from "astro";
import { pages, pageMarkdown } from "../llms";

export const getStaticPaths = (async () => (await pages()).map((e) => ({ params: { slug: e.id }, props: { md: pageMarkdown(e) } }))) satisfies GetStaticPaths;

export const GET: APIRoute = ({ props }) =>
  new Response(props.md + "\n", { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
