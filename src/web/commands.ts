export async function postJson<T>(path: string, body: object): Promise<{ status: number; data: T }> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() as T };
}
