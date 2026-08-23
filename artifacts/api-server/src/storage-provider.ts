const DEFAULT_TIMEOUT_MS = 12_000;

export type ConnectionTestResult = {
  ok: boolean;
  status: "connected" | "not_configured" | "unauthorized" | "not_found" | "unreachable" | "error";
  message: string;
  endpoint: string | null;
  item: string | null;
};

function getConfig() {
  return {
    endpoint: process.env.IAS3_ENDPOINT?.replace(/\/+$/, ""),
    item: process.env.IAS3_ITEM_IDENTIFIER,
    accessKey: process.env.IAS3_ACCESS_KEY,
    secretKey: process.env.IAS3_SECRET_KEY,
  };
}

export async function testIas3Connection(): Promise<ConnectionTestResult> {
  const { endpoint, item, accessKey, secretKey } = getConfig();

  if (!endpoint || !item || !accessKey || !secretKey) {
    return {
      ok: false,
      status: "not_configured",
      message: "Add the IAS3 endpoint, item identifier, access key, and secret key to test the connection.",
      endpoint: endpoint ?? null,
      item: item ?? null,
    };
  }

  let url: URL;
  try {
    url = new URL(`${endpoint}/${encodeURIComponent(item)}`);
  } catch {
    return {
      ok: false,
      status: "error",
      message: "The IAS3 endpoint is not a valid URL.",
      endpoint,
      item,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "HEAD",
      headers: {
        authorization: `LOW ${accessKey}:${secretKey}`,
        accept: "application/json",
      },
      redirect: "follow",
      signal: controller.signal,
    });

    if (response.ok) {
      return {
        ok: true,
        status: "connected",
        message: "IAS3 responded successfully and the archive item is reachable.",
        endpoint,
        item,
      };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        status: "unauthorized",
        message: "IAS3 rejected the credentials or their permissions.",
        endpoint,
        item,
      };
    }

    if (response.status === 404) {
      return {
        ok: false,
        status: "not_found",
        message: "The IAS3 endpoint responded, but the configured item identifier was not found.",
        endpoint,
        item,
      };
    }

    return {
      ok: false,
      status: "error",
      message: `IAS3 responded with HTTP ${response.status}.`,
      endpoint,
      item,
    };
  } catch (error) {
    const message = error instanceof DOMException && error.name === "AbortError"
      ? "IAS3 did not respond before the connection test timed out."
      : "The IAS3 endpoint could not be reached.";

    return {
      ok: false,
      status: "unreachable",
      message,
      endpoint,
      item,
    };
  } finally {
    clearTimeout(timeout);
  }
}