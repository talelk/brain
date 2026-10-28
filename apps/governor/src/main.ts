import { createGovernor } from "./container";

const governor = await createGovernor();
await governor.listen();
