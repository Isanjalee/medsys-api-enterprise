const { spawnSync } = require("node:child_process");
const path = require("node:path");

const command = process.argv[2];
const extraArgs = process.argv.slice(3);

if (!command) {
  console.error("Usage: node scripts/flyway-docker.cjs <migrate|validate|info> [extra flyway args]");
  process.exit(1);
}

const repoPath = process.cwd();
const flywayImage = process.env.FLYWAY_IMAGE || "redgate/flyway:10-alpine";
const flywayUrl =
  process.env.FLYWAY_URL || "jdbc:postgresql://host.docker.internal:5432/medsys";
const flywayUser = process.env.FLYWAY_USER || "medsys";
const flywayPassword = process.env.FLYWAY_PASSWORD || "medsys";
const flywayLocations =
  process.env.FLYWAY_LOCATIONS || "filesystem:/flyway/project/infra/flyway/sql";

const dockerArgs = [
  "run",
  "--rm",
  "-v",
  `${repoPath}:/flyway/project`,
  "-w",
  "/flyway/project",
  flywayImage,
  `-url=${flywayUrl}`,
  `-user=${flywayUser}`,
  `-password=${flywayPassword}`,
  `-locations=${flywayLocations}`,
  command,
  ...extraArgs
];

const result = spawnSync("docker", dockerArgs, {
  stdio: "inherit",
  shell: false
});

if (result.error) {
  if (result.error.code === "ENOENT") {
    console.error("Docker is not installed or not available on PATH.");
  } else {
    console.error(result.error.message);
  }
  process.exit(1);
}

process.exit(result.status ?? 1);
