import { defineConfig } from "vitepress";

export default defineConfig({
  title: "OpenClaw Config",
  description: "DX-first documentation for the OpenClaw VS Code extension",
  base: "/openclaw-config-vscode/",
  srcDir: ".",
  lastUpdated: true,
  themeConfig: {
    nav: [
      { text: "Guide", link: "/getting-started" },
      { text: "Commands", link: "/commands" },
      { text: "Configuration", link: "/configuration" },
      { text: "Operations", link: "/runbook" },
      { text: "Release", link: "/release-roadmap" },
    ],
    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "Getting Started", link: "/getting-started" },
          { text: "Commands", link: "/commands" },
          { text: "Configuration", link: "/configuration" },
          { text: "Workflows", link: "/workflows" },
          { text: "Diagnostics and Quick Fixes", link: "/diagnostics-and-quick-fixes" },
          { text: "Troubleshooting", link: "/troubleshooting" },
        ],
      },
      {
        text: "Engineering",
        items: [
          { text: "Architecture", link: "/architecture" },
          { text: "Contributing", link: "/contributing" },
          { text: "Operations Runbook", link: "/runbook" },
        ],
      },
      {
        text: "Release",
        items: [
          { text: "Release Roadmap", link: "/release-roadmap" },
          { text: "Feature Complete Gate", link: "/release-feature-complete-checklist" },
          { text: "Release Checklist", link: "/release-checklist" },
        ],
      },
    ],
    search: {
      provider: "local",
    },
    footer: {
      message: "MIT Licensed",
    },
  },
});
