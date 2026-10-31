import { createAuthClient, type SolidAuthClient } from "better-auth/solid";
import { passkeyClient } from "@better-auth/passkey/client";

type AuthClientOptions = { baseURL: string; plugins: [ReturnType<typeof passkeyClient>] };

export const authClient: SolidAuthClient<AuthClientOptions> = createAuthClient({
  baseURL: `${window.location.origin}/api/auth`,
  plugins: [passkeyClient()],
});
