# Roadmap

This document expands the roadmap preview in `README.md`.

ClawClip is still moving quickly. The list below is directional, not promised, and priorities may shift as Paperclip and OpenClaw evolve.

We value community involvement and want to make sure contributor energy goes toward areas where it can land.

We may accept contributions in the areas below. Bugs, docs, polish, and tightly scoped improvements are still the easiest contributions to merge.

## Milestones

### ✅ Adapter communication

Creates a solid foundation for ClawClip to work with Paperclip and OpenClaw. Allows for basic communication between the two.

### ✅ Improve Agent Security

Use of short-lived persistence tokens for each agent. These tokens should be used for authentication and authorization, and should be rotated frequently.

### ✅ Skill synchronization

Fast hash check synchronizes Paperclip skill directories with OpenClaw skills, to ensure that agents have the latest skills available.

### ✅ OpenClaw Agent Creation

Handling agent creation and management from Paperclip to OpenClaw.

### ✅ Agent Instructions Management

Direct synchronization of agent instructions from Paperclip to OpenClaw, to ensure that agents have the latest instructions available.

### ✅ Workspace Isolation

Each company has its own workspace in OpenClaw to prevent conflicts between companies. Each agent also has its own workspace, to prevent conflicts between agents.

### ✅ Prompt Alignment

Align the prompt usage to other Paperclip prompts, like the default used with Claude.

### ✅ Prompt Caching

Rewrite the prompts to send from Paperclip to OpenClaw to have a static and a dynamic part, allowing the use of `prompt-caching` feature from different models.

### ✅ Token Management

Created a direct writing of the Paperclip token in the OpenClaw agent instructions, to avoid issues when a model has to handle difficult texts as a token.

### ⚪ Pairing Improvements

Simplify the adapter pairing process, to have only one pairing request for OpenClaw instance.

### ⚪ Configuration Improvements

Reduce to the minimum the configuration for ClawClip adapter, to have only the most relevant parameters.

