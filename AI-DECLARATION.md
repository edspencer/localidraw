---
version: "0.1.2"
level: copilot
processes:
  design: pair
  implementation: copilot
  testing: copilot
  documentation: copilot
  review: pair
  deployment: assist
---

This format is based on [AI-DECLARATION.md](https://ai-declaration.md/en/0.1.2).

## Notes

Localidraw was built by me, working with Claude Code agents.

- **Design is mine.** What it's for and how it behaves are decisions I made: canvases as plain files in a folder,
  projects as folders, saving as you draw, drawing side by side with a coding agent, and a UI that looks as if it
  shipped with Excalidraw.
- **Implementation and tests are largely generated under review.** I prompt, an agent writes the code and the tests,
  and I read the diff. Commits an agent helped write carry a `Co-Authored-By: Claude` trailer.
- **The promises are tested.** The merge, the path rules and the server's refusal to overwrite a newer file have
  their own tests.
