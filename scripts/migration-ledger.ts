interface RepositoryMigrationIdentity {
  fileName: string;
  version: string;
  migrationName: string;
}

interface SupabaseMigrationIdentity {
  version: string;
  name: string | null;
}

interface FindSupabaseLedgerMatchesOptions {
  repositoryFiles: readonly string[];
  appliedFiles: ReadonlySet<string>;
  supabaseMigrations: readonly SupabaseMigrationIdentity[];
}

interface AssertMigrationOrderOptions {
  repositoryFiles: readonly string[];
  appliedFiles: ReadonlySet<string>;
}

export interface MigrationLedgerMatch {
  repositoryFileName: string;
  supabaseVersion: string;
}

function parseRepositoryMigration(
  fileName: string,
): RepositoryMigrationIdentity | undefined {
  const match = /^\d{14}_(.+)\.sql$/.exec(fileName);
  const version = match?.[0].slice(0, 14);
  const migrationName = match?.[1];

  if (
    version === undefined ||
    migrationName === undefined ||
    migrationName.trim().length === 0 ||
    migrationName.trim() !== migrationName
  ) {
    return undefined;
  }

  return { fileName, version, migrationName };
}

export function findSupabaseLedgerMatches({
  repositoryFiles,
  appliedFiles,
  supabaseMigrations,
}: FindSupabaseLedgerMatchesOptions): MigrationLedgerMatch[] {
  const migrations = repositoryFiles.flatMap((fileName) => {
    const migration = parseRepositoryMigration(fileName);
    return migration === undefined ? [] : [migration];
  });
  const filesByMigrationName = new Map<string, string>();
  const supabaseByName = new Map<string, SupabaseMigrationIdentity>();
  const supabaseByVersion = new Map<string, SupabaseMigrationIdentity>();

  for (const migration of migrations) {
    const duplicate = filesByMigrationName.get(migration.migrationName);
    if (duplicate !== undefined) {
      throw new Error(
        `Duplicate repository migration name "${migration.migrationName}": ${duplicate}, ${migration.fileName}`,
      );
    }
    filesByMigrationName.set(migration.migrationName, migration.fileName);
  }

  for (const migration of supabaseMigrations) {
    supabaseByVersion.set(migration.version, migration);

    const name = migration.name?.trim();
    if (name === undefined || name.length === 0) {
      continue;
    }
    if (name !== migration.name) {
      throw new Error(
        `Supabase migration name has surrounding whitespace. Version ${migration.version}`,
      );
    }

    const duplicate = supabaseByName.get(name);
    if (duplicate !== undefined) {
      throw new Error(
        `Duplicate Supabase migration name "${name}". Versions ${duplicate.version}, ${migration.version}`,
      );
    }
    supabaseByName.set(name, migration);
  }

  return migrations
    .filter((migration) => {
      return !appliedFiles.has(migration.fileName);
    })
    .flatMap((migration) => {
      const namedMatch = supabaseByName.get(migration.migrationName);
      if (namedMatch !== undefined) {
        return [
          {
            repositoryFileName: migration.fileName,
            supabaseVersion: namedMatch.version,
          },
        ];
      }

      const versionMatch = supabaseByVersion.get(migration.version);
      if (
        versionMatch === undefined ||
        (versionMatch.name !== null && versionMatch.name.trim().length > 0)
      ) {
        return [];
      }

      return [
        {
          repositoryFileName: migration.fileName,
          supabaseVersion: versionMatch.version,
        },
      ];
    });
}

export function assertMigrationOrder({
  repositoryFiles,
  appliedFiles,
}: AssertMigrationOrderOptions): void {
  let firstPending: string | undefined;

  for (const file of repositoryFiles) {
    if (!appliedFiles.has(file)) {
      firstPending ??= file;
      continue;
    }
    if (firstPending !== undefined) {
      throw new Error(
        `Migration ledger gap. ${firstPending} is pending before applied ${file}`,
      );
    }
  }
}
