# Web consumer configuration references

Copy `vite.config.ts` to `apps/web/vite.config.ts` and `index.css` to `apps/web/src/index.css` during T33. These are build/config references; this directory is not an installable application. No package lock, dependency installation or Vite/NewUI build is claimed by the pack's contract checks.

`../config/web-build.json` declares the reviewed NewUI source package candidates and image layout. T01/T33 resolve actual published or reproducibly built artifacts, pin tooling and peers, install with a frozen lockfile and run the production CSS/browser/bundle checks. Observed source versions are not evidence of npm availability or compatibility.

The dev server binds loopback and proxies only human application/auth routes to the local Governor. Configure the local browser origin in the authorized auth setup; this proxy does not disable origin/CSRF checks or make a development origin trusted in production. Runners and MCP clients connect directly to Governor. Production serves the built web bundle from the Governor image under the same origin, with API/auth/runner/MCP paths excluded from SPA fallback.

The CSS paths are for the target `apps/web` layout. Include Brain compositions in scanning, keep NewUI's semantic CSS entry once, and validate package source/CSS behavior in the actual installed layout. Do not copy NewUI's optional Frappe proxy, resource client or development tools into Brain production.
