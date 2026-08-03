import { describe, expect, it } from "vitest";
import { assertLocalDatabaseReset } from "../scripts/database-reset-safety.js";

describe("assertLocalDatabaseReset", () => {
  it.each(["localhost", "127.0.0.1", "[::1]"])(
    "allows the local host %s",
    (hostname) => {
      expect(() =>
        assertLocalDatabaseReset(
          `postgresql://postgres:postgres@${hostname}:5432/postgres`,
        ),
      ).not.toThrow();
    },
  );

  it("rejects a hosted database without exposing credentials", () => {
    const databaseUrl =
      "postgresql://postgres:secret@db.example.supabase.co:5432/postgres";
    const reset = () => assertLocalDatabaseReset(databaseUrl);

    expect(reset).toThrow(
      "Refusing to reset a non-local database host. Received db.example.supabase.co",
    );

    try {
      reset();
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      if (error instanceof Error) {
        expect(error.message).not.toContain("secret");
      }
    }
  });
});
