import { ACCESS_APP_NAME, extractJson } from "./helpers.mjs";
import { runCommand } from "./process.mjs";

const CF_API = "https://api.cloudflare.com/client/v4";

export function createCloudflare({ wranglerBin, wranglerArgs, workerDir }) {
  return {
    wranglerBin,
    wranglerArgs,
    workerDir,

    async wrangler(args, options = {}) {
      return runCommand(this.wranglerBin, [...this.wranglerArgs, ...args], {
        cwd: this.workerDir,
        env: options.env,
        inherit: options.inherit,
        input: options.input,
        allowFail: options.allowFail,
      });
    },

    async wranglerJson(args, options = {}) {
      const result = await this.wrangler(args, options);
      return extractJson(`${result.stdout}\n${result.stderr}`);
    },
  };
}

export async function cfApi(token, path, options = {}) {
  const { method = "GET", body, query } = options;
  const url = new URL(path.startsWith("http") ? path : `${CF_API}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const payload = await response.json().catch(() => null);
  if (!payload?.success) {
    const message =
      payload?.errors?.map((item) => item.message).join("; ") ||
      `${response.status} ${response.statusText}`;
    const error = new Error(message);
    error.status = response.status;
    error.errors = payload?.errors ?? [];
    error.payload = payload;
    throw error;
  }
  return payload;
}

export function isNotFound(error) {
  if (error.status === 404) {
    return true;
  }
  return (error.errors ?? []).some((item) => item.code === 7003);
}

export async function cfList(token, path) {
  const items = [];
  let page = 1;
  for (;;) {
    const payload = await cfApi(token, path, {
      query: { page, per_page: 50 },
    });
    const batch = Array.isArray(payload.result) ? payload.result : [];
    items.push(...batch);
    const total = payload.result_info?.total_count;
    if (batch.length < 50 || (total && items.length >= total)) {
      break;
    }
    page += 1;
  }
  return items;
}

export async function verifyToken(token) {
  const payload = await cfApi(token, "/user/tokens/verify");
  return payload.result;
}

export async function listAccounts(token) {
  return cfList(token, "/accounts");
}

export async function ensureD1(token, accountId, name) {
  const databases = await cfList(token, `/accounts/${accountId}/d1/database`);
  const existing = databases.find((item) => item.name === name);
  if (existing) {
    return {
      created: false,
      id: existing.uuid ?? existing.id,
      name: existing.name,
    };
  }
  const payload = await cfApi(token, `/accounts/${accountId}/d1/database`, {
    method: "POST",
    body: { name },
  });
  return { created: true, id: payload.result.uuid, name: payload.result.name };
}

export async function listR2Buckets(token, accountId) {
  const buckets = [];
  let cursor;
  for (;;) {
    const payload = await cfApi(token, `/accounts/${accountId}/r2/buckets`, {
      query: { per_page: 50, ...(cursor ? { cursor } : {}) },
    });
    const page = payload.result?.buckets ?? [];
    buckets.push(...page);
    const next = payload.result_info?.cursor;
    if (!payload.result_info?.is_truncated || !next) {
      break;
    }
    cursor = next;
  }
  return buckets;
}

export function isR2NotEnabled(error) {
  return (
    (error.errors ?? []).some((item) => item.code === 10042) ||
    /enable R2/i.test(error.message ?? "")
  );
}

export async function ensureR2(token, accountId, name) {
  const buckets = await listR2Buckets(token, accountId);
  const existing = buckets.find((item) => item.name === name);
  if (existing) {
    return { created: false, name };
  }
  await cfApi(token, `/accounts/${accountId}/r2/buckets`, {
    method: "POST",
    body: { name },
  });
  return { created: true, name };
}

export async function ensureWorkersSubdomain(token, accountId, fallback) {
  try {
    const payload = await cfApi(
      token,
      `/accounts/${accountId}/workers/subdomain`,
    );
    if (payload.result?.subdomain) {
      return payload.result.subdomain;
    }
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }

  const payload = await cfApi(
    token,
    `/accounts/${accountId}/workers/subdomain`,
    {
      method: "PUT",
      body: { subdomain: fallback },
    },
  );
  return payload.result.subdomain;
}

export async function listZones(token, accountId) {
  const items = [];
  let page = 1;
  for (;;) {
    const payload = await cfApi(token, "/zones", {
      query: { page, per_page: 50, "account.id": accountId },
    });
    const batch = Array.isArray(payload.result) ? payload.result : [];
    items.push(...batch);
    if (batch.length < 50) {
      break;
    }
    page += 1;
  }
  return items;
}

export async function attachCustomDomain(
  token,
  accountId,
  { hostname, service, zoneId },
) {
  const existing = await cfList(
    token,
    `/accounts/${accountId}/workers/domains`,
  );
  const found = existing.find((item) => item.hostname === hostname);
  if (found) {
    return found;
  }
  const payload = await cfApi(token, `/accounts/${accountId}/workers/domains`, {
    method: "PUT",
    body: { hostname, service, zone_id: zoneId },
  });
  return payload.result;
}

export async function getAccessOrganization(token, accountId) {
  try {
    const payload = await cfApi(
      token,
      `/accounts/${accountId}/access/organizations`,
    );
    return payload.result;
  } catch (error) {
    if (
      isNotFound(error) ||
      /not (been )?set up|does not exist/i.test(error.message)
    ) {
      return null;
    }
    throw error;
  }
}

export async function createAccessOrganization(
  token,
  accountId,
  { name, authDomain },
) {
  const payload = await cfApi(
    token,
    `/accounts/${accountId}/access/organizations`,
    {
      method: "POST",
      body: {
        name,
        auth_domain: authDomain,
        session_duration: "24h",
      },
    },
  );
  return payload.result;
}

export async function listAccessApps(token, accountId) {
  return cfList(token, `/accounts/${accountId}/access/apps`);
}

function destinationUri(app) {
  const destinations = app.destinations ?? [];
  const fromDest = destinations
    .map((item) => item.uri)
    .filter(Boolean)
    .join(" ");
  const domains = (app.self_hosted_domains ?? []).join(" ");
  return `${fromDest} ${app.domain ?? ""} ${domains}`;
}

export async function ensureAccessApp(
  token,
  accountId,
  { destination, includes },
) {
  const apps = await listAccessApps(token, accountId);
  const existing = apps.find(
    (app) =>
      app.name === ACCESS_APP_NAME ||
      destinationUri(app).includes(destination.replace(/\/auth\*$/, "/auth")),
  );

  const body = {
    name: ACCESS_APP_NAME,
    type: "self_hosted",
    session_duration: "24h",
    app_launcher_visible: false,
    auto_redirect_to_identity: false,
    destinations: [{ type: "public", uri: destination }],
    policies: [
      {
        name: "Allow MiyulabMD login",
        decision: "allow",
        precedence: 1,
        include: includes,
      },
    ],
  };

  if (existing) {
    try {
      const payload = await cfApi(
        token,
        `/accounts/${accountId}/access/apps/${existing.id}`,
        { method: "PUT", body },
      );
      return { created: false, app: payload.result };
    } catch {
      return { created: false, app: existing };
    }
  }

  try {
    const payload = await cfApi(token, `/accounts/${accountId}/access/apps`, {
      method: "POST",
      body,
    });
    return { created: true, app: payload.result };
  } catch {
    const payload = await cfApi(token, `/accounts/${accountId}/access/apps`, {
      method: "POST",
      body: {
        name: ACCESS_APP_NAME,
        type: "self_hosted",
        session_duration: "24h",
        app_launcher_visible: false,
        destinations: [{ type: "public", uri: destination }],
      },
    });
    try {
      await cfApi(
        token,
        `/accounts/${accountId}/access/apps/${payload.result.id}/policies`,
        {
          method: "POST",
          body: {
            name: "Allow MiyulabMD login",
            decision: "allow",
            include: includes,
          },
        },
      );
    } catch (policyError) {
      console.warn(
        `  Access ポリシーの追加に失敗しました: ${policyError.message}`,
      );
    }
    return { created: true, app: payload.result };
  }
}

export async function listIdentityProviders(token, accountId) {
  try {
    return await cfList(
      token,
      `/accounts/${accountId}/access/identity_providers`,
    );
  } catch {
    return [];
  }
}

export async function putWorkerSecret(
  cloudflare,
  { name, value, env, config },
) {
  const args = ["secret", "put", name];
  if (config) {
    args.push("-c", config);
  }
  await cloudflare.wrangler(args, {
    env,
    input: `${value}\n`,
  });
}
