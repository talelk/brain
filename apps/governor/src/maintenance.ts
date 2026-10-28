import { pathToFileURL } from "node:url";
import { createBackup, restoreBackup, verifyBackup } from "./modules/operations/index";

// Trusted host maintenance belongs to the Governor executable. The remote Brain
// CLI never opens control/workspace databases or accepts arbitrary server paths.
export async function runMaintenance(args: string[]): Promise<number> {
  const [operation, source, destination, ...extra] = args;
  if (!source || extra.length || !["backup", "verify", "restore"].includes(operation ?? "") || (operation === "verify" ? !!destination : !destination)) {
    process.stderr.write("usage: maintenance backup <stopped-data-dir> <empty-backup-dir> | verify <backup-dir> | restore <backup-dir> <empty-data-dir>\n");
    return 2;
  }
  try {
    if (operation === "backup") {
      process.stdout.write(`${JSON.stringify(await createBackup(source, destination!), null, 2)}\n`);
    } else if (operation === "verify") {
      process.stdout.write(`${JSON.stringify(verifyBackup(source), null, 2)}\n`);
    } else {
      restoreBackup(source, destination!);
      process.stdout.write(`${JSON.stringify({ restored: true, suspended: true })}\n`);
    }
    return 0;
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : "maintenance failed"}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runMaintenance(process.argv.slice(2));
}
