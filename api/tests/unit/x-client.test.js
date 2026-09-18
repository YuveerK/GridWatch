import { describe, expect, it, vi } from "vitest";
import { createXClient } from "../../src/modules/ingestion/x.client.js";

describe("X client", () => {
  it("requests paginated posts with since_id", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [], meta: {} }) });
    const client = createXClient({ token: "token", fetchImpl });
    await client.listPosts({ userId: "123", sinceId: "999" });
    const url = fetchImpl.mock.calls[0][0];
    expect(url.searchParams.get("since_id")).toBe("999");
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe("Bearer token");
  });
});
