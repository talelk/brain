import { createAuthClient, type SolidAuthClient } from "better-auth/solid";
import { passkeyClient } from "@better-auth/passkey/client";

type AuthClientOptions = { baseURL: string; plugins: [ReturnType<typeof passkeyClient>] };

/** better-auth in the browser: the session lives in an HttpOnly cookie, nothing is stored by the page. */
export const authClient: SolidAuthClient<AuthClientOptions> = createAuthClient({
  baseURL: `${window.location.origin}/api/auth`,
  plugins: [passkeyClient()],
});
