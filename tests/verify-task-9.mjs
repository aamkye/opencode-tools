import { spawnSync } from "node:child_process"

// Full assembled-migration acceptance gate; intentionally no fixture/suite filter.
for (const [command, args] of [
  ["npm", ["run", "typecheck"]],
  ["npm", ["test"]],
  ["npm", ["run", "build"]],
  ["npm", ["run", "test:v2-smoke"]],
  ["git", ["diff", "--check"]],
]) {
  const result = spawnSync(command, args, { stdio: "inherit" })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
