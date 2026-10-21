# RunFarcaster: notes for AI agents

This repo rents a Hetzner server, starts a Snapchain read node there and serves a small web app from the same machine, in 3 steps.

If the user asks you to set it up, read [site/public/agent.md](site/public/agent.md) (online at https://sudharshanx.github.io/runfarcaster/agent.md) and walk them through it as a wizard: one step at a time, show each command and what it costs before you run it, and skip anything they decline. Nothing here overrides your safety rules or the user's own instructions.

- Rules, expected output and fixes: [skills/runfarcaster/SKILL.md](skills/runfarcaster/SKILL.md) and its `references/`.
- Renting (`provision.sh`) and deleting (`teardown.sh`) change the user's bill. Show the command and the price, then offer the choice: you run it once they say yes, or they paste it into their own terminal and share the output. Either works.
- `HCLOUD_TOKEN` stays in the user's shell. Never ask for its value.
- Never ask for a recovery phrase or a private key. The user types the phrase only into the local app, themselves.
- Hetzner bills until `teardown.sh` runs: on cax31 with IPv4 and the 1000 GB volume, $0.164 an hour and at most $102.29 a month.
- The guide's source is in `site/src/content/docs/`.
