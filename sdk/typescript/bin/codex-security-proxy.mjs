#!/usr/bin/env node
async function launch() {
  const [{ realpathSync }, { dirname, join }, { pathToFileURL }] =
    await Promise.all([
      import("node:fs"),
      import("node:path"),
      import("node:url"),
    ]);
  const entrypoint = process.argv[1];
  if (entrypoint === undefined) {
    throw new Error("Cannot resolve CLI entrypoint.");
  }
  const server = join(
    dirname(realpathSync(entrypoint)),
    "..",
    "dist",
    "proxy",
    "server.js",
  );
  const { main } = await import(pathToFileURL(server).href);
  return await main();
}

void launch().then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  () => {
    process.stderr.write("codex-security-proxy: Failed to start proxy.\n");
    process.exitCode = 2;
  },
);
