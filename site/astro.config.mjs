// SPDX-License-Identifier: MIT
// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import { REPO, remarkRepoUrl, rehypeTableScroll, rehypeStepIds } from "./src/config.mjs";

// GitHub Pages: set SITE_URL=https://<user>.github.io and BASE_PATH=/runfarcaster/ (the repo name).
// Defaults below; CI sets them from the repository. The home page is src/pages/index.astro (custom
// landing); every other page is Starlight.
const site = process.env.SITE_URL ?? "https://sudharshanx.github.io";
const base = process.env.BASE_PATH ?? "/runfarcaster/";
// The repo URL lives in src/config.mjs (REPO_URL env). CI sets it from the GitHub repository.
const repo = REPO;
// Social preview (public/og.png, 1200x630), on every docs page and the landing page.
const OG_IMAGE = new URL(`${base.replace(/\/?$/, "/")}og.png`, site).href;
const OG_ALT = "RunFarcaster: Read and post on Farcaster from your own server. 01 Rent a server, 02 Start the node, 03 Open the app.";

export default defineConfig({
  site,
  base,
  trailingSlash: "always",
  redirects: {
    "/receipts/": `${base.replace(/\/$/, "")}/proof/`,
    "/troubleshooting/": `${base.replace(/\/$/, "")}/fix/`,
    "/tutorial/": `${base.replace(/\/$/, "")}/how-farcaster-works/`,
    "/hetzner/": `${base.replace(/\/$/, "")}/server-and-node/`,
    "/before-you-start/": `${base.replace(/\/$/, "")}/server-and-node/`,
  },
  markdown: { remarkPlugins: [remarkRepoUrl], rehypePlugins: [rehypeTableScroll, rehypeStepIds] },
  integrations: [
    starlight({
      title: "RunFarcaster",
      description:
        "RunFarcaster sets up a Farcaster node and app of your own, with no gatekeepers in between.",
      editLink: { baseUrl: `${repo}/edit/main/site/` },
      head: [
        { tag: "meta", attrs: { property: "og:image", content: OG_IMAGE } },
        { tag: "meta", attrs: { property: "og:image:width", content: "1200" } },
        { tag: "meta", attrs: { property: "og:image:height", content: "630" } },
        { tag: "meta", attrs: { property: "og:image:alt", content: OG_ALT } },
        { tag: "meta", attrs: { name: "twitter:image", content: OG_IMAGE } },
        { tag: "meta", attrs: { name: "twitter:image:alt", content: OG_ALT } },
      ],
      // Self-hosted fonts (no font CDN), the same as the landing page in src/pages/index.astro.
      customCss: ["@fontsource-variable/dm-sans", "@fontsource/ibm-plex-mono/400.css", "./src/styles/custom.css"],
      // Light only (white page, dark text). Starlight's dark default and theme picker are replaced.
      components: {
        ThemeProvider: "./src/components/LightThemeProvider.astro",
        ThemeSelect: "./src/components/NoThemeSelect.astro",
        SiteTitle: "./src/components/SiteTitle.astro",
        SocialIcons: "./src/components/HeaderLinks.astro",
        PageTitle: "./src/components/PageTitle.astro",
      },
      // Wrap long command lines on phones instead of scrolling sideways (copy still copies the original).
      expressiveCode: {
        themes: ["github-light"],
        defaultProps: { wrap: true, preserveIndent: true },
        styleOverrides: { borderRadius: "6px", borderColor: "#dfe2e7", frames: { shadowColor: "transparent" } },
      },
      lastUpdated: false,
      sidebar: [
        { label: "Full run: 3 commands", slug: "quickstart" },
        {
          label: "Go deeper",
          items: [
            { label: "How Farcaster works", slug: "how-farcaster-works" },
            { label: "Server and node", slug: "server-and-node" },
            { label: "Post with an app key", slug: "first-cast" },
            { label: "Set up with AI", slug: "ai-assistant" },
          ],
        },
        {
          label: "Build on your node",
          items: [
            { label: "Overview and first request", slug: "build-on-your-node" },
            { label: "Recipes", slug: "recipes" },
            { label: "Reuse the client code", slug: "client-code" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "Scripts and settings", slug: "reference" },
            { label: "Glossary", slug: "glossary" },
            { label: "Fix a problem", slug: "fix" },
            { label: "Proof: what we ran", slug: "proof" },
            { label: "Docs issues", slug: "docs-issues" },
            { label: "How AI was used", slug: "how-ai-was-used" },
          ],
        },
      ],
    }),
  ],
});
