import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "uos.org-learning",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Org Learning",
  description: "Captures, indexes, and surfaces organizational learnings across the UOS Paperclip ecosystem.",
  author: "turmo.dev",
  categories: ["automation", "ui"],
  capabilities: [
    "events.subscribe",
    "plugin.state.read",
    "plugin.state.write"
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui"
  },
  ui: {
    slots: [
      {
        type: "dashboardWidget",
        id: "learning-widget",
        displayName: "Org Learning Feed",
        exportName: "LearningWidget"
      },
      {
        type: "dashboardWidget",
        id: "learning-health-widget",
        displayName: "Learning Health",
        exportName: "LearningHealthWidget"
      }
    ]
  }
};

export default manifest;
