# Contributing Guide

Thanks for wanting to contribute!

We really appreciate both small fixes and thoughtful larger changes.

## Two Paths to Get Your Pull Request Accepted

### Path 1: Small, Focused Changes (Fastest way to get merged)

- Pick **one** clear thing to fix/improve
- Touch the **smallest possible number of files**
- Make sure the change is very targeted and easy to review
- All tests pass and CI is green
- Use the [PR template](.github/PULL_REQUEST_TEMPLATE.md)

These almost always get merged quickly when they're clean.

### Path 2: Bigger or Impactful Changes

- **First** discuss the problem you're trying to solve and share your rough ideas/approach in an issue or via maintainer contact.
- Once there's rough agreement, build it
- In your PR include:
  - Before / After screenshots (or short video if UI/behavior change)
  - Clear description of what & why
  - Proof it works (manual testing notes)
  - All tests passing and CI green
  - [PR template](.github/PULL_REQUEST_TEMPLATE.md) fully filled out

PRs that follow this path are **much** more likely to be accepted, even when they're large.

## PR Requirements (all PRs)

### Use the PR Template

Every pull request **must** follow the PR template at [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md). If you create a PR via the GitHub API or other tooling that bypasses the template, copy its contents into your PR description manually. The template includes required sections: Thinking Path, What Changed, Verification, Risks, Model Used, and a Checklist.

### Model Used (Required)

Every PR must include a **Model Used** section specifying which AI model produced or assisted with the change. Include the provider, exact model ID/version, context window size, and any relevant capability details (e.g., reasoning mode, tool use). If no AI was used, write "None — human-authored". This applies to all contributors — human and AI alike.

### Tests Must Pass

All tests must pass before a PR can be merged. Run them locally first and verify CI is green after pushing.


## Feature Contributions

Uncoordinated feature PRs against the core product may be closed, even when the implementation is thoughtful and high quality. That is about roadmap ownership, product coherence, and long-term maintenance commitment, not a judgment about the effort.

- Discuss major feature work with the maintainers before opening the PR.

Bugs, docs improvements, and small targeted improvements are still the easiest path to getting merged, and we really do appreciate them.

## General Rules (both paths)

- Write clear commit messages
- Keep PR title + description meaningful
- One PR = one logical change (unless it's a small related group)
- Run tests locally first
- Be kind in discussions 😄

## Writing a Good PR message

Your PR description must follow the [PR template](.github/PULL_REQUEST_TEMPLATE.md). All sections are required. The "thinking path" at the top explains from the top of the project down to what you fixed. E.g.:

### Thinking Path Example:

> - The `clawclip` adapter allows Paperclip to connect to OpenClaw gateways
> - Some gateways require strict device authentication with a stable private key
> - But our bridge was generating an ephemeral key on every run, causing repeated pairing requests
> - This pull request adds a `devicePrivateKeyPem` configuration field to the adapter
> - The benefit is that users can provide a stable key, making device approval persistent across runs

### Thinking Path Example 2:

> - Paperclip orchestrates ai-agents for zero-human companies
> - Agents communicate with OpenClaw via this bridge
> - But when an agent is woken up, it needs to know the Paperclip API key to call back
> - Previously, the bridge assumed the agent would read this from a local file, which was hard to set up in cloud environments
> - This PR modifies the bridge to inject the API key (per-run JWT) directly into the wake message text
> - The benefit is that agents can now authenticate automatically without any local filesystem dependencies

Then have the rest of your normal PR message after the Thinking Path.

This should include details about what you did, why you did it, why it matters & the benefits, how we can verify it works, and any risks.

Please include screenshots if possible if you have a visible change. (use something like the [agent-browser skill](https://github.com/vercel-labs/agent-browser/blob/main/skills/agent-browser/SKILL.md) or similar to take screenshots). Ideally, you include before and after screenshots.

Questions? Just reach out — we're happy to help.

Happy hacking!
