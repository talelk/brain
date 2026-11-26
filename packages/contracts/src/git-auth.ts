/** The `authorization` header every git request of Brain carries. A credential written `user:password` is sent as it is; a token alone goes under the user name hosts expect for one. */
export const gitAuthorization = (credential: string): string => `Basic ${Buffer.from(credential.includes(":") ? credential : `x-access-token:${credential}`).toString("base64")}`;
