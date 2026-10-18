// SPDX-License-Identifier: MIT
// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import { REPO, remarkRepoUrl, rehypeTableScroll } from "./src/config.mjs";

// GitHub Pages: set SITE_URL=https://<user>.github.io and BASE_PATH=/runfarcaster/ (the repo name).
// Defaults below; CI sets them from the repository. The home page is src/pages/index.astro (custom
// landing); every other page is Starlight.
const site = process.env.SITE_URL ?? "https://sudharshanx.github.io";
const base = process.env.BASE_PATH ?? "/runfarcaster/";
// The repo URL lives in src/config.mjs (REPO_URL env). CI sets it from the GitHub repository.
const repo = REPO;

export default defineConfig({
  site,
  base,
  trailingSlash: "always",
  redirects: { "/receipts/": `${base.replace(/\/$/, "")}/proof/` },
  markdown: { remarkPlugins: [remarkRepoUrl], rehypePlugins: [rehypeTableScroll] },
  integrations: [
    starlight({
      title: "RunFarcaster",
      description:
        "Run your own Farcaster node in 3 simple steps: a Snapchain read node and a web app on Hetzner. Measured time and cost, what we tested, and how it works.",
      editLink: { baseUrl: `${repo}/edit/main/site/` },
      // Self-hosted fonts (no font CDN), the same as the landing page in src/pages/index.astro.
      customCss: ["@fontsource-variable/dm-sans", "@fontsource/ibm-plex-mono/400.css", "./src/styles/custom.css"],
      // Light only (white page, dark text). Starlight's dark default and theme picker are replaced.
      components: {
        ThemeProvider: "./src/components/LightThemeProvider.astro",
        ThemeSelect: "./src/components/NoThemeSelect.astro",
        SiteTitle: "./src/components/SiteTitle.astro",
        SocialIcons: "./src/components/HeaderLinks.astro",
      },
      // Wrap long command lines on phones instead of scrolling sideways (copy still copies the original).
      expressiveCode: {
        themes: ["github-light"],
        defaultProps: { wrap: true, preserveIndent: true },
        styleOverrides: { borderRadius: "6px", borderColor: "#dfe2e7", frames: { shadowColor: "transparent" } },
      },
      lastUpdated: false,
      sidebar: [
        { label: "Home", link: "/" },
        { label: "Before you start", slug: "before-you-start" },
        { label: "Quickstart", slug: "quickstart" },
        { label: "Tutorial", slug: "tutorial" },
        { label: "Do it on Hetzner", slug: "hetzner" },
        { label: "Proof: what we ran", slug: "proof" },
        { label: "Your first cast", slug: "first-cast" },
        { label: "Troubleshooting", slug: "troubleshooting" },
        { label: "Docs issues we found", slug: "docs-issues" },
        { label: "Reference", slug: "reference" },
        { label: "Glossary", slug: "glossary" },
        { label: "Do it with your AI assistant", slug: "ai-assistant" },
        { label: "How AI was used", slug: "how-ai-was-used" },
      ],
    }),
  ],
});
