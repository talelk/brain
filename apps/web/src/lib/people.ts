/** A first name for a new account, from the email address: `jane.doe@acme.com` is `Jane Doe`. The person can write their own. */
export function nameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "";
  return local.split(/[._+-]+/u).filter((part) => part !== "" && !/^\d+$/u.test(part)).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ").slice(0, 100);
}

/** A password for a new account that nobody has to invent: 20 characters, shown to the person who adds the account so they can pass it on. */
export function generatedPassword(): string {
  const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(crypto.getRandomValues(new Uint32Array(20)), (n) => alphabet[n % alphabet.length]).join("");
}
