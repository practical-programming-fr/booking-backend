interface RepositoryMigrationIdentity {
  fileName: string;
  migrationName: string;
}

interface FindSupabaseLedgerMatchesOptions {
  repositoryFiles: readonly string[];
  appliedFiles: ReadonlySet<string>;
  supabaseMigrationNames: ReadonlySet<string>;
}

function parseRepositoryMigration(
  fileName: string,
): RepositoryMigrationIdentity | undefined {
  const match = /^\d{14}_(.+)\.sql$/.exec(fileName);
  const migrationName = match?.[1];

  if (
    migrationName === undefined ||
    migrationName.trim().length === 0 ||
    migrationName.trim() !== migrationName
  ) {
    return undefined;
  }

  return { fileName, migrationName };
}

export function findSupabaseLedgerMatches({
  repositoryFiles,
  appliedFiles,
  supabaseMigrationNames,
}: FindSupabaseLedgerMatchesOptions): string[] {
  const migrations = repositoryFiles.flatMap((fileName) => {
    const migration = parseRepositoryMigration(fileName);
    return migration === undefined ? [] : [migration];
  });
  const filesByMigrationName = new Map<string, string>();

  for (const migration of migrations) {
    const duplicate = filesByMigrationName.get(migration.migrationName);
    if (duplicate !== undefined) {
      throw new Error(
        `Duplicate repository migration name "${migration.migrationName}": ${duplicate}, ${migration.fileName}`,
      );
    }
    filesByMigrationName.set(migration.migrationName, migration.fileName);
  }

  return migrations
    .filter((migration) => {
      if (appliedFiles.has(migration.fileName)) {
        return false;
      }

      return supabaseMigrationNames.has(migration.migrationName);
    })
    .map((migration) => migration.fileName);
}
