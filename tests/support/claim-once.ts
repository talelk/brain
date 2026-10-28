// Child process for the multi-process claim contention test: claims once
// over HTTP from the single running Governor using a runner session token
// issued by the parent process.
export {};
const [url, token, requestId] = process.argv.slice(2) as [string, string, string];
const res = await fetch(`${url}/runner/v1/claim`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ requestId }),
});
if (res.status === 204) {
  process.stdout.write(JSON.stringify({ status: 204, attemptId: null }));
} else {
  const body = (await res.json().catch(() => null)) as { attemptId?: string } | null;
  process.stdout.write(JSON.stringify({ status: res.status, attemptId: body?.attemptId ?? null }));
}
