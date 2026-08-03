const LOCAL_DATABASE_HOSTS = new Set([
  "127.0.0.1",
  "::1",
  "[::1]",
  "localhost",
]);

export function assertLocalDatabaseReset(databaseUrl: string): void {
  const hostname = new URL(databaseUrl).hostname;
  if (!LOCAL_DATABASE_HOSTS.has(hostname)) {
    throw new Error(
      `Refusing to reset a non-local database host. Received ${hostname}`,
    );
  }
}
