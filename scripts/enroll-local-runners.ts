import { closeSync, existsSync, lstatSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { runCli } from "../apps/cli/src/client";

const runDir = process.env["BRAIN_RUN_DIR"] ?? "/tmp/brain-run";
const profile = process.env["BRAIN_PROFILE"] ?? "agents";
const env = { ...process.env, BRAIN_GOVERNOR_URL: process.env["BRAIN_GOVERNOR_URL"] ?? `http://127.0.0.1:${process.env["BRAIN_PORT"] ?? "3100"}` };
async function cli(argv: string[]) {
  let output = "", errors = "";
  const code = await runCli([...argv,"--json"],{env,stdout:(s)=>{output+=s;},stderr:(s)=>{errors+=s;},prompt:async()=>{throw new Error("Run brain login first, or provide BRAIN_ADMIN_EMAIL, a private BRAIN_ADMIN_PASSWORD_FILE and BRAIN_ADMIN_TOTP when required");}});
  if (code) throw new Error(errors || `CLI refused ${argv.join(" ")}: ${output}`);
  return JSON.parse(output);
}
if (env["BRAIN_ADMIN_PASSWORD_FILE"]) {
  const file = env["BRAIN_ADMIN_PASSWORD_FILE"];
  const stat = lstatSync(file);
  if (!stat.isFile() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error("BRAIN_ADMIN_PASSWORD_FILE must be an owned regular file with mode 0600");
  env["BRAIN_EMAIL"] = env["BRAIN_ADMIN_EMAIL"] ?? "";
  env["BRAIN_PASSWORD"] = readFileSync(file,"utf8").trim();
  if (env["BRAIN_ADMIN_TOTP"]) env["BRAIN_TOTP"] = env["BRAIN_ADMIN_TOTP"];
  await cli(["login"]);
  delete env["BRAIN_PASSWORD"]; delete env["BRAIN_TOTP"];
}
for (const group of [process.env["BRAIN_RUNNER_GROUP"] ?? (profile === "fixture" ? "fixture-tools" : "agents"), profile === "fixture" ? "fixture-evaluators" : "evaluators"]) {
  const count = group.endsWith("evaluators") ? 1 : Number(process.env["BRAIN_RUNNERS"] ?? "1");
  for (let i=1;i<=count;i++) {
    const name=`runner-${group}-${i}`, pidfile=join(runDir,`${name}.pid`), logfile=join(runDir,`${name}.log`);
    if (existsSync(pidfile)) {
      const pid=Number(readFileSync(pidfile,"utf8").trim());
      try { process.kill(pid,0); console.log(`${name}: already running (${pid})`); continue; }
      catch { /* only this script's dead pidfile is replaced */ }
    }
    const token=(await cli(["runner","token","create","--group",group])).token;
    const offset=existsSync(logfile)?statSync(logfile).size:0;
    const fd=openSync(logfile,"a",0o600);
    const runnerEnv={...process.env,BRAIN_GOVERNOR_URL:env.BRAIN_GOVERNOR_URL,BRAIN_RUNNER_ID:name,BRAIN_RUNNER_STATE_DIR:join(runDir,`${name}-state`),BRAIN_RUNNER_ENROLL_TOKEN:String(token),
      BRAIN_RUNNER_ENGINE:group.endsWith("evaluators")?"fixture":process.env["BRAIN_RUNNER_ENGINE"]??(profile==="fixture"?"fixture":"pi"),
      BRAIN_RUNNER_CAPABILITIES:process.env["BRAIN_RUNNER_CAPABILITIES"]??"os:linux,tool:bash,tool:python3,isolation:ephemeral-container"};
    for (const key of ["BRAIN_AUTH_SECRET","BRAIN_TOKEN","BRAIN_PASSWORD","BRAIN_ADMIN_EMAIL","BRAIN_ADMIN_PASSWORD_FILE","BRAIN_ADMIN_TOTP","BRAIN_TOTP"]) delete runnerEnv[key];
    const child=spawn(process.execPath,["--import","tsx","apps/runner/src/main.ts"],{env:runnerEnv,detached:true,stdio:["ignore",fd,fd]});
    closeSync(fd); child.unref(); writeFileSync(pidfile,String(child.pid),{mode:0o600});
    let connected=false;
    for (let n=0;n<60;n++) {
      if (readFileSync(logfile,"utf8").slice(offset).includes("connected")) {connected=true;break;}
      if (child.exitCode !== null) break;
      await new Promise((resolve)=>setTimeout(resolve,250));
    }
    if (!connected) throw new Error(`${name} did not connect; see ${logfile}`);
    console.log(`${name}: connected; log ${logfile}`);
  }
}
