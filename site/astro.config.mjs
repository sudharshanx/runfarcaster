// SPDX-License-Identifier: MIT
// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

// GitHub Pages: set SITE_URL=https://<user>.github.io and BASE_PATH=/snapchain-tutorial/ (the repo name).
// Local preview: leave both unset (served at /).
const site = process.env.SITE_URL ?? "https://example.github.io";
const base = process.env.BASE_PATH ?? "/";
// AUTHOR: set REPO_URL (or edit the default) to the public GitHub repo once it exists.
const repo = process.env.REPO_URL ?? "https://github.com/OWNER/snapchain-tutorial";

export default defineConfig({
  site,
  base,
  trailingSlash: "always",
  integrations: [
    starlight({
      title: "Snapchain in three commands",
      description:
        "Run your own Farcaster Snapchain read node and web client in three commands. Measured cost and time, protocol concepts, honest test status.",
      social: [{ icon: "github", label: "Source on GitHub", href: repo }],
      editLink: { baseUrl: `${repo}/edit/main/site/` },
      customCss: ["./src/styles/custom.css"],
      // Wrap long command lines on phones instead of scrolling sideways (copy still copies the original).
      expressiveCode: { defaultProps: { wrap: true, preserveIndent: true } },
      lastUpdated: false,
      sidebar: [
        { label: "Home", link: "/" },
        { label: "Before you start", slug: "before-you-start" },
        { label: "Quickstart", slug: "quickstart" },
        { label: "Tutorial", slug: "tutorial" },
        { label: "Your first cast", slug: "first-cast" },
        { label: "Troubleshooting", slug: "troubleshooting" },
        { label: "Receipts", slug: "receipts" },
        { label: "Docs issues we found", slug: "docs-issues" },
        { label: "Reference", slug: "reference" },
        { label: "Glossary", slug: "glossary" },
        { label: "Do it with your AI assistant", slug: "ai-assistant" },
        { label: "How AI was used", slug: "how-ai-was-used" },
      ],
    }),
  ],
});
