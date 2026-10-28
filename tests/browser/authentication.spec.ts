import { test, expect } from "./fixtures";
import { totpCode } from "../support/totp";

test.use({ requireTwoFactor: true });

test("native setup, enrollment and second-factor sign-in (E093/E094 partial)",async({page,governor},info)=>{
  const errors:string[]=[];page.on("pageerror",(error)=>errors.push(error.message));
  await page.goto(governor.url);
  await expect(page.getByRole("heading",{name:"Set up Keyrus Brain"})).toBeVisible();
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill("Browser organization");
  await page.getByLabel(/^Email/).fill("browser@example.test");
  await page.getByLabel(/^Password/).fill("browser-password-1234");
  await page.getByRole("button",{name:"Create organization",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Today",exact:true})).toBeVisible();
  await expect(page.getByRole("region",{name:"Create your first workspace"})).toHaveCount(0);
  await page.getByLabel(/^Confirm password/).fill("browser-password-1234");
  await page.getByRole("button",{name:"Begin setup",exact:true}).click();
  const link=page.getByRole("link",{name:"Keyrus Brain to your authenticator",exact:true});
  await expect(link).toBeVisible();const secret=new URL((await link.getAttribute("href"))!).searchParams.get("secret")!;
  await page.getByLabel(/^Authenticator code/).fill(totpCode(secret,Date.now()));
  await page.getByRole("button",{name:"Verify authenticator",exact:true}).click();
  await expect(page.getByRole("region",{name:"Authenticator setup"})).toHaveCount(0);
  await expect(page.getByRole("region",{name:"Create your first workspace"})).toBeVisible();
  const cookies=await page.context().cookies();
  const identity=await governor.app.brain.resolveActor(new Headers({cookie:cookies.map((c)=>`${c.name}=${c.value}`).join("; ")}));
  expect(identity.humanSession?.factorDigest).toBeTruthy();
  expect(await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}))).not.toContain(secret);
  // The account menu sits in the header bar below the shell's desktop
  // breakpoint and in the sidebar above it; one test id covers both.
  const account = page.getByTestId("account-menu").getByRole("button");
  await account.click();
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("heading",{name:"Sign in to Keyrus Brain",exact:true})).toBeVisible();
  await page.getByLabel(/^Email/).fill("browser@example.test");
  await page.getByLabel(/^Password/).fill("browser-password-1234");
  await page.getByRole("button",{name:"Sign in",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Verify your sign-in",exact:true})).toBeVisible();
  await page.getByLabel(/^Authenticator code/).fill(totpCode(secret,Date.now()));
  await page.getByRole("button",{name:"Verify and continue",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Today",exact:true})).toBeVisible();
  expect(errors).toEqual([]);
  await info.attach("native-authenticated-screen",{body:await page.screenshot({fullPage:true}),contentType:"image/png"});
});
