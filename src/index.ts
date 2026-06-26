import { createServerAdapter, type, models, agentConfigurationDoc } from "./server/adapter.js";

export const label = "ClawClip";

export const manifest = {
  id: "clawclip",
  name: label,
  description: "Third-party Paperclip adapter for OpenClaw Gateway",
  adapters: [
    {
      type,
      label,
      models,
    },
  ],
};

export { createServerAdapter, type, models, agentConfigurationDoc } from "./server/adapter.js";
export default createServerAdapter();
