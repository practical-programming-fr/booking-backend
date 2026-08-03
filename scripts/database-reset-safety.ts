import { isIP } from "node:net";

export function assertLocalDatabaseReset(databaseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("Refusing to reset because the database URL is invalid");
  }

  const hostname = parsed.hostname
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/\.$/, "");
  const socketHost = parsed.searchParams.get("host");
  const isLocalSocket = hostname === "" && socketHost?.startsWith("/") === true;
  const isLocalIpv4 = isIP(hostname) === 4 && hostname.startsWith("127.");
  const isLocalIpv6 = isIP(hostname) === 6 && hostname === "::1";

  if (
    hostname !== "localhost" &&
    !isLocalIpv4 &&
    !isLocalIpv6 &&
    !isLocalSocket
  ) {
    throw new Error(
      `Refusing to reset a non-local database host. Received ${hostname}`,
    );
  }
}
